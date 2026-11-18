// A fake Shopify Admin API for the store-changes executor (D6). In memory, no
// network: it answers the token exchange and every document in
// SHOPIFY_WRITE_DOCUMENTS by name, records every request, and refuses any
// document it doesn't know — so a test notices if the executor sends one.

import type { ShopifyWriteFetch, ShopifyWriteResponse } from "./shopify";
import { SHOPIFY_WRITE_DOCUMENTS } from "./shopify";

export interface FakeVariant {
  id: string;
  price: string;
  compareAtPrice: string | null;
  unitCost: string | null;
}

export interface FakeProduct {
  id: string;
  title: string;
  status: string;
  options: { id: string; name: string; values: string[] }[];
  variants: FakeVariant[];
}

export interface FakePage {
  id: string;
  handle: string;
  body: string;
}

export interface FakeShopifyOptions {
  shop?: string;
  primaryHost?: string;
  currency?: string;
  scopes?: string[];
  pages?: FakePage[];
  products?: FakeProduct[];
  /** The bundle operation reports COMPLETE after this many polls. */
  bundlePolls?: number;
}

export function fakeShopify(opts: FakeShopifyOptions = {}) {
  const shop = opts.shop ?? "fern.myshopify.com";
  const currency = opts.currency ?? "EUR";
  const pages = new Map((opts.pages ?? []).map((p) => [p.id, { ...p }]));
  const products = new Map(
    (opts.products ?? []).map((p) => [p.id, structuredClone(p) as FakeProduct]),
  );
  const requests: { document: string; variables: Record<string, unknown> }[] = [];
  const operations = new Map<string, { polls: number; product: string }>();
  let nextId = 900;

  const ok = (data: unknown): ShopifyWriteResponse => ({
    status: 200,
    json: async () => ({ data }),
  });

  const productNode = (p: FakeProduct) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    options: p.options.map((o) => ({
      id: o.id,
      name: o.name,
      optionValues: o.values.map((name) => ({ name })),
    })),
    variants: {
      nodes: p.variants.map((v) => ({
        id: v.id,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inventoryItem: {
          unitCost: v.unitCost === null ? null : { amount: v.unitCost, currencyCode: currency },
        },
      })),
    },
  });

  const fetch: ShopifyWriteFetch = async (url, init) => {
    if (url === `https://${shop}/admin/oauth/access_token`) {
      return {
        status: 200,
        json: async () => ({
          access_token: "shpat_test",
          scope: (opts.scopes ?? ["write_products", "write_online_store_pages"]).join(","),
          expires_in: 86_399,
        }),
      };
    }
    if (!url.startsWith(`https://${shop}/admin/api/`)) throw new Error(`fake: unexpected ${url}`);
    const { query, variables } = JSON.parse(init.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const name = (
      Object.keys(SHOPIFY_WRITE_DOCUMENTS) as (keyof typeof SHOPIFY_WRITE_DOCUMENTS)[]
    ).find((k) => SHOPIFY_WRITE_DOCUMENTS[k] === query);
    if (!name) throw new Error("fake: a document that isn't on the list");
    requests.push({ document: name, variables });
    switch (name) {
      case "access_scopes":
        return ok({
          currentAppInstallation: {
            accessScopes: (opts.scopes ?? ["write_products", "write_online_store_pages"]).map(
              (handle) => ({ handle }),
            ),
          },
        });
      case "shop":
        return ok({
          shop: {
            myshopifyDomain: shop,
            currencyCode: currency,
            primaryDomain: { host: opts.primaryHost ?? "www.fernhill.test" },
          },
        });
      case "page_by_handle": {
        const handle = String(variables.query).replace(/^handle:/, "");
        return ok({ pages: { nodes: [...pages.values()].filter((p) => p.handle === handle) } });
      }
      case "page":
        return ok({ page: pages.get(String(variables.id)) ?? null });
      case "page_update": {
        const page = pages.get(String(variables.id));
        if (page) page.body = String((variables.page as { body: string }).body);
        return ok({ pageUpdate: { page: page ? { id: page.id } : null, userErrors: [] } });
      }
      case "product": {
        const p = products.get(String(variables.id));
        return ok({ product: p ? productNode(p) : null });
      }
      case "bundle_create": {
        const input = variables.input as { title: string };
        const id = `gid://shopify/Product/${(nextId += 1)}`;
        products.set(id, {
          id,
          title: input.title,
          status: "DRAFT",
          options: [],
          variants: [
            {
              id: `gid://shopify/ProductVariant/${nextId}`,
              price: "0.00",
              compareAtPrice: null,
              unitCost: null,
            },
          ],
        });
        const op = `gid://shopify/ProductBundleOperation/${nextId}`;
        operations.set(op, { polls: 0, product: id });
        return ok({
          productBundleCreate: {
            productBundleOperation: { id: op, status: "CREATED" },
            userErrors: [],
          },
        });
      }
      case "bundle_operation": {
        const op = operations.get(String(variables.id))!;
        op.polls += 1;
        const done = op.polls >= (opts.bundlePolls ?? 1);
        return ok({
          productOperation: {
            id: String(variables.id),
            status: done ? "COMPLETE" : "ACTIVE",
            product: done ? { id: op.product } : null,
            userErrors: [],
          },
        });
      }
      case "variants_update": {
        const p = products.get(String(variables.productId))!;
        for (const v of variables.variants as {
          id: string;
          price: string;
          compareAtPrice: string | null;
        }[]) {
          const live = p.variants.find((x) => x.id === v.id)!;
          live.price = v.price;
          live.compareAtPrice = v.compareAtPrice;
        }
        return ok({ productVariantsBulkUpdate: { productVariants: [], userErrors: [] } });
      }
      case "product_status": {
        const { id, status } = variables.product as { id: string; status: string };
        const p = products.get(id)!;
        p.status = status;
        return ok({ productUpdate: { product: { id, status }, userErrors: [] } });
      }
    }
  };

  return { fetch, requests, pages, products, shop };
}
