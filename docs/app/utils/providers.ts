import snapshot from "../data/explorers.json";

/** One capability flag of `ProviderCapabilities`, as the registry lists them. */
export type Capability =
  | "balances"
  | "txHistory"
  | "txDetail"
  | "utxos"
  | "pubkeys"
  | "contractInfo"
  | "tokenBalances"
  | "tokenTransfers"
  | "gasData"
  | "blockInfo";

export const CAPABILITIES: readonly Capability[] = [
  "balances",
  "txHistory",
  "txDetail",
  "utxos",
  "pubkeys",
  "contractInfo",
  "tokenBalances",
  "tokenTransfers",
  "gasData",
  "blockInfo",
];

/** Short labels for the capability columns. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  balances: "balance",
  txHistory: "history",
  txDetail: "tx detail",
  utxos: "utxos",
  pubkeys: "pubkey",
  contractInfo: "contract",
  tokenBalances: "tokens",
  tokenTransfers: "transfers",
  gasData: "gas",
  blockInfo: "block",
};

/** Three letters per operation, for the cells a roster row lights; the tooltip names the whole one. */
export const CAPABILITY_SHORT: Record<Capability, string> = {
  balances: "bal",
  txHistory: "his",
  txDetail: "tx",
  utxos: "utx",
  pubkeys: "key",
  contractInfo: "con",
  tokenBalances: "tok",
  tokenTransfers: "trf",
  gasData: "gas",
  blockInfo: "blk",
};

/** The `Provider` method behind each flag; an optional one is absent when its flag is false. */
export const CAPABILITY_METHODS: Record<Capability, string> = {
  balances: "getBalance",
  txHistory: "getTxHistory",
  txDetail: "getTxDetail",
  utxos: "getUtxos",
  pubkeys: "getPubkey",
  contractInfo: "getContractInfo",
  tokenBalances: "getTokenBalances",
  tokenTransfers: "getTokenTransfers",
  gasData: "getGasData",
  blockInfo: "getBlockInfo",
};

/** What `scripts/snapshot.mjs` copies out of `builtins` and `@agntn/chains`. */
export interface ProviderSnapshot {
  readonly key: string;
  readonly chains: readonly string[];
  readonly capabilities: readonly Capability[];
  readonly defaultURL: string | null;
  readonly defaultChain: string;
}

export interface ChainSnapshot {
  readonly key: string;
  readonly name: string;
  readonly symbol: string;
  readonly type: string;
  readonly explorer: string | null;
  readonly providers: readonly string[];
}

/** Presentation per provider: icon, blurb and the auth facts that `resolveProvider()` reads from the environment. */
interface ProviderPresentation {
  readonly label: string;
  readonly icon: string;
  /** Environment variables `src/core/resolve.ts` checks for this provider, in order. */
  readonly envVars: readonly string[];
  /** Whether a missing key still lets the provider serve as a fallback (`OPTIONAL_CREDENTIAL_PROVIDERS`). */
  readonly optionalKey?: boolean;
  readonly blurb: string;
}

const PRESENTATION: Record<string, ProviderPresentation> = {
  etherscan: {
    label: "Etherscan",
    icon: "i-lucide-file-code",
    envVars: ["ETHERSCAN_API_KEY"],
    blurb: "The v2 API with one key for ten EVM chains. Every operation, five requests a second on the free tier.",
  },
  blockscout: {
    label: "Blockscout",
    icon: "i-lucide-globe",
    envVars: [],
    blurb: "Keyless and complete. The backstop when nothing else serves a chain, and the first stop when you have no keys at all.",
  },
  blockchair: {
    label: "Blockchair",
    icon: "i-lucide-database",
    envVars: ["BLOCKCHAIR_API_KEY"],
    optionalKey: true,
    blurb: "One dashboard API for Bitcoin, Bitcoin Cash, Litecoin, Dogecoin, Ethereum, eCash and Zcash. Works without a key, ranks higher with one.",
  },
  mempool: {
    label: "Mempool",
    icon: "i-lucide-layers",
    envVars: [],
    blurb: "mempool.space and its Litecoin and Pepecoin siblings. Fees in sat/vB, unspent outputs, OP_RETURN decoded, the mempool delta kept apart.",
  },
  blockstream: {
    label: "Blockstream",
    icon: "i-lucide-box",
    envVars: [],
    blurb: "Bitcoin through Esplora. An independent second backend for the same chain, so a Mempool outage isn't your outage.",
  },
  solscan: {
    label: "Solscan",
    icon: "i-lucide-zap",
    envVars: ["SOLSCAN_API_KEY"],
    blurb: "Solana balances, history, details and blocks through the Pro API. Needs a key.",
  },
  helius: {
    label: "Helius",
    icon: "i-lucide-server",
    envVars: ["HELIUS_API_KEY"],
    blurb: "Enhanced transactions and DAS token holdings on Solana. No balance endpoint, and it says so instead of faking one.",
  },
  ton: {
    label: "TONAPI",
    icon: "i-lucide-radio-tower",
    envVars: [],
    blurb: "Balances and history on TON, Jetton transfers included, failed ones omitted. Keyless.",
  },
  tronscan: {
    label: "TRONSCAN",
    icon: "i-lucide-network",
    envVars: ["TRONSCAN_API_KEY"],
    blurb: "TRON balances, history, details and blocks. Needs a key.",
  },
  aptos: {
    label: "Aptos Explorer",
    icon: "i-lucide-info",
    envVars: [],
    blurb: "Registered, honest and empty. Aptos Explorer has no documented account API, so every operation throws UnsupportedOperationError.",
  },
  blockberry: {
    label: "Blockberry",
    icon: "i-lucide-receipt",
    envVars: ["BLOCKBERRY_API_KEY"],
    blurb: "Sui balances and history. Needs a key; block lookup doesn't fit the contract of one block number in, one block out.",
  },
  koios: {
    label: "Koios",
    icon: "i-lucide-sun",
    envVars: [],
    blurb: "Cardano over PostgREST. Balances, history, details and native token holdings, keyless, a little slow on busy addresses.",
  },
  turbo: {
    label: "Turbo",
    icon: "i-lucide-rocket",
    envVars: [],
    blurb: "Arweave through the AR.IO gateway with the index that still remembers 2019. First pick for Arweave, no key.",
  },
  ario: {
    label: "ar.io",
    icon: "i-lucide-satellite-dish",
    envVars: [],
    blurb: "Arweave through ar-io.dev, the AR.IO team's own gateway. Catches the reads Turbo drops, and some old uploads Turbo never saw.",
  },
  arweave: {
    label: "arweave.net",
    icon: "i-lucide-archive",
    envVars: [],
    blurb: "Arweave through arweave.net. Fresh data items, a GraphQL index that forgot 2019, and the last of three gateways in line.",
  },
  dcrdata: {
    label: "dcrdata",
    icon: "i-lucide-chart-column",
    envVars: [],
    blurb: "Decred through the Insight API of explorer.dcrdata.org. Atoms, the mempool delta kept apart from the balance, no key.",
  },
  horizon: {
    label: "Horizon",
    icon: "i-lucide-sunrise",
    envVars: [],
    blurb: "Stellar through the SDF's public Horizon. Stroops, trustlines as tokens, payments as history, fee stats as gas, no key.",
  },
  whatsonchain: {
    label: "WhatsOnChain",
    icon: "i-lucide-eye",
    envVars: ["WHATSONCHAIN_API_KEY"],
    optionalKey: true,
    blurb: "Bitcoin SV through WhatsOnChain. Satoshis, unspent outputs, fees priced from the parent transactions. Three requests a second without a key.",
  },
  blockbook: {
    label: "Blockbook",
    icon: "i-lucide-book-marked",
    envVars: [],
    blurb: "Bitcoin Gold through the Blockbook API of btgexplorer.com. Satoshis, unspent outputs, fees and senders straight from each transaction, no key.",
  },
  haskoin: {
    label: "Haskoin",
    icon: "i-lucide-square-function",
    envVars: [],
    blurb: "Bitcoin Cash through Haskoin Store at api.haskoin.com. Satoshis, unspent outputs, fees and senders straight from each transaction, no key.",
  },
  xrpscan: {
    label: "XRPSCAN",
    icon: "i-lucide-waves",
    envVars: [],
    blurb: "The XRP Ledger from XRPSCAN, keyless. Drops, trust line tokens and ledgers as blocks, and a partial payment counts what actually arrived.",
  },
  ecash: {
    label: "eCash Explorer",
    icon: "i-lucide-receipt-text",
    envVars: [],
    blurb: "eCash history and blocks from explorer.e.cash, a whole page in one request and no key. The balance hides in HTML, so Blockchair keeps that one.",
  },
  nuthatch: {
    label: "Nuthatch",
    icon: "i-lucide-library",
    envVars: ["NUTHATCH_URL"],
    blurb: "Etherscan's API from a nuthatch indexer you run yourself, for the addresses it watches. Only ever chosen by name, and it refuses a range it cannot prove.",
  },
};

export interface ProviderInfo extends ProviderSnapshot, ProviderPresentation {
  readonly to: string;
  /** Human wording of the auth column. */
  readonly auth: string;
}

function authText(presentation: ProviderPresentation): string {
  if (presentation.envVars.length === 0) return "none";
  const vars = presentation.envVars.join(", ");
  return presentation.optionalKey ? `optional ${vars}` : vars;
}

export const PROVIDERS: readonly ProviderInfo[] = (
  snapshot.providers as readonly ProviderSnapshot[]
).map((provider) => {
  const presentation = PRESENTATION[provider.key];
  if (!presentation) {
    throw new Error(`docs: no presentation for provider "${provider.key}" in app/utils/providers.ts`);
  }
  return {
    ...provider,
    ...presentation,
    to: `/providers/${provider.key}`,
    auth: authText(presentation),
  };
});

/** Chain logos from the monochrome `token` set, so they take the muted and accent colours like every other icon; Pepecoin has none. */
const CHAIN_ICONS: Record<string, string> = {
  ethereum: "i-token-eth",
  base: "i-token-base",
  arbitrum: "i-token-arbitrum-one",
  optimism: "i-token-op",
  polygon: "i-token-pol",
  bsc: "i-token-bnb",
  avalanche: "i-token-avax",
  gnosis: "i-token-gno",
  linea: "i-token-linea",
  berachain: "i-token-berachain",
  scroll: "i-token-scroll",
  zksync: "i-token-zksync",
  bitcoin: "i-token-btc",
  bitcoincash: "i-token-bch",
  bitcoinsv: "i-token-bsv",
  bitcoingold: "i-token-btg",
  litecoin: "i-token-ltc",
  pepecoin: "i-lucide-leaf",
  ecash: "i-token-xec",
  dogecoin: "i-token-doge",
  zcash: "i-token-zec",
  solana: "i-token-sol",
  ton: "i-token-ton",
  tron: "i-token-trx",
  aptos: "i-token-apt",
  sui: "i-token-sui",
  cardano: "i-token-ada",
  arweave: "i-token-ar",
  decred: "i-token-dcr",
  stellar: "i-token-xlm",
  xrpl: "i-token-xrp",
};

export interface ChainInfo extends ChainSnapshot {
  readonly icon: string;
}

export const CHAINS: readonly ChainInfo[] = (snapshot.chains as readonly ChainSnapshot[]).map(
  (chain) => ({ ...chain, icon: CHAIN_ICONS[chain.key] ?? "i-lucide-layers" }),
);

/**
 * Decimals of each chain's native unit, as the providers pass them to `formatWei()`: 18 on EVM
 * chains, 8 on the Bitcoin family and Decred, 2 on eCash, 9 on Solana, TON and Sui, 6 on TRON
 * and Cardano, 8 on Aptos, 12 on Arweave, 7 on Stellar, 6 on the XRP Ledger. Used to show a fee the library returns in the smallest unit.
 */
const NATIVE_DECIMALS: Record<string, number> = {
  bitcoin: 8,
  bitcoincash: 8,
  bitcoinsv: 8,
  bitcoingold: 8,
  litecoin: 8,
  pepecoin: 8,
  ecash: 2,
  dogecoin: 8,
  zcash: 8,
  solana: 9,
  ton: 9,
  sui: 9,
  tron: 6,
  cardano: 6,
  aptos: 8,
  arweave: 12,
  decred: 8,
  stellar: 7,
  xrpl: 6,
};

export function nativeDecimals(chain: string): number {
  return NATIVE_DECIMALS[chain] ?? 18;
}

export function isEvm(chain: string): boolean {
  return chainInfo(chain)?.type === "evm";
}

const PROVIDERS_BY_KEY = new Map(PROVIDERS.map((provider) => [provider.key, provider]));
const CHAINS_BY_KEY = new Map(CHAINS.map((chain) => [chain.key, chain]));

export function providerInfo(key: string): ProviderInfo | undefined {
  return PROVIDERS_BY_KEY.get(key);
}

export function providerLabel(key: string): string {
  return providerInfo(key)?.label ?? key;
}

export function providerIcon(key: string): string {
  return providerInfo(key)?.icon ?? "i-lucide-server";
}

export function chainInfo(key: string): ChainInfo | undefined {
  return CHAINS_BY_KEY.get(key);
}

export function chainLabel(key: string): string {
  return chainInfo(key)?.name ?? key;
}

export function chainIcon(key: string): string {
  return chainInfo(key)?.icon ?? "i-lucide-layers";
}

/** Providers that can serve a capability on a chain, in registry order, the order `resolveProvider()` walks. */
export function providersFor(chain: string, capability?: Capability): readonly ProviderInfo[] {
  return PROVIDERS.filter(
    (provider) =>
      provider.chains.includes(chain) &&
      (capability === undefined || provider.capabilities.includes(capability)),
  );
}
