/** Auto-select providers by environment, chain, and operation capability. */

import { create, providers, has, supportsCapability, supportsChain } from "./registry.ts";
import {
  AuthError,
  BlockedError,
  HTTPError,
  PlanRestrictedError,
  RateLimitError,
  TransportError,
  UnknownProviderError,
  UnsupportedChainError,
  UnsupportedOperationError,
} from "./errors.ts";
import { inferChain } from "./input.ts";
import { OPERATION_CAPABILITIES } from "./provider.ts";
import type { Provider, ProviderCapability } from "./provider.ts";
import { normalizeChain } from "./types.ts";
import type { ChainKey } from "./types.ts";

const ENV_MAP: Record<string, string[]> = {
  etherscan: ["ETHERSCAN_API_KEY"],
  blockscout: [],
  blockchair: ["BLOCKCHAIR_API_KEY"],
  mempool: [],
  blockstream: [],
  solscan: ["SOLSCAN_API_KEY"],
  helius: ["HELIUS_API_KEY"],
  ton: [],
  tronscan: ["TRONSCAN_API_KEY"],
  aptos: [],
  blockberry: ["BLOCKBERRY_API_KEY"],
  koios: [],
  turbo: [],
  ario: [],
  arweave: [],
  dcrdata: [],
  horizon: [],
  whatsonchain: ["WHATSONCHAIN_API_KEY"],
  blockbook: [],
  haskoin: [],
  ecash: [],
  xrpscan: [],
};

const OPTIONAL_CREDENTIAL_PROVIDERS: readonly string[] = ["blockchair", "whatsonchain"];

/* An indexer the user runs answers only when named, so no automatic read or hint reaches it. */
const EXPLICIT_ONLY: readonly string[] = ["nuthatch"];

/** Provider-specific default chains */
export const PROVIDER_DEFAULT_CHAIN: Partial<Record<string, ChainKey>> = {
  mempool: "bitcoin",
  blockstream: "bitcoin",
  solscan: "solana",
  helius: "solana",
  ton: "ton",
  tronscan: "tron",
  aptos: "aptos",
  blockberry: "sui",
  koios: "cardano",
  turbo: "arweave",
  ario: "arweave",
  arweave: "arweave",
  dcrdata: "decred",
  horizon: "stellar",
  whatsonchain: "bitcoinsv",
  blockbook: "bitcoingold",
  haskoin: "bitcoincash",
  ecash: "ecash",
  xrpscan: "xrpl",
};

function hasConfiguredCredentials(envKeys: readonly string[]): boolean {
  return envKeys.length > 0 && envKeys.every((key) => process.env[key]);
}

/* A plan that refused a read refuses it again on the next call, so automatic selection remembers
   the refusal for an hour and asks another provider first. The entry holds the credentials it was
   earned with: another key may carry another plan. */
const PLAN_LIMIT_TTL_MS = 60 * 60 * 1000;

interface PlanLimit {
  readonly credentials: string;
  readonly until: number;
}

let planLimits: Map<string, PlanLimit> | undefined;

function planLimitKey(name: string, chain: ChainKey, capability?: ProviderCapability): string {
  return `${name}\0${chain}\0${capability ?? ""}`;
}

function credentialsOf(name: string): string {
  return (ENV_MAP[name] ?? []).map((key) => process.env[key] ?? "").join("\0");
}

function rememberPlanLimit(
  name: string,
  chain: ChainKey,
  capability: ProviderCapability,
  credentials: string,
): void {
  planLimits ??= new Map();
  planLimits.set(planLimitKey(name, chain, capability), {
    credentials,
    until: Date.now() + PLAN_LIMIT_TTL_MS,
  });
}

function isPlanLimited(name: string, chain?: ChainKey, capability?: ProviderCapability): boolean {
  if (chain === undefined || planLimits === undefined) return false;
  const key = planLimitKey(name, chain, capability);
  const limit = planLimits.get(key);
  if (limit === undefined) return false;
  if (limit.until > Date.now() && limit.credentials === credentialsOf(name)) return true;
  planLimits.delete(key);
  return false;
}

/** Forget every plan refusal automatic selection has seen in this process. */
export function forgetPlanLimits(): void {
  planLimits = undefined;
}

function appendRankedProvider(
  ranked: readonly string[],
  name: string,
  chain?: ChainKey,
  capability?: ProviderCapability,
): readonly string[] {
  if (EXPLICIT_ONLY.includes(name)) return ranked;
  const fitsChain = chain === undefined || supportsChain(name, chain);
  const fitsCapability = capability === undefined || supportsCapability(name, capability, chain);
  return has(name) && fitsChain && fitsCapability && !ranked.includes(name)
    ? [...ranked, name]
    : ranked;
}

function configuredProviderNames(): string[] {
  return Object.entries(ENV_MAP)
    .filter(([, envKeys]) => hasConfiguredCredentials(envKeys))
    .map(([name]) => name);
}

/* A provider that merely tolerates a missing key throttles hard without one, so it ranks last. */
function keylessProviderNames(mode: "primary" | "fallback"): string[] {
  const keyless = Object.entries(ENV_MAP)
    .filter(([, envKeys]) => envKeys.length === 0)
    .map(([name]) => name);
  return mode === "fallback" ? [...keyless, ...OPTIONAL_CREDENTIAL_PROVIDERS] : keyless;
}

function appendCandidates(
  ranked: readonly string[],
  candidates: readonly string[],
  chain?: ChainKey,
  capability?: ProviderCapability,
): readonly string[] {
  let result = ranked;
  for (const name of candidates) result = appendRankedProvider(result, name, chain, capability);
  return result;
}

function rankProviders(
  chain?: ChainKey,
  mode: "primary" | "fallback" = "primary",
  capability?: ProviderCapability,
): string[] {
  let ranked = appendCandidates([], configuredProviderNames(), chain, capability);
  ranked = appendCandidates(ranked, keylessProviderNames(mode), chain, capability);
  if (mode === "primary" && chain !== undefined) {
    ranked = appendCandidates(ranked, providers(), chain, capability);
  }
  // A refused provider stays last rather than leaving: when nobody else serves the read, its
  // refusal is still the most useful answer.
  const limited = ranked.filter((name) => isPlanLimited(name, chain, capability));
  if (limited.length === 0) return [...ranked];
  if (mode === "fallback") return ranked.filter((name) => !limited.includes(name));
  return [...ranked.filter((name) => !limited.includes(name)), ...limited];
}

/**
 * Choose a registered provider for the current environment.
 *
 * An explicit preference wins, even for a chain it cannot serve, so misconfiguration stays visible.
 * Without one, candidates that declare support for the requested chain and optional capability are
 * considered in order: configured credentials first, then keyless providers, then any matching
 * registry entry, and finally Blockscout when no provider matches the chain.
 *
 * @throws {UnknownProviderError} When an explicit preference is not registered.
 *
 * @param {string} preferred - The `preferred` value.
 * @param {ChainKey} chain - The `chain` value.
 * @param {ProviderCapability} capability - Operation required from an automatic selection.
 * @returns {string} The resulting value.
 */
export function resolveProvider(
  preferred?: string,
  chain?: ChainKey,
  capability?: ProviderCapability,
): string {
  if (preferred !== undefined) {
    if (!has(preferred)) throw new UnknownProviderError(preferred, providers());
    return preferred;
  }

  const selected = rankProviders(chain, "primary", capability)[0];
  if (selected !== undefined) return selected;

  // If no backend serves the operation, preserve chain-aware selection so its typed limitation
  // stays more useful than an unrelated provider's chain error.
  if (capability !== undefined) {
    const chainMatch = rankProviders(chain)[0];
    if (chainMatch !== undefined) return chainMatch;
  }

  return has("blockscout") ? "blockscout" : (providers()[0] ?? "blockscout");
}

/** Provider and effective chain selected for one read. */
export interface ProviderContext {
  readonly chain: ChainKey;
  readonly name: string;
  readonly provider: Provider;
}

/* The registry knows who serves the read, so a refusal names them instead of leaving the caller to
   try providers one by one, and says so when nobody does. A chain refusal from a read that named no
   capability can only name who serves the chain. Only a refusal from the provider that ran, about
   the chain it ran on, gets the hint; an operation the registry cannot map gets none, unless it
   names the capability the read was selected by, as `txHistoryTags` does for tag filters. */
function suggestProviders(
  /* oxlint-disable-next-line typescript/prefer-readonly-parameter-types */
  error: UnsupportedChainError | UnsupportedOperationError,
  name: string,
  chain: ChainKey,
  capability: ProviderCapability | undefined,
): void {
  if (error.provider !== name) return;
  if (error instanceof UnsupportedChainError && error.chain !== chain) return;
  let needed = capability;
  if (error instanceof UnsupportedOperationError) {
    const operation = error.operation;
    if (Object.hasOwn(OPERATION_CAPABILITIES, operation))
      needed = OPERATION_CAPABILITIES[operation as keyof typeof OPERATION_CAPABILITIES];
    else if (operation !== capability) return;
  }
  const others = rankProviders(chain, "primary", needed).filter((other) => other !== name);
  error.message += hint(others, chain, needed !== undefined);
}

function hint(others: readonly string[], chain: ChainKey, knowsRead: boolean): string {
  if (!knowsRead) {
    if (others.length === 0) return `; no provider serves ${chain}`;
    return `; ${others.join(", ")} ${others.length === 1 ? "serves" : "serve"} ${chain}`;
  }
  if (others.length === 0) return `; no provider serves this read on ${chain}`;
  return `; try ${others.join(", ")}`;
}

function preservesPrimaryError(error: unknown): boolean {
  return (
    error instanceof AuthError ||
    error instanceof UnsupportedChainError ||
    error instanceof UnsupportedOperationError
  );
}

/* Failures another backend may not share: limits, a bot wall, no response, or a server error. A
   caller's abort is a decision, not an outage, so it never moves the read. */
function isTransientFailure(error: unknown): boolean {
  return (
    error instanceof RateLimitError ||
    error instanceof BlockedError ||
    error instanceof PlanRestrictedError ||
    (error instanceof TransportError && error.code !== "AbortError") ||
    (error instanceof HTTPError && error.statusCode >= 500)
  );
}

async function runFallback<T>(
  execute: (name: string) => Promise<T>,
  fallbackName: string,
  primaryError: unknown,
): Promise<T> {
  try {
    return await execute(fallbackName);
  } catch (fallbackError) {
    if (preservesPrimaryError(fallbackError)) throw primaryError;
    if (
      fallbackError instanceof Error &&
      fallbackError !== primaryError &&
      fallbackError.cause === undefined
    ) {
      fallbackError.cause = primaryError;
    }
    throw fallbackError;
  }
}

function startingChain(
  preferred: string | undefined,
  chain: ChainKey | undefined,
  input: string | readonly string[] | undefined,
): ChainKey | undefined {
  return (
    chain ??
    inferChain(input, preferred) ??
    (preferred === undefined ? normalizeChain() : undefined)
  );
}

/**
 * Run one read with provider selection and one automatic retry on another provider after a rate
 * or plan limit, no response at all, or a 5xx. When the retry fails too, its error carries the
 * first provider's failure as `cause`.
 *
 * A plan limit on a read that names its capability also sticks for an hour: later automatic reads
 * of that operation on the same chain try that provider last, until its credentials change. An
 * explicit provider is always asked.
 *
 * An explicit chain wins. Without one, an address whose format fits one chain selects that chain,
 * even over an explicit provider's default. Only when the address fits no single chain does
 * selection start on Ethereum, or on the explicit provider's default chain. The callback must be safe to run twice.
 *
 * A signal reaches every request of the created provider. Once it aborts, the read stays with the
 * provider it reached, whatever that provider threw.
 *
 * @param {string | undefined} preferred - The `preferred` value.
 * @param {ChainKey | undefined} chain - The `chain` value.
 * @param {(context: Readonly<ProviderContext>) => Promise<T>} run - The `run` value.
 * @param {ProviderCapability} capability - Operation required from an automatic selection.
 * @param {string | readonly string[]} input - Address or addresses the read is about.
 * @param {AbortSignal} signal - Cancels the read and its requests.
 * @returns {Promise<T>} The resulting value.
 */
export async function withProvider<T>(
  preferred: string | undefined,
  chain: ChainKey | undefined,
  /* oxlint-disable-next-line typescript/prefer-readonly-parameter-types */
  run: (context: ProviderContext) => Promise<T>,
  capability?: ProviderCapability,
  input?: string | readonly string[],
  signal?: AbortSignal,
): Promise<T> {
  const requestedChain = startingChain(preferred, chain, input);
  const primaryName = resolveProvider(preferred, requestedChain, capability);
  const effectiveChain = requestedChain ?? normalizeChain(PROVIDER_DEFAULT_CHAIN[primaryName]);
  const fallbackName = rankProviders(effectiveChain, "fallback", capability).find(
    (name) => name !== primaryName,
  );
  const execute = async (name: string) => {
    const provider = await create(name, { signal });
    // The constructor has just read the key, so a refusal from this read belongs to that key.
    const credentials = credentialsOf(name);
    try {
      return await run({ chain: effectiveChain, name, provider });
    } catch (error) {
      // Without a capability the refusal names no operation, and remembering it would bench the
      // provider for reads its plan does cover.
      if (
        preferred === undefined &&
        capability !== undefined &&
        error instanceof PlanRestrictedError
      ) {
        rememberPlanLimit(name, effectiveChain, capability, credentials);
      }
      if (error instanceof UnsupportedChainError || error instanceof UnsupportedOperationError) {
        suggestProviders(error, name, effectiveChain, capability);
      }
      throw error;
    }
  };

  try {
    return await execute(primaryName);
  } catch (error) {
    if (
      preferred !== undefined ||
      fallbackName === undefined ||
      signal?.aborted === true ||
      !isTransientFailure(error)
    ) {
      throw error;
    }

    return runFallback(execute, fallbackName, error);
  }
}
