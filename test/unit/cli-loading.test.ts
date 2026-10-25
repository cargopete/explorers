/// <reference types="node" />
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vite-plus/test";

function runCLI(args: readonly string[], prelude = "") {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
${prelude}
process.argv = [process.execPath, "explorers", ...${JSON.stringify(args)}];
await import("./src/cli.ts");
`,
    ],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, CONSOLA_LEVEL: "3" },
    },
  );
}

const offline = `
globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
`;

describe("CLI loading", () => {
  it.each([
    "",
    "balance",
    "tx",
    "tx-history",
    "tx-detail",
    "utxos",
    "pubkey",
    "contract",
    "tokens",
    "transfers",
    "gas",
    "block",
    "providers",
    "mcp",
  ])("prints help without loading backends: explorers %s", (command) => {
    const result = runCLI(
      command ? [command, "--help"] : ["--help"],
      `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const backends = [];
registerHooks({ load(url, context, nextLoad) {
  if (url.includes("/src/core/") || url.includes("/src/providers/") ||
      url.includes("/@agntn/chains/") ||
      url.includes("/@modelcontextprotocol/")) backends.push(url);
  return nextLoad(url, context);
}});
process.once("exit", () => assert.deepEqual(backends, []));
${offline}
`,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("USAGE");
  });

  it.each([
    ["balance", "address"],
    ["tx", "address"],
    ["tx-history", "address"],
    ["tx-detail", "a".repeat(64)],
    ["utxos", "address"],
    ["pubkey", "address"],
    ["contract", "address"],
    ["tokens", "address"],
    ["transfers", "address"],
    ["gas"],
    ["block", "0"],
  ])("loads validation when executing %s", (...command) => {
    const result = runCLI([...command, "--chain", "not-a-chain"], offline);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not-a-chain");
    expect(result.stderr).not.toContain("Unexpected network request");
  });

  it.each([[["providers"]], [[]]])(
    "lists providers from registry metadata without loading a backend: %j",
    (args) => {
      const result = runCLI(
        args,
        `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
const backends = [];
registerHooks({ load(url, context, nextLoad) {
  if (url.includes("/src/providers/") && !url.endsWith("/src/providers/index.ts")) backends.push(url);
  return nextLoad(url, context);
}});
process.once("exit", () => assert.deepEqual(backends, []));
${offline}
`,
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const listed = JSON.parse(result.stdout) as Array<{
        name: string;
        chains: string[];
        capabilities?: Record<string, boolean>;
      }>;
      expect(listed).toHaveLength(23);
      expect(listed.find((listing) => listing.name === "mempool")).toMatchObject({
        chains: ["bitcoin", "litecoin", "pepecoin"],
        capabilities: { balances: true, utxos: true, pubkeys: true, contractInfo: false },
      });
    },
  );

  it.each([
    [["balance", "bc1qexample", "--provider", "mempool"], '"balanceFormatted":"0.00001"'],
    [["balance", "bc1qexample", "-p", "mempool"], '"unconfirmed":"-600"'],
    [["bc1qexample", "--provider", "mempool"], '"balanceFormatted":"0.00001"'],
    [["tx", "bc1qexample", "--provider", "mempool", "--mode", "history"], '"data":[]'],
    [["tx", "a".repeat(64), "--provider", "mempool"], '"valueFormatted":"0.00001"'],
    [["tx-detail", "a".repeat(64), "--provider", "mempool"], '"fee":"100"'],
    [["utxos", "bc1qexample", "--provider", "mempool"], `"txid":"${"b".repeat(64)}","vout":0`],
    [["pubkey", "bc1qexample", "--provider", "mempool"], '"pubkey":null'],
  ] as const)("executes reads after loading the backend: %j", (args, expected) => {
    const result = runCLI(
      args,
      `
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/tx/" + "a".repeat(64))) return Response.json({
    txid: "a".repeat(64), fee: 100, vin: [],
    vout: [{ scriptpubkey_address: "bc1qrecipient", value: 1000 }],
    status: { confirmed: true, block_height: 1000, block_time: 1700000000 },
  });
  if (url.endsWith("/address/bc1qexample/txs")) return new Response("[]");
  if (url.endsWith("/address/bc1qexample/utxo")) return Response.json([
    { txid: "b".repeat(64), vout: 0, value: 1000, status: { confirmed: true, block_height: 1000 } },
  ]);
  if (url.endsWith("/address/bc1qexample")) return Response.json({
    chain_stats: { funded_txo_sum: 1000, spent_txo_sum: 0, spent_txo_count: 0, tx_count: 0 },
    mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 600, spent_txo_count: 0, tx_count: 1 },
  });
  throw new Error("Unexpected network request: " + url);
};
`,
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(expected);
  });

  it("ends quietly when the reader of stdout goes away", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "providers"], {
      cwd: new URL("../../", import.meta.url),
      env: { ...process.env, CONSOLA_LEVEL: "3" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    // Closing the read end before the child writes makes its first write fail with EPIPE, as
    // after `| head -1`.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    await once(child, "close");

    expect(stderr).toBe("");
    expect(child.exitCode).toBe(0);
  });
});
