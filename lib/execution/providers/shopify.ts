// The Shopify store-changes executor — D6 (owner, 2026-11-16: "make all these
// automatic all the owner should do is just approve", then "Shopify first").
//
// THE ONLY FILE THAT MAY SEND A SHOPIFY MUTATION. The read connector
// (lib/connectors/providers/shopify.ts) sends read queries only and its own
// build gate refuses the word "mutation"; this file sends exactly the
// documents in SHOPIFY_WRITE_DOCUMENTS — four mutations and the reads they
// need — and shopify-write.test.ts fails the build if another document, a
// fifth mutation, or any document naming checkout, payments, orders,
// customers, shipping, taxes, billing, fulfillment, discounts or deletion
// appears (rule 18). Every variables object is checked again at the one
// request choke point (writeViolation): a page update carries only `body`,
// a variant update only `id`, `price` and `compareAtPrice`, a product update
// only `id` and `status` (ACTIVE / DRAFT / ARCHIVED), a bundle only `title`
// and its components.
//
// Reached only through the engine, so every change inherits a recorded
// approval (rule 12), the emergency stop, one execution row per approval,
// the journal, the undo captured before attempt one (rule 16), and the
// real-write gate: `external: true`, so with SESSION_D_REAL_WRITES anything
// but "on" nothing here is even read. Capped at station 3 on the trust
// ladder (lib/ladder/promotion MAX_STATION): price-adjacent, never without
// the yes.
//
// THREE OPS, each reversible:
//   update_page_body   pageUpdate(body)            undo: the body before, while the live
//                                                  body is still exactly what SYB wrote
//   create_bundle      productBundleCreate, then   undo: archive the product SYB created
//                      the bundle's price set to       (never delete — the fence refuses it)
//                      the components' full price
//   set_variant_price  productVariantsBulkUpdate   undo: every variant's price and
//                      price ↓ by the share, the       compare-at price as they were, while
//                      old price as compare-at         they are still what SYB set
//
// Every op re-reads what it changes before it writes (drift), and refuses by
// name when the live value is not what the approval was about. Shapes are
// in specs/shopify-admin-api-v1.md, each fact marked verified true/false.
//
// The credential is the owner's OWN Dev Dashboard app (the read connector's
// route, 2026): store address, client ID, client secret, swapped for a
// 24-hour token with the client credentials grant. A second app, not the
// read one: a measurement connection can never hold a write scope (rule 9).
//
// This file holds no database import (the provider map stays importable
// without one): the credential, the stored undo and the watch-log line come
// from ShopifyWriteBackend (lib/shop/writes.ts), loaded on first use.

import { createHash } from "node:crypto";
import { DecimalError, decimalToMinor } from "../../connectors/decimal";
import type { ShopifyCredential } from "../../connectors/providers/shopify";
import { SHOPIFY_API_VERSION, parseShopifyCredential } from "../../connectors/providers/shopify";
import { money, scaleMinorBy, toDecimalString } from "../../core/money";
import type { CredentialProof } from "../verify";
import { ExecutionConnectionError } from "../verify";
import type { ExecutionContext, ExecutionProvider, PreflightRefusal } from "./fixture";

export const SHOPIFY_WRITE_VERSION = SHOPIFY_API_VERSION;

/** Every document this file can send. Four mutations; everything else reads. */
export const SHOPIFY_WRITE_DOCUMENTS = {
  access_scopes: `query AccessScopes {
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}`,
  shop: `query Shop {
  shop {
    myshopifyDomain
    currencyCode
    primaryDomain {
      host
    }
  }
}`,
  page_by_handle: `query PageByHandle($query: String!) {
  pages(first: 2, query: $query) {
    nodes {
      id
      handle
      body
    }
  }
}`,
  page: `query Page($id: ID!) {
  page(id: $id) {
    id
    handle
    body
  }
}`,
  product: `query Product($id: ID!) {
  product(id: $id) {
    id
    title
    status
    options {
      id
      name
      optionValues {
        name
      }
    }
    variants(first: 100) {
      nodes {
        id
        price
        compareAtPrice
        inventoryItem {
          unitCost {
            amount
            currencyCode
          }
        }
      }
    }
  }
}`,
  bundle_operation: `query BundleOperation($id: ID!) {
  productOperation(id: $id) {
    ... on ProductBundleOperation {
      id
      status
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
}`,
  page_update: `mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
  pageUpdate(id: $id, page: $page) {
    page {
      id
    }
    userErrors {
      field
      message
    }
  }
}`,
  bundle_create: `mutation BundleCreate($input: ProductBundleCreateInput!) {
  productBundleCreate(input: $input) {
    productBundleOperation {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}`,
  variants_update: `mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) {
    productVariants {
      id
      price
      compareAtPrice
    }
    userErrors {
      field
      message
    }
  }
}`,
  product_status: `mutation ProductStatus($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}`,
} as const;

export type ShopifyWriteDocument = keyof typeof SHOPIFY_WRITE_DOCUMENTS;

/** The four mutations, by the root field each calls. shopify-write.test.ts pins this. */
export const SHOPIFY_MUTATIONS: Readonly<Partial<Record<ShopifyWriteDocument, string>>> = {
  page_update: "pageUpdate",
  bundle_create: "productBundleCreate",
  variants_update: "productVariantsBulkUpdate",
  product_status: "productUpdate",
};

/** Rule 18 and "never delete", as vocabulary no document may contain. */
export const SHOPIFY_FORBIDDEN =
  /checkout|payment|order|customer|shipping|tax|billing|fulfil|discount|delete|refund|gift/i;

/** What a markdown may never pass, in basis points of the price (one approval). */
export const SHOPIFY_MARKDOWN = { max_share_bp: 5000 } as const;

/** Statuses SYB may set on a product. */
export const PRODUCT_STATUSES: readonly string[] = ["ACTIVE", "DRAFT", "ARCHIVED"];

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20_000;
const BUNDLE_POLLS = 10;

/* ── errors the engine reads ── */

/** A refusal or failure in the owner's words. `retryable` tells the engine's loop. */
export class ShopifyChangeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ShopifyChangeError";
    this.retryable = retryable;
  }
}

export const STOPPED_BEFORE_SHOPIFY =
  "The emergency stop came on before the change was sent to Shopify. Nothing was changed.";

/* ── the one way out ── */

export interface ShopifyWriteResponse {
  status: number;
  json(): Promise<unknown>;
}

export type ShopifyWriteFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<ShopifyWriteResponse>;

/**
 * Pure: why these variables may not go with this document, or null. The
 * second wall behind the fixed documents: only the fields SYB means to
 * write ever leave.
 */
export function writeViolation(name: ShopifyWriteDocument, variables: unknown): string | null {
  const v = (variables ?? {}) as Record<string, unknown>;
  const only = (obj: unknown, keys: readonly string[], what: string): string | null => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj))
      return `${what} is not an object`;
    const extra = Object.keys(obj).filter((k) => !keys.includes(k));
    return extra.length === 0 ? null : `${what} may not carry ${extra.join(", ")}`;
  };
  switch (name) {
    case "page_update":
      return only(v.page, ["body"], "a page update");
    case "variants_update": {
      if (!Array.isArray(v.variants) || v.variants.length === 0)
        return "a price change names no variant";
      for (const variant of v.variants) {
        const why = only(variant, ["id", "price", "compareAtPrice"], "a variant update");
        if (why) return why;
      }
      return null;
    }
    case "product_status": {
      const why = only(v.product, ["id", "status"], "a product update");
      if (why) return why;
      const status = (v.product as { status?: unknown }).status;
      return typeof status === "string" && PRODUCT_STATUSES.includes(status)
        ? null
        : `a product may only be set ${PRODUCT_STATUSES.join(", ")}`;
    }
    case "bundle_create": {
      const why = only(v.input, ["title", "components"], "a bundle");
      if (why) return why;
      const components = (v.input as { components?: unknown }).components;
      if (!Array.isArray(components) || components.length < 2)
        return "a bundle needs two components";
      for (const c of components) {
        const w = only(c, ["productId", "quantity", "optionSelections"], "a bundle component");
        if (w) return w;
      }
      return null;
    }
    default:
      return null;
  }
}

interface Token {
  value: string;
  scopes: string[];
  expiresAt: number;
}

export interface ShopifyWriteOptions {
  fetch?: ShopifyWriteFetch;
  sleep?: (ms: number) => Promise<void>;
  backend?: () => Promise<ShopifyWriteBackend>;
}

const liveFetch: ShopifyWriteFetch = async (url, init) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { status: res.status, json: () => res.json() };
};

const splitScopes = (scope: unknown): string[] =>
  typeof scope === "string"
    ? scope
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : [];

/**
 * A write scope grants its read (Shopify's access-scope page, read
 * 2026-11-16), and Shopify may report both. The read beside its own write
 * is dropped before the exact match, so neither "write_products" alone nor
 * "write_products + read_products" is refused for the read; any other extra
 * still is.
 */
export function impliedReadsDropped(scopes: readonly string[]): string[] {
  const set = new Set(scopes);
  return [...set].filter((s) => !(s.startsWith("read_") && set.has(`write_${s.slice(5)}`))).sort();
}

class ShopifyClient {
  private tokens = new Map<string, Token>();
  constructor(
    private readonly fetchImpl: ShopifyWriteFetch,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async token(cred: ShopifyCredential, fresh = false): Promise<Token> {
    const key = `${cred.shop}|${cred.client_id}`;
    const cached = this.tokens.get(key);
    if (!fresh && cached && cached.expiresAt - 60_000 > Date.now()) return cached;
    for (let attempt = 1; ; attempt += 1) {
      let res: ShopifyWriteResponse;
      try {
        res = await this.fetchImpl(`https://${cred.shop}/admin/oauth/access_token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: cred.client_id,
            client_secret: cred.client_secret,
          }).toString(),
        });
      } catch {
        if (attempt >= MAX_ATTEMPTS) {
          throw new ShopifyChangeError("Shopify couldn't be reached. Nothing was changed.", true);
        }
        await this.sleep(1000 * attempt);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        await this.sleep(1000 * attempt);
        continue;
      }
      if (res.status !== 200) {
        throw new ShopifyChangeError(
          "Shopify didn't accept ScaleX's store-changes app. Check the app is installed on the store, then reconnect it on Connections. Nothing was changed.",
        );
      }
      const body = (await res.json().catch(() => null)) as {
        access_token?: unknown;
        scope?: unknown;
        expires_in?: unknown;
      } | null;
      if (typeof body?.access_token !== "string" || body.access_token === "") {
        throw new ShopifyChangeError("Shopify's answer had no access token. Nothing was changed.");
      }
      const token: Token = {
        value: body.access_token,
        scopes: splitScopes(body.scope),
        expiresAt:
          Date.now() + (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
      };
      this.tokens.set(key, token);
      return token;
    }
  }

  /**
   * One document. A read retries to the cap; a mutation is sent once unless
   * `idempotent` says sending it again sets the same value (a body, a price,
   * a status) — productBundleCreate is never sent twice.
   */
  async call(
    cred: ShopifyCredential,
    name: ShopifyWriteDocument,
    variables: Record<string, unknown>,
    opts: { idempotent?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const violation = writeViolation(name, variables);
    if (violation !== null) {
      throw new ShopifyChangeError(
        `ScaleX refused its own request: ${violation}. Nothing was sent.`,
      );
    }
    const isMutation = SHOPIFY_MUTATIONS[name] !== undefined;
    const repeatable = !isMutation || opts.idempotent === true;
    const url = `https://${cred.shop}/admin/api/${SHOPIFY_WRITE_VERSION}/graphql.json`;
    let fresh = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.token(cred, fresh);
      fresh = false;
      let res: ShopifyWriteResponse;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-shopify-access-token": token.value,
          },
          body: JSON.stringify({ query: SHOPIFY_WRITE_DOCUMENTS[name], variables }),
        });
      } catch {
        if (repeatable && attempt < MAX_ATTEMPTS) {
          await this.sleep(1000 * attempt);
          continue;
        }
        throw new ShopifyChangeError(
          isMutation
            ? "Shopify didn't answer, so ScaleX can't tell whether the change went through. Check the item in Shopify; nothing will be sent again by itself."
            : "Shopify couldn't be reached. Nothing was changed.",
          !isMutation,
        );
      }
      if (res.status === 401 && attempt < MAX_ATTEMPTS) {
        fresh = true; // the 24-hour token lapsed: exchange again, nothing was done
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyChangeError(
          "Shopify stopped accepting ScaleX's store-changes app. Reconnect it on Connections; nothing was changed.",
        );
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        if (res.status === 429 || repeatable) {
          await this.sleep(1000 * attempt);
          continue;
        }
      }
      if (res.status !== 200) {
        throw new ShopifyChangeError(
          isMutation && res.status >= 500
            ? "Shopify failed while making the change, so ScaleX can't tell whether it went through. Check the item in Shopify; nothing will be sent again by itself."
            : `Shopify answered ${res.status}. Nothing was changed.`,
        );
      }
      const body = (await res.json().catch(() => null)) as {
        data?: unknown;
        errors?: { message?: unknown; extensions?: { code?: unknown } }[];
      } | null;
      const errors = Array.isArray(body?.errors) ? body.errors : [];
      if (errors.some((e) => e?.extensions?.code === "THROTTLED")) {
        // Throttled requests are not executed (Shopify's rate-limit page), so a resend is safe.
        if (attempt < MAX_ATTEMPTS) {
          await this.sleep(2000 * attempt);
          continue;
        }
        throw new ShopifyChangeError(
          "Shopify is limiting ScaleX's requests right now. Nothing was changed; it goes again on the next run.",
          true,
        );
      }
      if (errors.some((e) => e?.extensions?.code === "ACCESS_DENIED")) {
        throw new ShopifyChangeError(
          "Shopify refused: the store-changes app is missing a permission this change needs. Nothing was changed.",
        );
      }
      if (errors.length > 0) {
        const message = errors
          .map((e) => (typeof e?.message === "string" ? e.message : "unknown error"))
          .join("; ");
        throw new ShopifyChangeError(`Shopify refused: ${message}. Nothing was changed.`);
      }
      if (body?.data === null || typeof body?.data !== "object") {
        throw new ShopifyChangeError(
          "Shopify's answer had an unexpected shape. Nothing was changed.",
        );
      }
      return body.data as Record<string, unknown>;
    }
  }
}

/** Pure: a mutation's userErrors as one owner sentence, or null. */
function userErrorsOf(payload: unknown): string | null {
  const errors = (payload as { userErrors?: { message?: unknown }[] } | null)?.userErrors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((e) => (typeof e?.message === "string" ? e.message : "an error")).join("; ");
}

/* ── the database side, injected ── */

export interface ShopifyWriteBackend {
  credential(accountId: string): Promise<ShopifyCredential | { refused: string }>;
  /** The undo payload the engine stored before attempt one — a markdown's baseline. */
  capturedUndo(executionId: string): Promise<unknown>;
  /** One watch-log line for the owner. */
  changed(profileId: string, detail: string, meta: Record<string, unknown>): Promise<void>;
}

/* ── what the ops read ── */

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const GID = {
  page: /^gid:\/\/shopify\/Page\/\d+$/,
  product: /^gid:\/\/shopify\/Product\/\d+$/,
  variant: /^gid:\/\/shopify\/ProductVariant\/\d+$/,
} as const;

/** Pure: a page URL's handle, when the URL is one of the store's own pages (/pages/<handle>). */
export function pageHandleOf(url: string): { host: string; handle: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = /^\/pages\/([a-z0-9][a-z0-9-]*)\/?$/i.exec(u.pathname);
  return m?.[1] ? { host: u.hostname.toLowerCase(), handle: m[1].toLowerCase() } : null;
}

interface LiveVariant {
  id: string;
  price_minor: number;
  compare_at_minor: number | null;
  unit_cost_minor: number | null;
}

interface LiveProduct {
  id: string;
  title: string;
  status: string;
  options: { id: string; name: string; values: string[] }[];
  variants: LiveVariant[];
}

function minorOf(amount: unknown, currency: string, what: string): number {
  if (typeof amount !== "string")
    throw new ShopifyChangeError(`Shopify sent no ${what}. Nothing was changed.`);
  try {
    return decimalToMinor(amount, currency);
  } catch (error) {
    if (error instanceof DecimalError) {
      throw new ShopifyChangeError(
        `Shopify sent a ${what} ScaleX can't read exactly. Nothing was changed.`,
      );
    }
    throw error;
  }
}

function parseProduct(value: unknown, currency: string): LiveProduct | null {
  if (value === null || value === undefined) return null;
  const p = value as {
    id?: unknown;
    title?: unknown;
    status?: unknown;
    options?: { id?: unknown; name?: unknown; optionValues?: { name?: unknown }[] }[];
    variants?: { nodes?: unknown[] };
  };
  if (typeof p.id !== "string" || typeof p.title !== "string" || typeof p.status !== "string") {
    throw new ShopifyChangeError(
      "Shopify's product answer had an unexpected shape. Nothing was changed.",
    );
  }
  const variants = (p.variants?.nodes ?? []).map((n) => {
    const v = n as {
      id?: unknown;
      price?: unknown;
      compareAtPrice?: unknown;
      inventoryItem?: { unitCost?: { amount?: unknown; currencyCode?: unknown } | null } | null;
    };
    if (typeof v.id !== "string" || !GID.variant.test(v.id)) {
      throw new ShopifyChangeError(
        "Shopify's variant answer had an unexpected shape. Nothing was changed.",
      );
    }
    const cost = v.inventoryItem?.unitCost;
    return {
      id: v.id,
      price_minor: minorOf(v.price, currency, "price"),
      compare_at_minor:
        v.compareAtPrice === null || v.compareAtPrice === undefined
          ? null
          : minorOf(v.compareAtPrice, currency, "compare-at price"),
      // A cost in another currency is never converted (rule 1): it is unknown here.
      unit_cost_minor:
        cost && cost.currencyCode === currency ? minorOf(cost.amount, currency, "unit cost") : null,
    };
  });
  return {
    id: p.id,
    title: p.title,
    status: p.status,
    options: (p.options ?? []).map((o) => ({
      id: typeof o.id === "string" ? o.id : "",
      name: typeof o.name === "string" ? o.name : "",
      values: (o.optionValues ?? [])
        .map((x) => x.name)
        .filter((x): x is string => typeof x === "string"),
    })),
    variants,
  };
}

const decimal = (minor: number, currency: string) => toDecimalString(money(minor, currency));

/* ── params ── */

interface PageParams {
  url: string;
  find: string;
  replace: string;
}
interface BundleParams {
  title: string;
  product_ids: [string, string];
  status: "ACTIVE" | "DRAFT";
}
interface MarkdownParams {
  product_id: string;
  share_bp: number;
}

function pageParams(params: Record<string, unknown>): PageParams {
  const { url, find, replace } = params;
  if (
    typeof url !== "string" ||
    typeof find !== "string" ||
    typeof replace !== "string" ||
    find === ""
  ) {
    throw new ShopifyChangeError("The page change names no page or no words. Nothing was changed.");
  }
  return { url, find, replace };
}

function bundleParams(params: Record<string, unknown>): BundleParams {
  const { title, product_ids, status } = params;
  if (
    typeof title !== "string" ||
    title.trim() === "" ||
    title.length > 255 ||
    !Array.isArray(product_ids) ||
    product_ids.length !== 2 ||
    !product_ids.every((id) => typeof id === "string" && GID.product.test(id)) ||
    product_ids[0] === product_ids[1] ||
    (status !== "ACTIVE" && status !== "DRAFT")
  ) {
    throw new ShopifyChangeError("The bundle names no two Shopify products. Nothing was changed.");
  }
  return { title: title.trim(), product_ids: [product_ids[0], product_ids[1]], status };
}

function markdownParams(params: Record<string, unknown>): MarkdownParams {
  const { product_id, share_bp } = params;
  if (typeof product_id !== "string" || !GID.product.test(product_id)) {
    throw new ShopifyChangeError("The markdown names no Shopify product. Nothing was changed.");
  }
  if (typeof share_bp !== "number" || !Number.isSafeInteger(share_bp) || share_bp <= 0) {
    throw new ShopifyChangeError(
      "A markdown lowers the price; this one doesn't. Nothing was changed.",
    );
  }
  if (share_bp > SHOPIFY_MARKDOWN.max_share_bp) {
    throw new ShopifyChangeError(
      `A markdown is at most ${SHOPIFY_MARKDOWN.max_share_bp / 100}% per approval; this one is ${share_bp / 100}%. Nothing was changed.`,
    );
  }
  return { product_id, share_bp };
}

/**
 * Pure: the marked-down prices, or the owner's sentence naming the number a
 * variant hit. Never a raise, never below a known unit cost, never a variant
 * already showing a compare-at price (it is on sale already).
 */
export function markdownTargets(
  variants: readonly LiveVariant[],
  share_bp: number,
  currency: string,
): { id: string; from_minor: number; to_minor: number }[] | { refused: string } {
  if (variants.length === 0)
    return { refused: "The product has no variants to mark down. Nothing was changed." };
  const out: { id: string; from_minor: number; to_minor: number }[] = [];
  for (const v of variants) {
    if (v.compare_at_minor !== null && v.compare_at_minor > v.price_minor) {
      return {
        refused: `One of its variants is already on sale (compare-at ${decimal(v.compare_at_minor, currency)} ${currency}, price ${decimal(v.price_minor, currency)}). ScaleX doesn't mark a sale down again. Nothing was changed.`,
      };
    }
    const to = scaleMinorBy(v.price_minor, 10_000 - share_bp, 10_000);
    if (to <= 0 || to >= v.price_minor) {
      return {
        refused: "A markdown must lower the price and keep it above zero. Nothing was changed.",
      };
    }
    if (v.unit_cost_minor !== null && to < v.unit_cost_minor) {
      return {
        refused: `The marked-down price ${decimal(to, currency)} ${currency} would be below the unit cost Shopify holds, ${decimal(v.unit_cost_minor, currency)} ${currency}. Nothing was changed.`,
      };
    }
    out.push({ id: v.id, from_minor: v.price_minor, to_minor: to });
  }
  return out;
}

/** Pure: the bundle's full price — the two components' one price each — or why there is none. */
export function bundleFullPrice(
  a: LiveProduct,
  b: LiveProduct,
): { price_minor: number } | { refused: string } {
  const one = (p: LiveProduct) => {
    const prices = new Set(p.variants.map((v) => v.price_minor));
    return prices.size === 1 ? [...prices][0]! : null;
  };
  const pa = one(a);
  const pb = one(b);
  if (pa === null || pb === null) {
    return {
      refused: `"${pa === null ? a.title : b.title}" has variants at different prices, so the pair's full price isn't one number. Set this bundle up in Shopify yourself. Nothing was changed.`,
    };
  }
  return { price_minor: pa + pb };
}

/* ── the undo payloads ── */

interface PageUndo {
  op: "update_page_body";
  page_id: string;
  previous_body: string;
}
interface BundleUndo {
  op: "create_bundle";
  title: string;
}
interface MarkdownUndo {
  op: "set_variant_price";
  product_id: string;
  currency: string;
  share_bp: number;
  variants: { id: string; price_minor: number; compare_at_minor: number | null }[];
}

/* ── the provider ── */

export function createShopifyWriteExecutor(options: ShopifyWriteOptions = {}): ExecutionProvider {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const client = new ShopifyClient(options.fetch ?? liveFetch, sleep);
  const bundleSent = new Set<string>();
  let backendCache: ShopifyWriteBackend | null = null;
  const backend = async (): Promise<ShopifyWriteBackend> => {
    if (backendCache) return backendCache;
    if (options.backend) backendCache = await options.backend();
    else {
      const { dbShopifyWriteBackend } = await import("../../shop/writes");
      backendCache = dbShopifyWriteBackend();
    }
    return backendCache;
  };
  const credential = async (ctx: ExecutionContext): Promise<ShopifyCredential> => {
    const c = await (await backend()).credential(ctx.account_id);
    if ("refused" in c) throw new ShopifyChangeError(c.refused);
    return c;
  };
  const shopOf = async (cred: ShopifyCredential) => {
    const data = await client.call(cred, "shop", {});
    const s = data.shop as {
      myshopifyDomain?: unknown;
      currencyCode?: unknown;
      primaryDomain?: { host?: unknown };
    } | null;
    if (typeof s?.currencyCode !== "string") {
      throw new ShopifyChangeError(
        "Shopify's store answer had an unexpected shape. Nothing was changed.",
      );
    }
    return {
      currency: s.currencyCode,
      hosts: [s.myshopifyDomain, s.primaryDomain?.host]
        .filter((h): h is string => typeof h === "string")
        .map((h) => h.toLowerCase()),
    };
  };
  const productOf = async (cred: ShopifyCredential, id: string, currency: string) => {
    const data = await client.call(cred, "product", { id });
    const p = parseProduct(data.product, currency);
    if (!p) {
      throw new ShopifyChangeError(
        "That product isn't in the connected Shopify store any more. Nothing was changed.",
      );
    }
    return p;
  };
  const pageFor = async (cred: ShopifyCredential, url: string) => {
    const where = pageHandleOf(url);
    if (!where) {
      throw new ShopifyChangeError(
        "Only your store's own pages (under /pages/) can be changed through Shopify. This text sits in your theme, a product or a collection: change it in Shopify yourself, with the card's before and after.",
      );
    }
    const shop = await shopOf(cred);
    if (!shop.hosts.includes(where.host)) {
      throw new ShopifyChangeError(
        `That page is on ${where.host}, which isn't the connected Shopify store. Nothing was changed.`,
      );
    }
    const data = await client.call(cred, "page_by_handle", { query: `handle:${where.handle}` });
    const nodes = ((data.pages as { nodes?: unknown[] } | null)?.nodes ?? []) as {
      id?: unknown;
      handle?: unknown;
      body?: unknown;
    }[];
    const page = nodes.find((n) => n.handle === where.handle);
    if (
      !page ||
      typeof page.id !== "string" ||
      !GID.page.test(page.id) ||
      typeof page.body !== "string"
    ) {
      throw new ShopifyChangeError(
        `The store has no page "${where.handle}" any more. Nothing was changed.`,
      );
    }
    return { id: page.id, body: page.body };
  };
  const pageBody = async (cred: ShopifyCredential, id: string) => {
    const data = await client.call(cred, "page", { id });
    const p = data.page as { body?: unknown } | null;
    if (!p || typeof p.body !== "string") {
      throw new ShopifyChangeError("That page isn't in the store any more. Nothing was changed.");
    }
    return p.body;
  };
  const occurrences = (body: string, find: string) => body.split(find).length - 1;
  const halted = async (ctx: ExecutionContext) => {
    if (ctx.halted && (await ctx.halted())) throw new ShopifyChangeError(STOPPED_BEFORE_SHOPIFY);
  };
  const setStatus = async (cred: ShopifyCredential, id: string, status: string) => {
    const data = await client.call(
      cred,
      "product_status",
      { product: { id, status } },
      { idempotent: true },
    );
    const why = userErrorsOf(data.productUpdate);
    if (why) throw new ShopifyChangeError(`Shopify refused the product's status: ${why}.`);
  };
  const setPrices = async (
    cred: ShopifyCredential,
    productId: string,
    currency: string,
    rows: { id: string; price_minor: number; compare_at_minor: number | null }[],
  ) => {
    const data = await client.call(
      cred,
      "variants_update",
      {
        productId,
        variants: rows.map((r) => ({
          id: r.id,
          price: decimal(r.price_minor, currency),
          compareAtPrice:
            r.compare_at_minor === null ? null : decimal(r.compare_at_minor, currency),
        })),
      },
      { idempotent: true },
    );
    const why = userErrorsOf(data.productVariantsBulkUpdate);
    if (why)
      throw new ShopifyChangeError(
        `Shopify refused the price change: ${why}. Nothing was changed.`,
      );
  };

  return {
    id: "shopify_write",
    external: true,

    // Reads only: the change can still be made as approved. A refusal leaves it approved.
    async preflight(op, params, ctx): Promise<PreflightRefusal | null> {
      try {
        const cred = await credential(ctx);
        if (op === "update_page_body") {
          const p = pageParams(params);
          const page = await pageFor(cred, p.url);
          const n = occurrences(page.body, p.find);
          if (n !== 1) {
            return {
              code: "refused",
              message:
                n === 0
                  ? "The approved words aren't on the page in Shopify any more, so the change isn't made to a page that moved. Nothing was changed."
                  : "The approved words appear more than once on the page in Shopify, so ScaleX can't tell which to change. Nothing was changed.",
            };
          }
          return null;
        }
        if (op === "create_bundle") {
          const p = bundleParams(params);
          const { currency } = await shopOf(cred);
          const [a, b] = await Promise.all(
            p.product_ids.map((id) => productOf(cred, id, currency)),
          );
          const priced = bundleFullPrice(a!, b!);
          return "refused" in priced ? { code: "refused", message: priced.refused } : null;
        }
        if (op === "set_variant_price") {
          const p = markdownParams(params);
          const { currency } = await shopOf(cred);
          const product = await productOf(cred, p.product_id, currency);
          const targets = markdownTargets(product.variants, p.share_bp, currency);
          return "refused" in targets ? { code: "refused", message: targets.refused } : null;
        }
        return {
          code: "refused",
          message: `Shopify store changes have no "${op}". Nothing was changed.`,
        };
      } catch (error) {
        if (error instanceof ShopifyChangeError) {
          return { code: error.retryable ? "deferred" : "refused", message: error.message };
        }
        throw error;
      }
    },

    async captureUndo(op, params, ctx): Promise<PageUndo | BundleUndo | MarkdownUndo> {
      const cred = await credential(ctx);
      if (op === "update_page_body") {
        const page = await pageFor(cred, pageParams(params).url);
        return { op, page_id: page.id, previous_body: page.body };
      }
      if (op === "create_bundle") {
        // The product doesn't exist yet: the undo reads its id from the run's result.
        return { op, title: bundleParams(params).title };
      }
      if (op === "set_variant_price") {
        const p = markdownParams(params);
        const { currency } = await shopOf(cred);
        const product = await productOf(cred, p.product_id, currency);
        return {
          op,
          product_id: product.id,
          currency,
          share_bp: p.share_bp,
          variants: product.variants.map((v) => ({
            id: v.id,
            price_minor: v.price_minor,
            compare_at_minor: v.compare_at_minor,
          })),
        };
      }
      throw new ShopifyChangeError(`Shopify store changes have no "${op}". Nothing was changed.`);
    },

    async execute(op, params, ctx) {
      const cred = await credential(ctx);
      const captured = ctx.execution_id
        ? await (await backend()).capturedUndo(ctx.execution_id)
        : null;

      if (op === "update_page_body") {
        const p = pageParams(params);
        const undo = captured as PageUndo | null;
        if (!undo || undo.op !== op) {
          throw new ShopifyChangeError(
            "The page as it was before isn't on record, so nothing was changed.",
          );
        }
        const live = await pageBody(cred, undo.page_id);
        const next = undo.previous_body.replace(p.find, () => p.replace);
        if (live === next) return { page_id: undo.page_id, body_sha256: sha256(next) }; // a retry after Shopify's yes
        if (live !== undo.previous_body || occurrences(live, p.find) !== 1) {
          throw new ShopifyChangeError(
            "The page changed in Shopify since ScaleX read it a moment ago. Nothing was changed; check the card against the page.",
          );
        }
        await halted(ctx);
        const data = await client.call(
          cred,
          "page_update",
          { id: undo.page_id, page: { body: next } },
          { idempotent: true },
        );
        const why = userErrorsOf(data.pageUpdate);
        if (why)
          throw new ShopifyChangeError(
            `Shopify refused the page change: ${why}. Nothing was changed.`,
          );
        await (
          await backend()
        ).changed(ctx.profile_id, `Changed the words on your page ${p.url}.`, {
          op,
          page_id: undo.page_id,
        });
        return { page_id: undo.page_id, url: p.url, body_sha256: sha256(next) };
      }

      if (op === "create_bundle") {
        const p = bundleParams(params);
        // productBundleCreate makes a product each time it is sent: never twice.
        // The engine's retries run in this process, so a retry after the send
        // finds its run here; a run that died is never re-selected (P3-20e).
        if (ctx.execution_id && bundleSent.has(ctx.execution_id)) {
          throw new ShopifyChangeError(
            "An earlier attempt may have created this bundle. ScaleX won't create a second one: check Products in Shopify.",
          );
        }
        const { currency } = await shopOf(cred);
        const [a, b] = await Promise.all(p.product_ids.map((id) => productOf(cred, id, currency)));
        const priced = bundleFullPrice(a!, b!);
        if ("refused" in priced) throw new ShopifyChangeError(priced.refused);
        await halted(ctx);
        if (ctx.execution_id) bundleSent.add(ctx.execution_id);
        const created = await client.call(cred, "bundle_create", {
          input: {
            title: p.title,
            components: [a!, b!].map((c) => ({
              productId: c.id,
              quantity: 1,
              optionSelections: c.options.map((o) => ({
                componentOptionId: o.id,
                name: o.name,
                values: o.values,
              })),
            })),
          },
        });
        const payload = created.productBundleCreate as {
          productBundleOperation?: { id?: unknown } | null;
          userErrors?: unknown;
        } | null;
        const refusal = userErrorsOf(payload);
        if (refusal)
          throw new ShopifyChangeError(
            `Shopify refused the bundle: ${refusal}. Nothing was created.`,
          );
        const operationId = payload?.productBundleOperation?.id;
        if (typeof operationId !== "string") {
          throw new ShopifyChangeError(
            "Shopify didn't say whether the bundle was created. Check Products in Shopify; ScaleX won't create it again.",
          );
        }
        let productId: string | null = null;
        for (let poll = 1; poll <= BUNDLE_POLLS && productId === null; poll += 1) {
          await sleep(Math.min(1000 * poll, 5000));
          const data = await client.call(cred, "bundle_operation", { id: operationId });
          const operation = data.productOperation as {
            status?: unknown;
            product?: { id?: unknown } | null;
            userErrors?: unknown;
          } | null;
          const failed = userErrorsOf(operation);
          if (failed) throw new ShopifyChangeError(`Shopify couldn't make the bundle: ${failed}.`);
          if (operation?.status === "COMPLETE" && typeof operation.product?.id === "string") {
            productId = operation.product.id;
          }
        }
        if (productId === null || !GID.product.test(productId)) {
          throw new ShopifyChangeError(
            "Shopify was still making the bundle when ScaleX stopped waiting. Check Products in Shopify; ScaleX won't create it again.",
          );
        }
        // Full price, no discount in it: the bundle's one price is the two items' together.
        try {
          const bundle = await productOf(cred, productId, currency);
          await setPrices(
            cred,
            productId,
            currency,
            bundle.variants.map((v) => ({
              id: v.id,
              price_minor: priced.price_minor,
              compare_at_minor: null,
            })),
          );
          await setStatus(cred, productId, p.status);
        } catch (error) {
          // A bundle at the wrong price must not stay on sale: archive it, and say so.
          await setStatus(cred, productId, "ARCHIVED").catch(() => undefined);
          throw new ShopifyChangeError(
            `Shopify made the bundle but ScaleX couldn't set its full price, so it was archived again (${error instanceof Error ? error.message : "unknown"}).`,
          );
        }
        await (
          await backend()
        ).changed(
          ctx.profile_id,
          `Created the bundle "${p.title}" in Shopify at ${decimal(priced.price_minor, currency)} ${currency}, the two items' full price.`,
          { op, product_id: productId },
        );
        return {
          product_id: productId,
          title: p.title,
          price_minor: priced.price_minor,
          currency,
          status: p.status,
        };
      }

      if (op === "set_variant_price") {
        const p = markdownParams(params);
        const undo = captured as MarkdownUndo | null;
        if (!undo || undo.op !== op || undo.product_id !== p.product_id) {
          throw new ShopifyChangeError(
            "The prices before aren't on record, so nothing was changed.",
          );
        }
        const live = await productOf(cred, p.product_id, undo.currency);
        const costOf = new Map(live.variants.map((v) => [v.id, v.unit_cost_minor]));
        // From the baseline captured before attempt one, at today's unit costs:
        // a retry after a lost answer never marks down twice.
        const targets = markdownTargets(
          undo.variants.map((v) => ({ ...v, unit_cost_minor: costOf.get(v.id) ?? null })),
          undo.share_bp,
          undo.currency,
        );
        if ("refused" in targets) throw new ShopifyChangeError(targets.refused);
        const done = targets.every((t) => {
          const v = live.variants.find((x) => x.id === t.id);
          return v?.price_minor === t.to_minor && v.compare_at_minor === t.from_minor;
        });
        if (!done) {
          const asCaptured = undo.variants.every((u) => {
            const v = live.variants.find((x) => x.id === u.id);
            return v?.price_minor === u.price_minor && v.compare_at_minor === u.compare_at_minor;
          });
          if (!asCaptured || live.variants.length !== undo.variants.length) {
            throw new ShopifyChangeError(
              "The item's prices changed in Shopify since ScaleX read them a moment ago. Nothing was changed.",
            );
          }
          await halted(ctx);
          await setPrices(
            cred,
            p.product_id,
            undo.currency,
            targets.map((t) => ({
              id: t.id,
              price_minor: t.to_minor,
              compare_at_minor: t.from_minor,
            })),
          );
        }
        await (
          await backend()
        ).changed(
          ctx.profile_id,
          `Marked "${live.title}" down by ${undo.share_bp / 100}% in Shopify; the old price shows as the compare-at price.`,
          { op, product_id: p.product_id },
        );
        return {
          product_id: p.product_id,
          currency: undo.currency,
          variants: targets.map((t) => ({
            id: t.id,
            price_minor: t.to_minor,
            compare_at_minor: t.from_minor,
          })),
        };
      }

      throw new ShopifyChangeError(`Shopify store changes have no "${op}". Nothing was changed.`);
    },

    // Undo only while the live value is still what SYB set (review 2026-10-23, Session D #4).
    async undo(op, undoPayload, ctx) {
      const cred = await credential(ctx);
      const result = ctx.result as Record<string, unknown> | undefined;

      if (op === "update_page_body") {
        const u = undoPayload as PageUndo;
        const live = await pageBody(cred, u.page_id);
        if (live === u.previous_body) return { restored: u.page_id };
        if (typeof result?.body_sha256 !== "string" || sha256(live) !== result.body_sha256) {
          throw new ShopifyChangeError(
            "The page has changed in Shopify since ScaleX's change, so putting the old words back would undo someone else's edit. Nothing was changed.",
          );
        }
        const data = await client.call(
          cred,
          "page_update",
          { id: u.page_id, page: { body: u.previous_body } },
          { idempotent: true },
        );
        const why = userErrorsOf(data.pageUpdate);
        if (why) throw new ShopifyChangeError(`Shopify refused putting the page back: ${why}.`);
        return { restored: u.page_id };
      }

      if (op === "create_bundle") {
        const productId = typeof result?.product_id === "string" ? result.product_id : null;
        if (productId === null || !GID.product.test(productId)) {
          throw new ShopifyChangeError(
            "No bundle was recorded as created, so there is nothing to archive.",
          );
        }
        const { currency } = await shopOf(cred);
        const data = await client.call(cred, "product", { id: productId });
        const bundle = parseProduct(data.product, currency);
        if (!bundle || bundle.status === "ARCHIVED") return { archived: productId };
        if (bundle.title !== result?.title) {
          throw new ShopifyChangeError(
            "The bundle was renamed in Shopify since ScaleX made it, so ScaleX leaves it to you. Nothing was changed.",
          );
        }
        await setStatus(cred, productId, "ARCHIVED");
        return { archived: productId };
      }

      if (op === "set_variant_price") {
        const u = undoPayload as MarkdownUndo;
        const set = (result?.variants ?? []) as {
          id: string;
          price_minor: number;
          compare_at_minor: number | null;
        }[];
        const live = await productOf(cred, u.product_id, u.currency);
        const restored = u.variants.every((b) => {
          const v = live.variants.find((x) => x.id === b.id);
          return v?.price_minor === b.price_minor && v.compare_at_minor === b.compare_at_minor;
        });
        if (restored) return { restored: u.product_id };
        const stillOurs =
          set.length === u.variants.length &&
          set.every((s) => {
            const v = live.variants.find((x) => x.id === s.id);
            return v?.price_minor === s.price_minor && v.compare_at_minor === s.compare_at_minor;
          });
        if (!stillOurs) {
          throw new ShopifyChangeError(
            "The item's prices changed in Shopify since ScaleX marked it down, so ScaleX won't put old prices over someone else's. Nothing was changed.",
          );
        }
        await setPrices(cred, u.product_id, u.currency, u.variants);
        return { restored: u.product_id };
      }

      throw new ShopifyChangeError(`Shopify store changes have no "${op}" to undo.`);
    },
  };
}

/**
 * The connect-time verifier: parse the credential (store address, client ID,
 * client secret), swap it for a token, and report the scopes Shopify says the
 * installation holds — read back, not assumed (the read connector's way).
 */
export function shopifyWriteVerifier(options: { fetch?: ShopifyWriteFetch } = {}) {
  const client = new ShopifyClient(
    options.fetch ?? liveFetch,
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
  return async (secret: string): Promise<CredentialProof> => {
    try {
      const cred = parseShopifyCredential(secret);
      const token = await client.token(cred, true);
      const data = await client.call(cred, "access_scopes", {});
      const handles = (
        (data.currentAppInstallation as { accessScopes?: { handle?: unknown }[] } | null)
          ?.accessScopes ?? []
      )
        .map((s) => s.handle)
        .filter((h): h is string => typeof h === "string");
      return { granted_scopes: impliedReadsDropped(handles.length > 0 ? handles : token.scopes) };
    } catch (error) {
      // The consent screen says the reason; nothing was stored.
      const message = error instanceof Error ? error.message.replace(/^shopify: /, "") : "";
      throw new ExecutionConnectionError(
        message === "" ? "Shopify didn't accept that app. Nothing was connected." : message,
        422,
      );
    }
  };
}

export const shopifyWriteExecutor = createShopifyWriteExecutor();
