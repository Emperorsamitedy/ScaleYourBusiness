// P2-17 — WooCommerce behind the same contract as Shopify.
//
// A REST store on the owner's own site, against a recorded-shape
// WooCommerce. What these tests hold:
//
//   · THE ADDRESS GUARD. The store address is owner-typed, so http, IP
//     literals, localhost, internal names and embedded credentials are all
//     refused before any request.
//   · READ-ONLY, AS FAR AS CAN BE PROVEN. Every request is a GET to a
//     registered path, checked at runtime and by scanning the source. Keys
//     can't report their access level, so reads are proven, not scopes.
//   · THE ARITHMETIC AND THE SYNC. Sales statuses only, refunds netted,
//     units by product, a year in windows, the last 30 days re-read.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Observation, Provider, PullPage } from "./provider";
import { ProviderError } from "./provider";
import {
  WOO_BACKFILL_DAYS,
  WOO_MAX_ATTEMPTS,
  WOO_READ_ENDPOINTS,
  WOO_REREAD_DAYS,
  WOO_WINDOW_DAYS,
  createWooCommerceProvider,
  isForbiddenHost,
  parseWooCredential,
} from "./providers/woocommerce";
import type { FakeWoo } from "./providers/woocommerce-fake";
import {
  FAKE_WOO_CREDENTIAL,
  FAKE_WOO_SECRET,
  fakeWoo,
  wooJson,
  wooOrder,
} from "./providers/woocommerce-fake";
import { SCOPE_REGISTRY } from "./scopes";

const NOW = new Date("2026-09-14T12:00:00Z");

function woo(options: Parameters<typeof fakeWoo>[0] = {}): { fake: FakeWoo; provider: Provider } {
  const fake = fakeWoo(options);
  return {
    fake,
    provider: createWooCommerceProvider({ fetch: fake.fetch, sleep: async () => {} }),
  };
}

async function runToDone(provider: Provider, cursor: string | null = null): Promise<PullPage[]> {
  const pages: PullPage[] = [];
  let at = cursor;
  for (let i = 0; i < 100; i += 1) {
    const page = await provider.pull(FAKE_WOO_SECRET, at, NOW);
    pages.push(page);
    at = page.cursor;
    if (page.done) break;
  }
  return pages;
}

const revenueOf = (obs: readonly Observation[], currency: string): number =>
  obs
    .filter((o) => o.metric_key === "revenue.daily" && o.dimensions.currency === currency)
    .reduce((sum, o) => sum + (o.value_minor ?? 0), 0);
const ordersOf = (obs: readonly Observation[]): number =>
  obs.filter((o) => o.metric_key === "orders.daily").reduce((s, o) => s + (o.value_num ?? 0), 0);
const unitsOf = (obs: readonly Observation[], ref: string): number =>
  obs
    .filter((o) => o.metric_key === "units.daily" && o.dimensions.product_ref === ref)
    .reduce((s, o) => s + (o.value_num ?? 0), 0);
const orderDays = (obs: readonly Observation[]): string[] =>
  obs.filter((o) => o.metric_key === "orders.daily").map((o) => o.period_date);

const secretWith = (overrides: Record<string, string>): string =>
  JSON.stringify({ ...FAKE_WOO_CREDENTIAL, ...overrides });

describe("P2-17 — the address guard", () => {
  it("keeps a WordPress sub-path and drops the trailing slash", () => {
    expect(parseWooCredential(secretWith({ site_url: "https://example.com/shop/" })).base).toBe(
      "https://example.com/shop",
    );
  });

  it("refuses addresses this server must never call", () => {
    for (const site_url of [
      "http://shop.example.com",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://localhost",
      "https://db.internal",
      "https://printer.local",
      "https://intranet",
      "https://[::1]",
      "https://user:pass@shop.example.com",
      "not a url",
    ]) {
      expect(() => parseWooCredential(secretWith({ site_url })), site_url).toThrow(ProviderError);
    }
    expect(isForbiddenHost("shop.example.com")).toBe(false);
  });

  it("refuses keys that aren't WooCommerce consumer keys", () => {
    expect(() => parseWooCredential(secretWith({ consumer_key: "sk_live_x" }))).toThrow(/ck_/);
    expect(() => parseWooCredential(secretWith({ consumer_secret: "hunter2" }))).toThrow(/cs_/);
  });

  it("a refused address sends no request", async () => {
    const { fake, provider } = woo();
    await expect(provider.connect(secretWith({ site_url: "https://localhost" }))).rejects.toThrow(
      ProviderError,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("P2-17 — connecting proves both reads", () => {
  it("probes orders and products, and reports the proven capabilities", async () => {
    const { fake, provider } = woo();
    const result = await provider.connect(FAKE_WOO_SECRET);
    expect(result.granted_scopes).toEqual([...SCOPE_REGISTRY.woocommerce]);
    expect(fake.calls.map((c) => c.url.pathname)).toEqual(Object.values(WOO_READ_ENDPOINTS));
    expect(fake.calls.every((c) => c.url.searchParams.get("per_page") === "1")).toBe(true);
  });

  it("a rejected key is reported as such, and the error never repeats it", async () => {
    const { provider } = woo();
    try {
      await provider.connect(secretWith({ consumer_key: "ck_wrong", consumer_secret: "cs_wrong" }));
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/not accepted/);
      expect((error as Error).message).not.toContain("ck_wrong");
    }
  });

  it("a key without read access surfaces the store's own message", async () => {
    const { provider } = woo({
      respond: () =>
        wooJson(403, {
          code: "woocommerce_rest_cannot_view",
          message: "Sorry, you cannot list resources.",
        }),
    });
    await expect(provider.connect(FAKE_WOO_SECRET)).rejects.toThrow(/The store says: Sorry/);
  });

  it("a site without the WooCommerce API is named as the likely problem", async () => {
    const { provider } = woo({ respond: () => wooJson(404, { code: "rest_no_route" }) });
    await expect(provider.connect(FAKE_WOO_SECRET)).rejects.toThrow(/wasn't found at this address/);
  });
});

describe("rule 9 — the connector can only read", () => {
  it("every request is a GET to a registered path on the owner's store", async () => {
    const { fake, provider } = woo({
      orders: [wooOrder("2026-03-01T10:00:00", "40.00", [{ product_id: 7, quantity: 1 }])],
      products: [{ id: 7, name: "Candle", status: "publish" }],
    });
    await provider.connect(FAKE_WOO_SECRET);
    await runToDone(provider);
    await provider.listProducts?.(FAKE_WOO_SECRET);

    const allowed: string[] = Object.values(WOO_READ_ENDPOINTS);
    expect(fake.calls.length).toBeGreaterThan(10);
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.url.origin).toBe(FAKE_WOO_CREDENTIAL.site_url);
      expect(allowed).toContain(call.url.pathname);
    }
  });

  it("THE BUILD GATE: the source names no other verb and sets no other method", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./providers/woocommerce.ts", import.meta.url)),
      "utf8",
    );
    expect(source).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    const methods = [...source.matchAll(/method:\s*([^,;\n}]+)/g)].map((m) => m[1]?.trim());
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) expect(['"GET"', "init.method"]).toContain(method);
  });
});

describe("P2-17 — the arithmetic", () => {
  it("counts sales statuses only, nets refunds, and sums units by product", async () => {
    const { provider } = woo({
      orders: [
        wooOrder("2026-09-10T09:00:00", "100.00", [{ product_id: 7, quantity: 2 }]),
        wooOrder("2026-09-10T10:00:00", "50.00", [{ product_id: 7, quantity: 1 }], {
          status: "processing",
          refunds: [{ total: "-20.00" }],
        }),
        wooOrder("2026-09-10T11:00:00", "30.00", [], {
          status: "refunded",
          refunds: [{ total: "-30.00" }],
        }),
        wooOrder("2026-09-10T12:00:00", "999.00", [], { status: "cancelled" }),
        wooOrder("2026-09-10T13:00:00", "999.00", [], { status: "pending" }),
        wooOrder("2026-09-10T14:00:00", "999.00", [], { status: "failed" }),
        wooOrder("2026-09-10T23:59:59", "15.00", [{ product_id: 8, quantity: 3 }], {
          currency: "USD",
        }),
        wooOrder("2026-09-11T00:00:00", "5.00", [{ product_id: 0, quantity: 1 }]),
      ],
    });
    const all = (await runToDone(provider)).flatMap((p) => p.observations);
    const day = (d: string) => all.filter((o) => o.period_date === d);

    expect(revenueOf(day("2026-09-10"), "EUR")).toBe(10_000 + 3_000 + 0);
    expect(revenueOf(day("2026-09-10"), "USD")).toBe(1_500);
    expect(ordersOf(day("2026-09-10"))).toBe(4);
    expect(revenueOf(day("2026-09-11"), "EUR")).toBe(500);
    expect(unitsOf(all, "7")).toBe(3);
    expect(unitsOf(all, "8")).toBe(3);
    expect(all.some((o) => o.dimensions.product_ref === "0")).toBe(false);
  });
});

describe("P2-17 — backfill and sync", () => {
  it("reads a year in 30-day windows, following X-WP-TotalPages", async () => {
    const busy = Array.from({ length: 230 }, (_, i) =>
      wooOrder(`2026-03-15T${String(i % 24).padStart(2, "0")}:00:00`, "1.00"),
    );
    const { fake, provider } = woo({ orders: [wooOrder("2025-09-01T10:00:00", "99.00"), ...busy] });
    const pages = await runToDone(provider);
    const all = pages.flatMap((p) => p.observations);

    expect(pages).toHaveLength(Math.ceil(WOO_BACKFILL_DAYS / WOO_WINDOW_DAYS));
    expect(orderDays(all)).toHaveLength(WOO_BACKFILL_DAYS);
    expect(ordersOf(all)).toBe(230); // the 2025-09-01 order is more than a year old
    expect(fake.calls.some((c) => c.url.searchParams.get("page") === "3")).toBe(true);
    expect(pages.at(-1)).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("a daily run re-reads the last 30 days", async () => {
    const { provider } = woo();
    const page = await provider.pull(FAKE_WOO_SECRET, "2026-09-12", NOW);
    expect(orderDays(page.observations)).toHaveLength(WOO_REREAD_DAYS);
    expect(page).toMatchObject({ cursor: "2026-09-13", done: true });
  });

  it("server errors retry to the cap, then fail", async () => {
    const { fake, provider } = woo({ respond: () => wooJson(503, { message: "busy" }) });
    await expect(provider.connect(FAKE_WOO_SECRET)).rejects.toThrow(/status 503/);
    expect(fake.calls).toHaveLength(WOO_MAX_ATTEMPTS);
  });
});

describe("P2-15 — listing products", () => {
  it("returns every product across pages as string refs", async () => {
    const products = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      name: `Product ${i + 1}`,
      status: "publish",
    }));
    const { provider } = woo({ products });
    const listed = (await provider.listProducts?.(FAKE_WOO_SECRET)) ?? [];
    expect(listed).toHaveLength(150);
    expect(listed[149]).toEqual({ ref: "150", title: "Product 150", status: "publish" });
  });
});
