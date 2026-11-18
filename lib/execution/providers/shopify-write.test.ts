// D6 — the Shopify store-changes executor against an in-memory fake Shopify
// and an in-memory backend. No network (the global fetch fails if touched),
// no database.
//
//   · the fence: four mutations, nothing naming checkout, payments, orders,
//     customers, shipping, taxes, discounts or deletion, only named fields
//   · the consent: the scopes Shopify reports, matched exactly
//   · each op: drift refused, done once, undone only while still SYB's
//   · the routes: built from the approved row, never a price from its detail

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capabilityOf } from "../../ledger/plans";
import { MAX_STATION } from "../../ladder/promotion";
import { MARKDOWN_SHARE_BP, SET_UP_YOURSELF, bundleTitle, shopPlanFor } from "../../shop/writes";
import { EXECUTION_SCOPE_REGISTRY, auditExecutionRegistry } from "../scopes";
import { OFFERED_EXECUTION, confirmationMatches } from "../setup";
import { verifyExecutionScopes } from "../verify";
import type { ExecutionContext, PreflightRefusal } from "./fixture";
import { executionProvider } from "./index";
import type { FakeProduct } from "./shopify-fake";
import { fakeShopify } from "./shopify-fake";
import type { ShopifyWriteBackend } from "./shopify";
import {
  SHOPIFY_FORBIDDEN,
  SHOPIFY_MUTATIONS,
  SHOPIFY_WRITE_DOCUMENTS,
  STOPPED_BEFORE_SHOPIFY,
  createShopifyWriteExecutor,
  impliedReadsDropped,
  markdownTargets,
  pageHandleOf,
  sha256,
  shopifyWriteExecutor,
  shopifyWriteVerifier,
  writeViolation,
} from "./shopify";

vi.spyOn(console, "log").mockImplementation(() => undefined);

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("network touched in a test");
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const CRED = { shop: "fern.myshopify.com", client_id: "cid", client_secret: "csecret" };
const A = "gid://shopify/Product/101";
const B = "gid://shopify/Product/102";

function product(
  id: string,
  title: string,
  prices: string[],
  unitCost: string | null = null,
): FakeProduct {
  return {
    id,
    title,
    status: "ACTIVE",
    options: [
      {
        id: `gid://shopify/ProductOption/${id.slice(-3)}`,
        name: "Title",
        values: ["Default Title"],
      },
    ],
    variants: prices.map((price, i) => ({
      id: `gid://shopify/ProductVariant/${id.slice(-3)}${i}`,
      price,
      compareAtPrice: null,
      unitCost,
    })),
  };
}

function setup(opts: Parameters<typeof fakeShopify>[0] = {}) {
  const fake = fakeShopify(opts);
  const undo = new Map<string, unknown>();
  const lines: string[] = [];
  const backend: ShopifyWriteBackend = {
    credential: async () => CRED,
    capturedUndo: async (id) => undo.get(id) ?? null,
    changed: async (_p, detail) => {
      lines.push(detail);
    },
  };
  const provider = createShopifyWriteExecutor({
    fetch: fake.fetch,
    sleep: async () => undefined,
    backend: async () => backend,
  });
  let n = 0;
  /** The engine's order: pre-flight, undo captured and stored, then execute. */
  const run = async (
    op: string,
    params: Record<string, unknown>,
    extra: Partial<ExecutionContext> = {},
  ): Promise<{
    refusal?: PreflightRefusal;
    result?: unknown;
    captured?: unknown;
    ctx: ExecutionContext;
  }> => {
    const ctx: ExecutionContext = {
      profile_id: "p",
      account_id: "a",
      execution_id: `e${(n += 1)}`,
      attempt: 1,
      ...extra,
    };
    const refusal = await provider.preflight!(op, params, ctx);
    if (refusal) return { refusal, ctx };
    const captured = await provider.captureUndo(op, params, ctx);
    undo.set(ctx.execution_id!, captured);
    const result = await provider.execute(op, params, ctx);
    return { result, captured, ctx };
  };
  const undoOf = (op: string, captured: unknown, result: unknown) =>
    provider.undo(op, captured, { profile_id: "p", account_id: "a", result });
  return { fake, provider, run, undoOf, lines, undo };
}

const mutationsSent = (fake: ReturnType<typeof fakeShopify>) =>
  fake.requests.filter((r) => SHOPIFY_MUTATIONS[r.document as keyof typeof SHOPIFY_MUTATIONS]);

describe("D6 — the registry and the consent (rules 13, 18)", () => {
  it("shopify_write: two write scopes, three reversible ops, offered with its own phrase", () => {
    const spec = EXECUTION_SCOPE_REGISTRY.shopify_write;
    expect([...spec.write_scopes]).toEqual(["write_products", "write_online_store_pages"]);
    expect(spec.readback_scopes).toEqual([]);
    expect(spec.operations.map((o) => [o.op, o.reversible])).toEqual([
      ["update_page_body", true],
      ["create_bundle", true],
      ["set_variant_price", true],
    ]);
    expect(OFFERED_EXECUTION).toContain("shopify_write");
    expect(confirmationMatches("shopify_write", "  Allow Shop Changes ")).toBe(true);
    expect(confirmationMatches("shopify_write", "yes")).toBe(false);
    expect(auditExecutionRegistry()).toEqual([]);
  });

  it("the exact match: a read beside its own write is implied; any other extra or a missing write is refused by name", () => {
    expect(
      impliedReadsDropped(["write_products", "read_products", "write_online_store_pages"]),
    ).toEqual(["write_online_store_pages", "write_products"]);
    expect(() =>
      verifyExecutionScopes(
        "shopify_write",
        impliedReadsDropped(["write_products", "write_online_store_pages"]),
      ),
    ).not.toThrow();
    expect(() =>
      verifyExecutionScopes(
        "shopify_write",
        impliedReadsDropped(["write_products", "write_online_store_pages", "read_orders"]),
      ),
    ).toThrow(/"read_orders"/);
    expect(() => verifyExecutionScopes("shopify_write", ["write_products"])).toThrow(
      /missing "write_online_store_pages"/,
    );
  });

  it("the verifier reads the installation's scopes from Shopify and refuses a bad store address before any request", async () => {
    const fake = fakeShopify({
      scopes: ["write_products", "read_products", "write_online_store_pages"],
    });
    const proof = await shopifyWriteVerifier({ fetch: fake.fetch })(JSON.stringify(CRED));
    expect(proof.granted_scopes).toEqual(["write_online_store_pages", "write_products"]);
    await expect(
      shopifyWriteVerifier({ fetch: fake.fetch })(
        JSON.stringify({ ...CRED, shop: "evil.example.com" }),
      ),
    ).rejects.toThrow(/myshopify\.com/);
  });

  it("is mapped, external, capped at station 3, and measured by what it changes", () => {
    expect(executionProvider("shopify_write")).toBe(shopifyWriteExecutor);
    expect(shopifyWriteExecutor.external).toBe(true);
    expect(MAX_STATION.shopify_write).toBe(3);
    expect(capabilityOf("shopify_write", "site", "update_page_body")).toBe("site_copy");
    expect(capabilityOf("shopify_write", "bundles", "create_bundle")).toBe("bundle");
    expect(capabilityOf("shopify_write", "stock", "set_variant_price")).toBe("price_change");
  });
});

describe("D6 — THE FENCE", () => {
  it("four mutations, and no document names a money surface, an order, a customer or a delete", () => {
    expect(SHOPIFY_MUTATIONS).toEqual({
      page_update: "pageUpdate",
      bundle_create: "productBundleCreate",
      variants_update: "productVariantsBulkUpdate",
      product_status: "productUpdate",
    });
    for (const [name, doc] of Object.entries(SHOPIFY_WRITE_DOCUMENTS)) {
      expect(doc, name).not.toMatch(SHOPIFY_FORBIDDEN);
      const isMutation = /^\s*mutation\b/.test(doc);
      expect(isMutation, name).toBe(name in SHOPIFY_MUTATIONS);
      if (isMutation)
        expect(doc).toContain(`${SHOPIFY_MUTATIONS[name as keyof typeof SHOPIFY_MUTATIONS]}(`);
    }
  });

  it("the forbidden vocabulary catches what it is for", () => {
    for (const planted of [
      "orderCancel",
      "discountCodeCreate",
      "productDelete",
      "customerUpdate",
      "checkoutCreate",
    ]) {
      expect(planted).toMatch(SHOPIFY_FORBIDDEN);
    }
  });

  it("only the named fields leave: a variant can't carry taxable, a product only id and status", () => {
    expect(
      writeViolation("variants_update", { variants: [{ id: "v", price: "1.00", taxable: false }] }),
    ).toMatch(/taxable/);
    expect(
      writeViolation("product_status", { product: { id: "p", status: "ACTIVE", title: "x" } }),
    ).toMatch(/title/);
    expect(writeViolation("product_status", { product: { id: "p", status: "DELETED" } })).toMatch(
      /only be set/,
    );
    expect(writeViolation("page_update", { id: "x", page: { body: "b", handle: "h" } })).toMatch(
      /handle/,
    );
    expect(writeViolation("page_update", { id: "x", page: { body: "b" } })).toBeNull();
  });

  it("no other source file sends a Shopify mutation", () => {
    const names = Object.values(SHOPIFY_MUTATIONS);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry.startsWith(".")) continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$|shopify-fake\.ts$/.test(entry)) {
          const src = readFileSync(path, "utf8");
          if (path.replace(/\\/g, "/").endsWith("lib/execution/providers/shopify.ts")) continue;
          if (/\bmutation\b[^\n]*\{/.test(src) && names.some((n) => src.includes(`${n}(`)))
            offenders.push(path);
        }
      }
    };
    walk("lib");
    walk("app");
    expect(offenders).toEqual([]);
  });
});

describe("D6 — update_page_body", () => {
  const page = {
    id: "gid://shopify/Page/7",
    handle: "about",
    body: "<p>Hand-thrown in Pest since 2019.</p>",
  };
  const params = {
    url: "https://www.fernhill.test/pages/about",
    find: "since 2019",
    replace: "since 2018",
  };

  it("changes the words on the page, once, and undo puts them back", async () => {
    const t = setup({ pages: [page] });
    const { result, captured } = await t.run("update_page_body", params);
    expect(t.fake.pages.get(page.id)!.body).toBe("<p>Hand-thrown in Pest since 2018.</p>");
    expect(result).toMatchObject({
      page_id: page.id,
      body_sha256: sha256("<p>Hand-thrown in Pest since 2018.</p>"),
    });
    expect(t.lines[0]).toMatch(/Changed the words on your page/);
    await t.undoOf("update_page_body", captured, result);
    expect(t.fake.pages.get(page.id)!.body).toBe(page.body);
  });

  it("only the store's own /pages/, on the connected store's domain", async () => {
    expect(pageHandleOf("https://x.test/pages/About-Us/")).toEqual({
      host: "x.test",
      handle: "about-us",
    });
    expect(pageHandleOf("https://x.test/products/mug")).toBeNull();
    const t = setup({ pages: [page] });
    const theme = await t.run("update_page_body", { ...params, url: "https://www.fernhill.test/" });
    expect(theme.refusal?.message).toMatch(/Only your store's own pages/);
    const elsewhere = await t.run("update_page_body", {
      ...params,
      url: "https://other.test/pages/about",
    });
    expect(elsewhere.refusal?.message).toMatch(/isn't the connected Shopify store/);
    expect(mutationsSent(t.fake)).toEqual([]);
  });

  it("drift: words gone or doubled refuse before anything; a page edited after the read refuses at the write", async () => {
    const gone = setup({ pages: [{ ...page, body: "<p>Hand-thrown.</p>" }] });
    expect((await gone.run("update_page_body", params)).refusal?.message).toMatch(
      /aren't on the page/,
    );
    const twice = setup({ pages: [{ ...page, body: "since 2019 and since 2019" }] });
    expect((await twice.run("update_page_body", params)).refusal?.message).toMatch(
      /more than once/,
    );

    const t = setup({ pages: [page] });
    const ctx = { profile_id: "p", account_id: "a", execution_id: "x1", attempt: 1 };
    const captured = await t.provider.captureUndo("update_page_body", params, ctx);
    t.undo.set("x1", captured);
    t.fake.pages.get(page.id)!.body = "<p>Edited by the owner since 2019.</p>";
    await expect(t.provider.execute("update_page_body", params, ctx)).rejects.toThrow(
      /changed in Shopify/,
    );
    expect(mutationsSent(t.fake)).toEqual([]);
  });

  it("undo refuses once someone else has edited the page since", async () => {
    const t = setup({ pages: [page] });
    const { result, captured } = await t.run("update_page_body", params);
    t.fake.pages.get(page.id)!.body = "<p>New words by the owner.</p>";
    await expect(t.undoOf("update_page_body", captured, result)).rejects.toThrow(
      /someone else's edit/,
    );
    expect(t.fake.pages.get(page.id)!.body).toBe("<p>New words by the owner.</p>");
  });

  it("the emergency stop before the write: nothing changes", async () => {
    const t = setup({ pages: [page] });
    await expect(t.run("update_page_body", params, { halted: async () => true })).rejects.toThrow(
      STOPPED_BEFORE_SHOPIFY,
    );
    expect(t.fake.pages.get(page.id)!.body).toBe(page.body);
  });
});

describe("D6 — create_bundle", () => {
  const params = { title: "Mug + Saucer", product_ids: [A, B], status: "ACTIVE" };

  it("one bundle product at the two items' full price, then archived (never deleted) by undo", async () => {
    const t = setup({ products: [product(A, "Mug", ["24.00"]), product(B, "Saucer", ["12.50"])] });
    const { result, captured } = await t.run("create_bundle", params);
    const id = (result as { product_id: string }).product_id;
    const bundle = t.fake.products.get(id)!;
    expect(bundle.variants[0]!.price).toBe("36.50");
    expect(bundle.status).toBe("ACTIVE");
    expect(t.fake.requests.filter((r) => r.document === "bundle_create")).toHaveLength(1);
    const sent = t.fake.requests.find((r) => r.document === "bundle_create")!.variables.input as {
      components: { productId: string; quantity: number }[];
    };
    expect(sent.components.map((c) => [c.productId, c.quantity])).toEqual([
      [A, 1],
      [B, 1],
    ]);
    // The two items themselves are untouched.
    expect(t.fake.products.get(A)!.variants[0]!.price).toBe("24.00");

    await t.undoOf("create_bundle", captured, result);
    expect(t.fake.products.get(id)!.status).toBe("ARCHIVED");
    expect(t.fake.products.has(id)).toBe(true);
  });

  it("a component at several prices has no one full price: refused, nothing created", async () => {
    const t = setup({
      products: [product(A, "Mug", ["24.00", "26.00"]), product(B, "Saucer", ["12.50"])],
    });
    const { refusal } = await t.run("create_bundle", params);
    expect(refusal?.message).toMatch(/"Mug" has variants at different prices/);
    expect(mutationsSent(t.fake)).toEqual([]);
  });

  it("never twice: a retry inside the run after the create was sent refuses", async () => {
    const t = setup({
      products: [product(A, "Mug", ["24.00"]), product(B, "Saucer", ["12.50"])],
      bundlePolls: 99,
    });
    const ctx = { profile_id: "p", account_id: "a", execution_id: "b1", attempt: 1 };
    t.undo.set("b1", await t.provider.captureUndo("create_bundle", params, ctx));
    await expect(t.provider.execute("create_bundle", params, ctx)).rejects.toThrow(
      /still making the bundle/,
    );
    await expect(
      t.provider.execute("create_bundle", params, { ...ctx, attempt: 2 }),
    ).rejects.toThrow(/may have created this bundle/);
    expect(t.fake.requests.filter((r) => r.document === "bundle_create")).toHaveLength(1);
  });
});

describe("D6 — set_variant_price (a slow-stock markdown)", () => {
  const params = { product_id: A, share_bp: 2500 };

  it("lowers every variant by the share, shows the old price as compare-at, and undo puts both back", async () => {
    const t = setup({ products: [product(A, "Mug", ["24.00", "20.00"], "8.00")] });
    const { result, captured } = await t.run("set_variant_price", params);
    const live = t.fake.products.get(A)!.variants;
    expect(live.map((v) => [v.price, v.compareAtPrice])).toEqual([
      ["18.00", "24.00"],
      ["15.00", "20.00"],
    ]);
    await t.undoOf("set_variant_price", captured, result);
    expect(t.fake.products.get(A)!.variants.map((v) => [v.price, v.compareAtPrice])).toEqual([
      ["24.00", null],
      ["20.00", null],
    ]);
  });

  it("bounds, each naming the number it hit: over 50%, below cost, a raise, already on sale", async () => {
    const t = setup({ products: [product(A, "Mug", ["24.00"], "20.00")] });
    expect(
      (await t.run("set_variant_price", { product_id: A, share_bp: 6000 })).refusal?.message,
    ).toMatch(/at most 50%.*60%/);
    expect((await t.run("set_variant_price", params)).refusal?.message).toMatch(
      /18\.00 EUR would be below the unit cost Shopify holds, 20\.00 EUR/,
    );
    expect(
      (await t.run("set_variant_price", { product_id: A, share_bp: -500 })).refusal?.message,
    ).toMatch(/lowers the price/);
    const sale = setup({
      products: [
        {
          ...product(A, "Mug", ["18.00"]),
          variants: [
            {
              id: "gid://shopify/ProductVariant/1",
              price: "18.00",
              compareAtPrice: "24.00",
              unitCost: null,
            },
          ],
        },
      ],
    });
    expect((await sale.run("set_variant_price", params)).refusal?.message).toMatch(
      /already on sale/,
    );
    expect(mutationsSent(t.fake)).toEqual([]);
  });

  it("a retry after Shopify's yes doesn't mark down twice: the baseline is the one captured before attempt one", async () => {
    const t = setup({ products: [product(A, "Mug", ["24.00"])] });
    const { ctx } = await t.run("set_variant_price", params);
    await t.provider.execute("set_variant_price", params, { ...ctx, attempt: 2 });
    expect(t.fake.products.get(A)!.variants[0]!.price).toBe("18.00");
    expect(t.fake.requests.filter((r) => r.document === "variants_update")).toHaveLength(1);
  });

  it("drift: the owner changed the price after the read — nothing sent; after the markdown — undo refuses", async () => {
    const t = setup({ products: [product(A, "Mug", ["24.00"])] });
    const ctx = { profile_id: "p", account_id: "a", execution_id: "m1", attempt: 1 };
    t.undo.set("m1", await t.provider.captureUndo("set_variant_price", params, ctx));
    t.fake.products.get(A)!.variants[0]!.price = "22.00";
    await expect(t.provider.execute("set_variant_price", params, ctx)).rejects.toThrow(
      /prices changed in Shopify/,
    );
    expect(mutationsSent(t.fake)).toEqual([]);

    const u = setup({ products: [product(A, "Mug", ["24.00"])] });
    const { result, captured } = await u.run("set_variant_price", params);
    u.fake.products.get(A)!.variants[0]!.price = "16.00";
    await expect(u.undoOf("set_variant_price", captured, result)).rejects.toThrow(/someone else's/);
    expect(u.fake.products.get(A)!.variants[0]!.price).toBe("16.00");
  });

  it("markdownTargets is exact minor-unit arithmetic (rule 1)", () => {
    expect(
      markdownTargets(
        [{ id: "v", price_minor: 999, compare_at_minor: null, unit_cost_minor: null }],
        2500,
        "EUR",
      ),
    ).toEqual([{ id: "v", from_minor: 999, to_minor: 749 }]);
  });
});

describe("D6 — the routes: from the approved row, never a price from its detail", () => {
  const stock = (detail: Record<string, unknown>, ref: string) => ({
    module: "stock",
    originating_finding: ref,
    action: { kind: "discount_or_promotion", summary: "s", detail },
  });

  it("a markdown with its product runs at CLEARANCE's share whatever the detail says", () => {
    const routed = shopPlanFor(
      stock(
        { option: "markdown", shopify: { product_id: A }, share_bp: 9000 },
        `stock:markdown:c:${A}:2026-11`,
      ),
    );
    expect(routed).toEqual({
      plan: {
        provider: "shopify_write",
        op: "set_variant_price",
        params: { product_id: A, share_bp: MARKDOWN_SHARE_BP },
      },
    });
    expect(MARKDOWN_SHARE_BP).toBe(2500);
  });

  it("a pair (bundles, or a slow item's) becomes create_bundle; one made before the connection is unroutable, named", () => {
    const pair = {
      module: "bundles",
      originating_finding: "bundle:k:2026-11",
      action: {
        kind: "offer_change",
        summary: "s",
        detail: { shopify: { products: [A, B], title: "Mug + Saucer" } },
      },
    };
    expect(shopPlanFor(pair)).toEqual({
      plan: {
        provider: "shopify_write",
        op: "create_bundle",
        params: { title: "Mug + Saucer", product_ids: [A, B], status: "ACTIVE" },
      },
    });
    expect(shopPlanFor({ ...pair, action: { ...pair.action, detail: {} } })).toEqual({
      unroutable: SET_UP_YOURSELF,
    });
    expect(
      shopPlanFor(
        stock(
          { option: "bundle", shopify: { products: [A, "not-an-id"], title: "x" } },
          "stock:bundle:c:r:2026-11",
        ),
      ),
    ).toEqual({ unroutable: SET_UP_YOURSELF });
    expect(shopPlanFor(stock({ option: "markdown" }, "stock:markdown:c:r:2026-11"))).toEqual({
      unroutable: SET_UP_YOURSELF,
    });
  });

  it("anything else is not a shop change", () => {
    expect(shopPlanFor(stock({ option: "content" }, "stock:content:c:r:2026-11"))).toBeNull();
    expect(shopPlanFor({ module: "site", originating_finding: null, action: {} })).toBeNull();
    expect(bundleTitle(" Mug ", "Saucer")).toBe("Mug + Saucer");
    expect(bundleTitle("a".repeat(200), "b".repeat(100))).toHaveLength(255);
  });
});
