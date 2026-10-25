/**
 * Etherscan V2 provider.
 *
 * Uses Etherscan's unified multichain endpoint for Ethereum, Base, Arbitrum, Optimism, Polygon,
 * BSC, Avalanche, Gnosis, Linea, and Berachain.
 *
 * Auth: Etherscan API key. Env: ETHERSCAN_API_KEY
 */

import type {
  ProviderCapabilities,
  ProviderConfig,
  ChainKey,
  Balance,
  Transaction,
  TxHistoryOptions,
  ContractInfo,
  TokenBalance,
  TokenBalanceOptions,
  TokenTransfer,
  TokenTransferOptions,
  GasData,
  BlockInfo,
  TxStatus,
} from "../core/types.ts";
import { Provider } from "../core/provider.ts";
import { buildQuery, normalizeBaseUrl } from "../core/client.ts";
import {
  AuthError,
  ExplorerError,
  NotFoundError,
  PlanRestrictedError,
  RateLimitError,
  UnsupportedChainError,
} from "../core/errors.ts";
import { create as createChain } from "@agntn/chains";
import { clampMaxResults, formatWei, multiplyIntegerStrings } from "../core/types.ts";

const DEFAULT_BASE = "https://api.etherscan.io/v2/api";
const SUPPORTED_CHAINS = new Set<ChainKey>([
  "ethereum",
  "base",
  "arbitrum",
  "optimism",
  "polygon",
  "bsc",
  "avalanche",
  "gnosis",
  "linea",
  "berachain",
]);

export interface EtherscanResponse<T> {
  readonly status?: string;
  readonly message?: string;
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface EtherscanTx {
  readonly blockNumber: string;
  readonly timeStamp: string;
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly gas: string;
  readonly gasUsed: string;
  readonly gasPrice: string;
  readonly isError: string;
  readonly txreceipt_status: string;
  readonly input: string;
  readonly functionName?: string;
  readonly methodId?: string;
  readonly contractAddress: string;
  readonly confirmations: string;
}

export interface EtherscanTokenTx {
  readonly blockNumber: string;
  readonly timeStamp: string;
  readonly hash: string;
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly contractAddress: string;
  readonly tokenName: string;
  readonly tokenSymbol: string;
  readonly tokenDecimal: string;
}

interface EtherscanTokenBalance {
  readonly TokenAddress: string;
  readonly TokenName: string;
  readonly TokenSymbol: string;
  readonly TokenDivisor: string;
  readonly TokenQuantity: string;
}

interface EtherscanGasResult {
  readonly LastBlock: string;
  readonly SafeGasPrice: string;
  readonly ProposeGasPrice: string;
  readonly FastGasPrice: string;
  readonly suggestBaseFee: string;
  readonly gasUsedRatio: string;
}

export interface EtherscanBlockResult {
  readonly number: string;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: string;
  readonly miner: string;
  readonly gasLimit: string;
  readonly gasUsed: string;
  readonly baseFeePerGas?: string;
  readonly transactions: readonly string[];
}

/**
 * The decimal `chainid` an Etherscan-shaped API takes, for one of the chains Etherscan serves.
 *
 * @param {ChainKey} chain - The requested chain.
 * @param {string} provider - The provider a refusal names.
 * @returns {string} The chain ID in decimal.
 */
export function getChainId(chain: ChainKey, provider = "etherscan"): string {
  if (!SUPPORTED_CHAINS.has(chain)) {
    throw new UnsupportedChainError(chain, provider);
  }
  const { chainId } = createChain(chain);
  if (!chainId) {
    throw new UnsupportedChainError(chain, provider);
  }
  return BigInt(chainId).toString();
}

export function mapBlock(result: Readonly<EtherscanBlockResult>): BlockInfo {
  return {
    number: Number(result.number),
    hash: result.hash,
    parentHash: result.parentHash,
    timestamp: new Date(Number(result.timestamp) * 1000).toISOString(),
    miner: result.miner,
    gasUsed: BigInt(result.gasUsed).toString(),
    gasLimit: BigInt(result.gasLimit).toString(),
    txCount: result.transactions.length,
    baseFee: result.baseFeePerGas ? BigInt(result.baseFeePerGas).toString() : undefined,
  };
}

export function mapTx(raw: Readonly<EtherscanTx>): Transaction {
  const status: TxStatus =
    raw.isError === "1" || raw.txreceipt_status === "0" ? "failed" : "success";
  return {
    hash: raw.hash,
    blockNumber: Number(raw.blockNumber),
    timestamp: new Date(Number(raw.timeStamp) * 1000).toISOString(),
    from: raw.from,
    to: raw.to || null,
    createdContract: raw.contractAddress || undefined,
    value: raw.value,
    valueFormatted: formatWei(raw.value),
    gasUsed: raw.gasUsed,
    gasPrice: raw.gasPrice,
    fee: multiplyIntegerStrings(raw.gasUsed, raw.gasPrice),
    status,
    methodId: raw.methodId,
    functionName: raw.functionName,
    isContractInteraction: raw.input !== "0x" && raw.input.length > 2,
    tokenTransfers: [],
    raw: raw as unknown as Record<string, unknown>,
  };
}

function isEmptyEtherscanResult(action: string, message: string): boolean {
  if (action === "txlist" || action === "tokentx") return /no transactions found/i.test(message);
  return action === "addresstokenbalance" && /no (token|record)/i.test(message);
}

function isPlanRestriction(message: string): boolean {
  return /free api access is not supported|api pro endpoint/i.test(message);
}

function etherscanFailure(action: string, message: string): never | [] {
  if (isEmptyEtherscanResult(action, message)) return [];
  if (/rate limit/i.test(message)) throw new RateLimitError("etherscan");
  if (isPlanRestriction(message)) throw new PlanRestrictedError("etherscan", message);
  if (/invalid api key|missing\/invalid api key/i.test(message)) {
    throw new AuthError("etherscan", "Invalid API key");
  }
  throw new ExplorerError(`Etherscan API error: ${message}`, "etherscan");
}

function unwrapEtherscanResponse<T>(response: Readonly<EtherscanResponse<T>>, action: string): T {
  if (response.error) {
    if (isPlanRestriction(response.error.message)) {
      throw new PlanRestrictedError("etherscan", response.error.message);
    }
    throw new ExplorerError(`Etherscan API error: ${response.error.message}`, "etherscan");
  }
  if (response.status === "0") {
    const detail = typeof response.result === "string" ? response.result : response.message;
    return etherscanFailure(action, detail || "Unknown Etherscan API error") as T;
  }
  if (!("result" in response)) {
    throw new ExplorerError("Etherscan API response did not include a result", "etherscan");
  }
  return response.result as T;
}

function historyParams(
  address: string,
  options: Readonly<TxHistoryOptions> | undefined,
  limit: number,
): Readonly<Record<string, string | number | undefined>> {
  return {
    address,
    startblock: options?.startBlock ?? 0,
    endblock: options?.endBlock ?? 99999999,
    page: options?.page ?? 1,
    offset: limit,
    sort: options?.sort ?? "desc",
  };
}

function rpcQuantity(value: string | null | undefined): string | undefined {
  return value ? BigInt(value).toString() : undefined;
}

function rpcStatus(receipt: Readonly<Record<string, string | null>> | null): TxStatus {
  if (!receipt) return "pending";
  return receipt.status === "0x1" ? "success" : "failed";
}

function rpcCreatedContract(
  receipt: Readonly<Record<string, string | null>> | null,
): string | undefined {
  return receipt?.contractAddress ?? undefined;
}

function rpcFee(gasUsed: string | undefined, gasPrice: string | undefined): string | undefined {
  return gasUsed && gasPrice ? multiplyIntegerStrings(gasUsed, gasPrice) : undefined;
}

function rpcInput(input: string | null | undefined): {
  readonly isContractInteraction: boolean;
  readonly methodId?: string;
} {
  return {
    methodId: input ? input.slice(0, 10) : undefined,
    isContractInteraction: (input?.length ?? 0) > 2,
  };
}

export function mapRpcTransaction(
  tx: Readonly<Record<string, string | null>>,
  receipt: Readonly<Record<string, string | null>> | null,
): Transaction {
  const gasUsed = rpcQuantity(receipt?.gasUsed);
  const gasPrice = rpcQuantity(tx.gasPrice);
  const value = rpcQuantity(tx.value) ?? "0";
  return {
    hash: tx.hash ?? "",
    blockNumber: Number(tx.blockNumber ?? "0x0"),
    from: tx.from ?? "",
    to: tx.to ?? null,
    createdContract: rpcCreatedContract(receipt),
    value,
    valueFormatted: formatWei(value),
    gasUsed,
    gasPrice,
    fee: rpcFee(gasUsed, gasPrice),
    status: rpcStatus(receipt),
    ...rpcInput(tx.input),
    tokenTransfers: [],
    raw: { ...tx, receipt } as Record<string, unknown>,
  };
}

function optionalString(value: string | undefined): string | undefined {
  return value || undefined;
}

function contractSource(
  contract: Readonly<Record<string, string>> | undefined,
): Pick<ContractInfo, "abi" | "compilerVersion" | "isVerified" | "name" | "sourceCode"> {
  const abi = contract?.ABI;
  const isVerified = abi !== undefined && abi !== "Contract source code not verified" && abi !== "";
  return {
    isVerified,
    name: optionalString(contract?.ContractName),
    compilerVersion: optionalString(contract?.CompilerVersion),
    abi: isVerified ? abi : undefined,
    sourceCode: isVerified ? contract?.SourceCode : undefined,
  };
}

function mapContract(
  address: string,
  contract: Readonly<Record<string, string>> | undefined,
): ContractInfo {
  return {
    address,
    ...contractSource(contract),
    isProxy: contract?.Proxy === "1",
    implementationAddress: optionalString(contract?.Implementation),
  };
}

export function mapTokenTransfer(raw: Readonly<EtherscanTokenTx>): TokenTransfer {
  const decimals = Number(raw.tokenDecimal);
  return {
    contract: raw.contractAddress,
    symbol: raw.tokenSymbol,
    name: raw.tokenName,
    decimals,
    value: raw.value,
    valueFormatted: formatWei(raw.value, decimals),
    from: raw.from,
    to: raw.to,
    txHash: raw.hash,
    blockNumber: Number(raw.blockNumber),
    timestamp: new Date(Number(raw.timeStamp) * 1000).toISOString(),
  };
}

export class Etherscan extends Provider {
  static readonly key = "etherscan";

  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly defaultChain: ChainKey;

  constructor(config: Readonly<ProviderConfig>) {
    super(config);
    const key = config.apiKey ?? process.env.ETHERSCAN_API_KEY ?? "";
    if (!key) {
      throw new AuthError("etherscan", "Set ETHERSCAN_API_KEY or pass apiKey in config");
    }
    this.apiKey = key;
    this.apiUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE);
    this.defaultChain = config.defaultChain ?? "ethereum";
    getChainId(this.defaultChain);
  }
  get capabilities(): ProviderCapabilities {
    return {
      balances: true,
      txHistory: true,
      txDetail: true,
      utxos: false,
      pubkeys: false,
      contractInfo: true,
      tokenBalances: true,
      tokenTransfers: true,
      gasData: true,
      blockInfo: true,
    };
  }

  private async api<T>(
    chain: ChainKey,
    module: string,
    action: string,
    params: Readonly<Record<string, string | number | undefined>> = {},
  ): Promise<T> {
    const query = buildQuery({
      chainid: getChainId(chain),
      module,
      action,
      apikey: this.apiKey,
      ...params,
    });
    const response = await this.getJSON<EtherscanResponse<T>>(`${this.apiUrl}${query}`);
    return unwrapEtherscanResponse(response, action);
  }

  async getBalance(address: string, chain?: ChainKey): Promise<Balance> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<string>(c, "account", "balance", {
      address,
      tag: "latest",
    });

    return this.snapshotBalance({
      address,
      chain: c,
      balance: result,
      balanceFormatted: formatWei(result),
      symbol: createChain(c).symbol,
    });
  }

  async getTxHistory(
    address: string,
    chain?: ChainKey,
    options?: Readonly<TxHistoryOptions>,
  ): Promise<Transaction[]> {
    const c = chain ?? this.defaultChain;
    const limit = clampMaxResults(options?.limit);
    const result = await this.api<EtherscanTx[]>(
      c,
      "account",
      "txlist",
      historyParams(address, options, limit),
    );

    if (!Array.isArray(result)) return [];
    return result.map(mapTx);
  }

  override async getTxDetail(hash: string, chain?: ChainKey): Promise<Transaction> {
    const c = chain ?? this.defaultChain;
    const tx = await this.api<Record<string, string | null> | null>(
      c,
      "proxy",
      "eth_getTransactionByHash",
      { txhash: hash },
    );

    if (!tx?.hash) {
      throw new NotFoundError(`Transaction ${hash}`, "etherscan");
    }

    const receipt = await this.api<Record<string, string | null> | null>(
      c,
      "proxy",
      "eth_getTransactionReceipt",
      { txhash: hash },
    );

    return mapRpcTransaction(tx, receipt);
  }

  override async getContractInfo(address: string, chain?: ChainKey): Promise<ContractInfo> {
    const c = chain ?? this.defaultChain;

    const source = await this.api<Array<Record<string, string>>>(c, "contract", "getsourcecode", {
      address,
    });
    return mapContract(address, source[0]);
  }

  override async getTokenBalances(
    address: string,
    chain?: ChainKey,
    options?: Readonly<TokenBalanceOptions>,
  ): Promise<TokenBalance[]> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<EtherscanTokenBalance[]>(c, "account", "addresstokenbalance", {
      address,
    });

    let tokens = result.map((token) => {
      const decimals = Number(token.TokenDivisor);
      return {
        contract: token.TokenAddress,
        symbol: token.TokenSymbol,
        name: token.TokenName,
        decimals,
        balance: token.TokenQuantity,
        balanceFormatted: formatWei(token.TokenQuantity, decimals),
      };
    });

    if (options?.nonZeroOnly) {
      tokens = tokens.filter((t) => t.balance !== "0");
    }

    return tokens;
  }

  override async getTokenTransfers(
    address: string,
    chain?: ChainKey,
    options?: Readonly<TokenTransferOptions>,
  ): Promise<TokenTransfer[]> {
    const c = chain ?? this.defaultChain;
    const limit = clampMaxResults(options?.limit);
    const result = await this.api<EtherscanTokenTx[]>(c, "account", "tokentx", {
      ...historyParams(address, options, limit),
      contractaddress: options?.token,
    });

    return Array.isArray(result) ? result.map(mapTokenTransfer) : [];
  }

  override async getGasData(chain?: ChainKey): Promise<GasData> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<EtherscanGasResult>(c, "gastracker", "gasoracle");

    return {
      chain: c,
      unit: "gwei",
      safeGasPrice: result.SafeGasPrice,
      proposedGasPrice: result.ProposeGasPrice,
      fastGasPrice: result.FastGasPrice,
      baseFee: result.suggestBaseFee,
    };
  }

  override async getBlockInfo(blockNumber: number, chain?: ChainKey): Promise<BlockInfo> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<EtherscanBlockResult | null>(c, "proxy", "eth_getBlockByNumber", {
      tag: `0x${blockNumber.toString(16)}`,
      boolean: "false",
    });
    if (!result) {
      throw new NotFoundError(`Block ${blockNumber}`, "etherscan");
    }

    return mapBlock(result);
  }
}
