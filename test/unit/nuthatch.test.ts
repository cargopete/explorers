import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ExplorerError,
  NotFoundError,
  UnsupportedChainError,
  UnsupportedOperationError,
} from "../../src/core/errors.ts";
import { requireOperation } from "../../src/core/provider.ts";
import { create } from "../../src/core/registry.ts";
import { resolveProvider } from "../../src/core/resolve.ts";
import { builtins } from "../../src/providers/index.ts";

const ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const NEST = "http://127.0.0.1:8288";

function stubJSON(...bodies: readonly unknown[]) {
  const queue = [...bodies];
  const fetch = vi.fn(async () => Response.json(queue.length > 1 ? queue.shift() : queue[0]));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function requestParams(calls: readonly (readonly unknown[])[], call = 0): URLSearchParams {
  return new URL(String(calls[call]?.[0])).searchParams;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("nuthatch provider", () => {
  it("needs the nest's URL, from config or NUTHATCH_URL", async () => {
    vi.stubEnv("NUTHATCH_URL", "");
    await expect(create("nuthatch")).rejects.toThrow("Set NUTHATCH_URL or pass baseUrl in config");

    vi.stubEnv("NUTHATCH_URL", `${NEST}/`);
    const fetch = stubJSON({ status: "1", message: "OK", result: "1000000000000000000" });
    const provider = await create("nuthatch");
    await provider.getBalance(ADDRESS, "base");

    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(`${NEST}/api`);
  });

  it("reads a balance through account/balance with the chain's id and no key", async () => {
    const fetch = stubJSON({ status: "1", message: "OK", result: "1500000000000000000" });
    const provider = await create("nuthatch", { baseUrl: NEST });

    const balance = await provider.getBalance(ADDRESS, "base");

    const params = requestParams(fetch.mock.calls);
    expect(params.get("chainid")).toBe("8453");
    expect(params.get("module")).toBe("account");
    expect(params.get("action")).toBe("balance");
    expect(params.get("tag")).toBe("latest");
    expect(params.has("apikey")).toBe(false);
    expect(balance).toMatchObject({
      address: ADDRESS,
      chain: "base",
      balance: "1500000000000000000",
      balanceFormatted: "1.5",
      symbol: "ETH",
    });
  });

  it("sends block bounds only when the caller sets them", async () => {
    const fetch = stubJSON({ status: "1", message: "OK", result: [] });
    const provider = await create("nuthatch", { baseUrl: NEST });

    await provider.getTxHistory(ADDRESS, "base");
    await provider.getTxHistory(ADDRESS, "base", { startBlock: 10, endBlock: 20, limit: 5 });

    const unbounded = requestParams(fetch.mock.calls, 0);
    expect(unbounded.get("action")).toBe("txlist");
    expect(unbounded.has("startblock")).toBe(false);
    expect(unbounded.has("endblock")).toBe(false);
    expect(unbounded.get("sort")).toBe("desc");
    const bounded = requestParams(fetch.mock.calls, 1);
    expect(bounded.get("startblock")).toBe("10");
    expect(bounded.get("endblock")).toBe("20");
    expect(bounded.get("offset")).toBe("5");
  });

  it("maps history rows the way Etherscan does", async () => {
    stubJSON({
      status: "1",
      message: "OK",
      generation: "3",
      result: [
        {
          blockNumber: "20000000",
          timeStamp: "1700000000",
          hash: "0xabc",
          from: ADDRESS,
          to: "0x2222222222222222222222222222222222222222",
          value: "1000",
          gas: "21000",
          gasUsed: "21000",
          gasPrice: "2",
          isError: "0",
          txreceipt_status: "1",
          input: "0x",
          contractAddress: "",
          confirmations: "5",
        },
      ],
    });
    const provider = await create("nuthatch", { baseUrl: NEST });

    const [tx] = await provider.getTxHistory(ADDRESS, "base");

    expect(tx).toMatchObject({
      hash: "0xabc",
      blockNumber: 20_000_000,
      timestamp: new Date(1_700_000_000_000).toISOString(),
      to: "0x2222222222222222222222222222222222222222",
      value: "1000",
      fee: "42000",
      status: "success",
      isContractInteraction: false,
    });
  });

  it("reads token transfers by address with the token filter", async () => {
    const fetch = stubJSON({ status: "1", message: "OK", result: [] });
    const provider = await create("nuthatch", { baseUrl: NEST });
    const token = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

    await requireOperation(provider, "getTokenTransfers")(ADDRESS, "base", { token });

    const params = requestParams(fetch.mock.calls);
    expect(params.get("action")).toBe("tokentx");
    expect(params.get("address")).toBe(ADDRESS);
    expect(params.get("contractaddress")).toBe(token);
  });

  it("reads one transaction and a block through the proxy module", async () => {
    const fetch = stubJSON(
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          hash: "0xabc",
          blockNumber: "0x10",
          from: ADDRESS,
          to: null,
          value: "0x0",
          gasPrice: "0x2",
          input: "0x6080",
        },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          status: "0x1",
          gasUsed: "0x5208",
          contractAddress: "0x3333333333333333333333333333333333333333",
        },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          number: "0x10",
          hash: "0xblock",
          parentHash: "0xparent",
          timestamp: "0x65",
          miner: "0x4200000000000000000000000000000000000011",
          gasLimit: "0x1c9c380",
          gasUsed: "0x5208",
          baseFeePerGas: "0x7",
          transactions: ["0xabc"],
        },
      },
    );
    const provider = await create("nuthatch", { baseUrl: NEST });

    const tx = await requireOperation(provider, "getTxDetail")("0xabc", "base");
    const block = await requireOperation(provider, "getBlockInfo")(16, "base");

    expect(requestParams(fetch.mock.calls, 0).get("action")).toBe("eth_getTransactionByHash");
    expect(requestParams(fetch.mock.calls, 1).get("action")).toBe("eth_getTransactionReceipt");
    expect(requestParams(fetch.mock.calls, 2).get("tag")).toBe("0x10");
    expect(tx).toMatchObject({
      hash: "0xabc",
      to: null,
      createdContract: "0x3333333333333333333333333333333333333333",
      fee: "42000",
      status: "success",
    });
    expect(block).toMatchObject({ number: 16, hash: "0xblock", txCount: 1, baseFee: "7" });
  });

  it("answers a transaction the RPC does not know with NotFoundError", async () => {
    stubJSON({ jsonrpc: "2.0", id: 1, result: null });
    const provider = await create("nuthatch", { baseUrl: NEST });

    await expect(requireOperation(provider, "getTxDetail")("0xabc", "base")).rejects.toThrow(
      NotFoundError,
    );
  });

  it("reads the nest's chain refusal as UnsupportedChainError", async () => {
    stubJSON({
      status: "0",
      message: "NOTOK",
      result: "NUTHATCH_UNSUPPORTED: chainid 1 is not this nest's chain 8453",
    });
    const provider = await create("nuthatch", { baseUrl: NEST });

    await expect(provider.getBalance(ADDRESS, "ethereum")).rejects.toMatchObject({
      name: "UnsupportedChainError",
      chain: "ethereum",
      provider: "nuthatch",
    });
  });

  it("reads any other refusal as UnsupportedOperationError and keeps the nest's reason", async () => {
    stubJSON({
      status: "0",
      message: "NOTOK",
      result: "NUTHATCH_UNSUPPORTED: chain 10 has no trustworthy traces before block 105235063",
    });
    const provider = await create("nuthatch", { baseUrl: NEST });

    const error = await provider
      .getTxHistory(ADDRESS, "optimism", { startBlock: 0 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedOperationError);
    expect(error).toMatchObject({ operation: "getTxHistory", provider: "nuthatch" });
    expect((error as Error).message).toBe(
      'Operation "getTxHistory" not supported by nuthatch: chain 10 has no trustworthy traces before block 105235063',
    );
  });

  it("reads an unproven range as an incomplete answer, never as an empty one", async () => {
    stubJSON({
      status: "0",
      message: "NOTOK",
      result: "NUTHATCH_INCOMPLETE: covered through block 100; ask again later",
    });
    const provider = await create("nuthatch", { baseUrl: NEST });

    const error = await provider.getTxHistory(ADDRESS, "base").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExplorerError);
    expect(error).not.toBeInstanceOf(UnsupportedChainError);
    expect(error).not.toBeInstanceOf(UnsupportedOperationError);
    expect((error as Error).message).toBe(
      "Incomplete answer from nuthatch: covered through block 100; ask again later",
    );
  });

  it("serves no contract, holding or gas reads", async () => {
    const provider = await create("nuthatch", { baseUrl: NEST });

    expect(provider.getContractInfo).toBeUndefined();
    expect(provider.getTokenBalances).toBeUndefined();
    expect(provider.getGasData).toBeUndefined();
    expect(() => requireOperation(provider, "getGasData")).toThrow(UnsupportedOperationError);
  });

  it("is never chosen automatically, even with NUTHATCH_URL set and no keys", () => {
    vi.stubEnv("NUTHATCH_URL", NEST);
    vi.stubEnv("ETHERSCAN_API_KEY", "");
    const entry = builtins.find((candidate) => candidate.key === "nuthatch");
    expect(entry?.chains).toHaveLength(10);

    for (const chain of entry?.chains ?? []) {
      for (const capability of entry?.capabilities ?? []) {
        expect(resolveProvider(undefined, chain, capability)).not.toBe("nuthatch");
      }
      expect(resolveProvider(undefined, chain)).not.toBe("nuthatch");
    }
    expect(resolveProvider("nuthatch", "base")).toBe("nuthatch");
  });
});
