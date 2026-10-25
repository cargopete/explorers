import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getChain } from "@agntn/chains";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  getDefaultURL,
  listProviders,
  providers,
  register,
  supportsCapability,
} from "../../src/core/registry.ts";
import type { ProviderCapability } from "../../src/core/provider.ts";
import { builtins } from "../../src/providers/index.ts";
import config from "../../build.config.ts";

const providerDir = fileURLToPath(new URL("../../src/providers/", import.meta.url));
const buildInputs = config.entries?.flatMap((entry) =>
  typeof entry !== "string" && entry.type === "bundle" ? [entry.input].flat() : [],
);

/* Nuthatch has no public instance, so a configured one names its nest. */
const CONFIGURED = { apiKey: "configured", baseUrl: "http://127.0.0.1:8288" };

const modules = readdirSync(providerDir).filter(
  (file) => file.endsWith(".ts") && file !== "index.ts",
);

describe("built-in provider registry", () => {
  it("keeps every provider module in the list", () => {
    expect(builtins).toHaveLength(modules.length);
  });

  it("shares an in-flight provider load across concurrent creates", async () => {
    vi.resetModules();
    const { builtins: isolatedBuiltins } = await import("../../src/providers/index.ts");
    const { create: isolatedCreate } = await import("../../src/core/registry.ts");
    const entry = isolatedBuiltins.find((candidate) => candidate.key === "mempool");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Missing mempool provider entry");

    const load = vi.spyOn(entry, "load");
    try {
      const [first, second] = await Promise.all([
        isolatedCreate("mempool"),
        isolatedCreate("mempool"),
      ]);

      expect(first.name).toBe("mempool");
      expect(second.name).toBe("mempool");
      expect(first).not.toBe(second);
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      load.mockRestore();
    }
  });

  it("registers the listed providers under their own keys, in order", () => {
    expect(providers()).toEqual(builtins.map((entry) => entry.key));
  });

  it("advertises the endpoint each entry declares", () => {
    for (const entry of builtins) {
      expect(getDefaultURL(entry.key)).toBe(entry.defaultURL);
    }
  });

  it("names chains the chain registry knows", () => {
    for (const entry of builtins) {
      expect(entry.chains.length).toBeGreaterThan(0);
      for (const chain of entry.chains) {
        expect(getChain(chain).key).toBe(chain);
      }
    }
  });

  it("loads a class whose key matches its entry", async () => {
    for (const entry of builtins) {
      const providerClass = await entry.load();
      expect(providerClass.key).toBe(entry.key);
    }
  });

  it("keeps selection capabilities aligned with provider instances", async () => {
    for (const entry of builtins) {
      const ProviderClass = await entry.load();
      const provider = new ProviderClass(CONFIGURED);
      const capabilities = Object.entries(provider.capabilities) as [ProviderCapability, boolean][];

      for (const [capability, supported] of capabilities) {
        expect(supportsCapability(entry.key, capability)).toBe(supported);
      }
    }
  });

  it("skips a chain gap in routing, and the provider refuses that read on that chain", async () => {
    expect(supportsCapability("mempool", "blockInfo")).toBe(true);
    expect(supportsCapability("mempool", "blockInfo", "bitcoin")).toBe(true);
    expect(supportsCapability("mempool", "blockInfo", "pepecoin")).toBe(false);
    expect(supportsCapability("mempool", "gasData", "pepecoin")).toBe(false);
    expect(supportsCapability("mempool", "balances", "pepecoin")).toBe(true);

    const ProviderClass = await builtins.find((entry) => entry.key === "mempool")?.load();
    if (!ProviderClass) throw new Error("Missing mempool provider entry");
    const provider = new ProviderClass({});
    await expect(provider.getGasData?.("pepecoin")).rejects.toMatchObject({
      name: "UnsupportedOperationError",
      operation: "getGasData",
    });
    await expect(provider.getBlockInfo?.(1, "pepecoin")).rejects.toMatchObject({
      name: "UnsupportedOperationError",
      operation: "getBlockInfo",
    });
  });

  it("describes every provider without loading a module", async () => {
    vi.resetModules();
    const { builtins: isolatedBuiltins } = await import("../../src/providers/index.ts");
    const { listProviders: isolatedListProviders } = await import("../../src/core/registry.ts");
    const loads = isolatedBuiltins.map((entry) => vi.spyOn(entry, "load"));

    try {
      const listed = isolatedListProviders();

      expect(listed.map((listing) => listing.name)).toEqual(
        isolatedBuiltins.map((entry) => entry.key),
      );
      for (const load of loads) expect(load).not.toHaveBeenCalled();
    } finally {
      for (const load of loads) load.mockRestore();
    }
  });

  it("lists the chains, endpoint, and capability flags each loaded class exposes", async () => {
    const listed = new Map(listProviders().map((listing) => [listing.name, listing]));

    for (const entry of builtins) {
      const ProviderClass = await entry.load();
      const provider = new ProviderClass(CONFIGURED);

      expect(listed.get(entry.key)).toEqual({
        name: entry.key,
        chains: entry.chains,
        defaultUrl: entry.defaultURL,
        capabilities: provider.capabilities,
      });
    }
  });

  it("leaves capabilities undeclared for an external registration without metadata", async () => {
    const entry = builtins.find((candidate) => candidate.key === "mempool");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Missing mempool provider entry");
    const ProviderClass = await entry.load();

    try {
      register(ProviderClass, { chains: entry.chains, defaultURL: entry.defaultURL });
      expect(listProviders().find((listing) => listing.name === "mempool")).toEqual({
        name: "mempool",
        chains: entry.chains,
        defaultUrl: entry.defaultURL,
        capabilities: undefined,
      });
    } finally {
      register(ProviderClass, entry);
    }
  });

  it("keeps external registrations eligible when capability metadata is omitted", async () => {
    const entry = builtins.find((candidate) => candidate.key === "mempool");
    expect(entry).toBeDefined();
    if (!entry) throw new Error("Missing mempool provider entry");
    const ProviderClass = await entry.load();

    try {
      register(ProviderClass, { chains: entry.chains, defaultURL: entry.defaultURL });
      expect(supportsCapability(entry.key, "contractInfo")).toBe(true);
    } finally {
      register(ProviderClass, entry);
    }
  });

  it("builds every provider module as its own bundle entry", () => {
    expect(buildInputs).toEqual(
      expect.arrayContaining(modules.map((file) => `./src/providers/${file}`)),
    );
  });
});
