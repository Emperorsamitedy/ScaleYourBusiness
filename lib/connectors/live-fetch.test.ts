// The connectors' live fetches — review 2026-10-23, #24. Shopify and Square
// carry a timeout so a stalled call can't hang the sync cron; WooCommerce,
// whose address the owner typed, connects only to the addresses it vetted.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type * as SiteFetch from "../site/fetch";

const vetted = vi.hoisted(() => ({
  addresses: null as { address: string; family: 4 | 6 }[] | null,
}));

vi.mock("../site/fetch", async (importOriginal) => {
  const real = await importOriginal<typeof SiteFetch>();
  return {
    ...real,
    // The test decides what "vetted" answers; the pinning itself is real.
    vetAddresses: async (url: URL) => vetted.addresses ?? (await real.vetAddresses(url)),
  };
});

import { SHOPIFY_FETCH_TIMEOUT_MS, shopifyLiveFetch } from "./providers/shopify";
import { SQUARE_FETCH_TIMEOUT_MS, squareLiveFetch } from "./providers/square";
import { wooLiveFetch } from "./providers/woocommerce";

afterEach(() => {
  vi.unstubAllGlobals();
  vetted.addresses = null;
});

describe("Shopify and Square fetch with a timeout", () => {
  for (const [name, live, ms] of [
    ["Shopify", shopifyLiveFetch, SHOPIFY_FETCH_TIMEOUT_MS],
    ["Square", squareLiveFetch, SQUARE_FETCH_TIMEOUT_MS],
  ] as const) {
    it(`${name}: every request carries an abort signal, bounded under a minute`, async () => {
      const seen: RequestInit[] = [];
      vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        seen.push(init);
        return new Response("{}", { status: 200 });
      });
      await live("https://example.com/x", { method: "GET", headers: {} } as never);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(seen[0]?.signal?.aborted).toBe(false);
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(30_000);
    });
  }
});

describe("WooCommerce connects only to the vetted address", () => {
  it("refuses an address that resolves inside a private network, before any request", async () => {
    const touched = vi.fn();
    vi.stubGlobal("fetch", touched);
    await expect(
      wooLiveFetch("https://localhost/wp-json/wc/v3/products", { method: "GET", headers: {} }),
    ).rejects.toThrow(/doesn't resolve to a public server/);
    expect(touched).not.toHaveBeenCalled();
  });

  it("connects to the pinned address, never a second resolution of the name", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("x-wp-totalpages", "1");
      res.end(JSON.stringify([{ id: 7 }]));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // The name can't resolve anywhere (.invalid is reserved): only the pin reaches the server.
      vetted.addresses = [{ address: "127.0.0.1", family: 4 }];
      const res = await wooLiveFetch(`http://store.invalid:${port}/wp-json/wc/v3/products`, {
        method: "GET",
        headers: {},
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ id: 7 }]);
      expect(res.header("x-wp-totalpages")).toBe("1");

      // Without the pin, the same name goes nowhere.
      vetted.addresses = null;
      await expect(
        wooLiveFetch(`http://store.invalid:${port}/x`, { method: "GET", headers: {} }),
      ).rejects.toThrow();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
