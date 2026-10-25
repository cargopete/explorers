/**
 * Nuthatch provider: the Etherscan-compatible `/api` of a nuthatch indexer the user runs.
 *
 * A nest in address-history mode serves Etherscan's account, proxy and block modules for the
 * addresses its operator watches, keyless, and refuses what it cannot prove instead of guessing.
 * There is no public instance, so the nest's root URL comes from `baseUrl` or `NUTHATCH_URL`.
 *
 * https://github.com/nuthatch-org/nuthatch
 */

import type {
  Balance,
  BlockInfo,
  ChainKey,
  ProviderCapabilities,
  ProviderConfig,
  TokenTransfer,
  TokenTransferOptions,
  Transaction,
  TxHistoryOptions,
} from "../core/types.ts";
import { create as createChain } from "@agntn/chains";
import { Provider } from "../core/provider.ts";
import type { ProviderOperation } from "../core/provider.ts";
import { buildQuery, normalizeBaseUrl } from "../core/client.ts";
import {
  ExplorerError,
  NotFoundError,
  UnsupportedChainError,
  UnsupportedOperationError,
} from "../core/errors.ts";
import { clampMaxResults, formatWei } from "../core/types.ts";
import { getChainId, mapBlock, mapRpcTransaction, mapTokenTransfer, mapTx } from "./etherscan.ts";
import type {
  EtherscanBlockResult,
  EtherscanResponse,
  EtherscanTokenTx,
  EtherscanTx,
} from "./etherscan.ts";

const UNSUPPORTED = "NUTHATCH_UNSUPPORTED:";
const INCOMPLETE = "NUTHATCH_INCOMPLETE:";

/* The nest names the chain it refused in one of two wordings, both opening on the `chainid`. */
const CHAIN_REFUSAL = /^chainid \S+ is not /;

function refusal(detail: string, chain: ChainKey, operation: ProviderOperation): ExplorerError {
  if (detail.startsWith(UNSUPPORTED)) {
    const why = detail.slice(UNSUPPORTED.length).trim();
    if (CHAIN_REFUSAL.test(why)) return new UnsupportedChainError(chain, "nuthatch");
    const error = new UnsupportedOperationError(operation, "nuthatch");
    error.message += `: ${why}`;
    return error;
  }
  if (detail.startsWith(INCOMPLETE)) {
    const why = detail.slice(INCOMPLETE.length).trim();
    return new ExplorerError(`Incomplete answer from nuthatch: ${why}`, "nuthatch");
  }
  return new ExplorerError(`Nuthatch API error: ${detail}`, "nuthatch");
}

function unwrap<T>(
  response: Readonly<EtherscanResponse<T>>,
  chain: ChainKey,
  operation: ProviderOperation,
): T {
  if (response.error) {
    throw new ExplorerError(`Nuthatch API error: ${response.error.message}`, "nuthatch");
  }
  if (response.status === "0") {
    const detail = typeof response.result === "string" ? response.result : response.message;
    throw refusal(detail || "Unknown nuthatch API error", chain, operation);
  }
  if (!("result" in response)) {
    throw new ExplorerError("Nuthatch API response did not include a result", "nuthatch");
  }
  return response.result as T;
}

/* Unlike Etherscan's, the bounds go out only when the caller sets them: the nest refuses a range
   past its head or before the traces it trusts, and Etherscan's 0 to 99999999 is both. */
function historyParams(
  address: string,
  options: Readonly<TxHistoryOptions> | undefined,
): Readonly<Record<string, string | number | undefined>> {
  return {
    address,
    startblock: options?.startBlock,
    endblock: options?.endBlock,
    page: options?.page ?? 1,
    offset: clampMaxResults(options?.limit),
    sort: options?.sort ?? "desc",
  };
}

export class Nuthatch extends Provider {
  static readonly key = "nuthatch";

  private readonly apiUrl: string;
  private readonly defaultChain: ChainKey;

  constructor(config: Readonly<ProviderConfig> = {}) {
    super(config);
    const root = config.baseUrl ?? process.env.NUTHATCH_URL ?? "";
    if (!root) {
      throw new ExplorerError("Set NUTHATCH_URL or pass baseUrl in config", "nuthatch");
    }
    this.apiUrl = `${normalizeBaseUrl(root)}/api`;
    this.defaultChain = config.defaultChain ?? "ethereum";
    getChainId(this.defaultChain, "nuthatch");
  }

  get capabilities(): ProviderCapabilities {
    return {
      balances: true,
      txHistory: true,
      txDetail: true,
      utxos: false,
      pubkeys: false,
      contractInfo: false,
      tokenBalances: false,
      tokenTransfers: true,
      gasData: false,
      blockInfo: true,
    };
  }

  private async api<T>(
    chain: ChainKey,
    operation: ProviderOperation,
    module: string,
    action: string,
    params: Readonly<Record<string, string | number | undefined>> = {},
  ): Promise<T> {
    const query = buildQuery({
      chainid: getChainId(chain, "nuthatch"),
      module,
      action,
      ...params,
    });
    const response = await this.getJSON<EtherscanResponse<T>>(`${this.apiUrl}${query}`);
    return unwrap(response, chain, operation);
  }

  async getBalance(address: string, chain?: ChainKey): Promise<Balance> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<string>(c, "getBalance", "account", "balance", {
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
    const result = await this.api<EtherscanTx[]>(
      c,
      "getTxHistory",
      "account",
      "txlist",
      historyParams(address, options),
    );
    return Array.isArray(result) ? result.map(mapTx) : [];
  }

  override async getTxDetail(hash: string, chain?: ChainKey): Promise<Transaction> {
    const c = chain ?? this.defaultChain;
    const tx = await this.api<Record<string, string | null> | null>(
      c,
      "getTxDetail",
      "proxy",
      "eth_getTransactionByHash",
      { txhash: hash },
    );
    if (!tx?.hash) {
      throw new NotFoundError(`Transaction ${hash}`, "nuthatch");
    }

    const receipt = await this.api<Record<string, string | null> | null>(
      c,
      "getTxDetail",
      "proxy",
      "eth_getTransactionReceipt",
      { txhash: hash },
    );
    return mapRpcTransaction(tx, receipt);
  }

  override async getTokenTransfers(
    address: string,
    chain?: ChainKey,
    options?: Readonly<TokenTransferOptions>,
  ): Promise<TokenTransfer[]> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<EtherscanTokenTx[]>(
      c,
      "getTokenTransfers",
      "account",
      "tokentx",
      {
        ...historyParams(address, options),
        contractaddress: options?.token,
      },
    );
    return Array.isArray(result) ? result.map(mapTokenTransfer) : [];
  }

  override async getBlockInfo(blockNumber: number, chain?: ChainKey): Promise<BlockInfo> {
    const c = chain ?? this.defaultChain;
    const result = await this.api<EtherscanBlockResult | null>(
      c,
      "getBlockInfo",
      "proxy",
      "eth_getBlockByNumber",
      { tag: `0x${blockNumber.toString(16)}`, boolean: "false" },
    );
    if (!result) {
      throw new NotFoundError(`Block ${blockNumber}`, "nuthatch");
    }
    return mapBlock(result);
  }
}
