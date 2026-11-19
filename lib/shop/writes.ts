// Shopify store changes, database side — D6 (owner, 2026-11-16).
//
// lib/execution/providers/shopify.ts writes; this file remembers and routes:
//
//   the backend   the credential (the shopify_write execute connection, its
//                 secret decrypted only here), the undo the engine stored
//                 before attempt one, and the watch-log line
//   the routes    what an approved bundle or slow-stock markdown proposal
//                 runs — built from the approved row and constants, never
//                 from anything a caller could add: the op is decided by the
//                 proposal's own module, ref and option, the markdown's share
//                 is CLEARANCE's, and the Shopify ids must look like ids
//   the question  is this account's store connected for changes — asked by
//                 the generators, so a proposal made with a connection
//                 carries the ids it needs and runs on approval, and one made
//                 without says "set it up yourself" and stays that way

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, executions, watchActivity } from "../../db/schema";
import { parseShopifyCredential } from "../connectors/providers/shopify";
import { activeExecutionConnection, executionSecret } from "../execution/connections";
import type { DispatchPlan } from "../execution/due";
import type { ShopifyWriteBackend } from "../execution/providers/shopify";
import type { ProposalRow } from "../proposals/service";
import { CLEARANCE } from "../stock/options";

export const SHOP_PROVIDER = "shopify_write";

/** The markdown every slow-stock proposal states, in basis points (CLEARANCE.markdown_share). */
export const MARKDOWN_SHARE_BP = Math.round(CLEARANCE.markdown_share * 10_000);

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/;

export function dbShopifyWriteBackend(): ShopifyWriteBackend {
  return {
    async credential(accountId) {
      const row = await activeExecutionConnection(accountId, "shopify_write");
      if (!row) {
        return {
          refused:
            "Shopify store changes aren't connected. Connect them on Connections; nothing was changed.",
        };
      }
      if (row.status !== "connected") {
        return {
          refused: `The Shopify store-changes connection is ${row.status}. Reconnect it on Connections; nothing was changed.`,
        };
      }
      try {
        return parseShopifyCredential(executionSecret(row));
      } catch {
        return {
          refused:
            "The Shopify store-changes credential can't be read. Reconnect it on Connections; nothing was changed.",
        };
      }
    },

    async capturedUndo(executionId) {
      const [row] = await db
        .select({ undo_payload: executions.undo_payload })
        .from(executions)
        .where(eq(executions.id, executionId));
      return row?.undo_payload ?? null;
    },

    async changed(profileId, detail, meta) {
      await db
        .insert(watchActivity)
        .values({ profile_id: profileId, kind: "shop_changed", detail, meta });
    },
  };
}

/** Is this account's Shopify store connected for changes right now? */
export async function shopifyWriteConnected(accountId: string): Promise<boolean> {
  const row = await activeExecutionConnection(accountId, "shopify_write");
  return row?.status === "connected";
}

/** The account a profile belongs to, for the generators' question above. */
export async function accountOfProfile(profileId: string): Promise<string | null> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  return row?.account_id ?? null;
}

/** What a generator stores on a proposal it made with the store connected. */
export interface ShopifyBundleTarget {
  products: [string, string];
  title: string;
}
export interface ShopifyMarkdownTarget {
  product_id: string;
}

/** Pure: a bundle's title from its two names, within Shopify's 255 characters. */
export function bundleTitle(a: string, b: string): string {
  const title = `${a.trim()} + ${b.trim()}`;
  return title.length <= 255 ? title : `${title.slice(0, 254)}…`;
}

export const SET_UP_YOURSELF =
  "made before your Shopify store was connected for changes (or not a Shopify item): set it up in Shopify yourself";

type Routed = { plan: DispatchPlan } | { unroutable: string };

function bundlePlan(target: unknown): Routed {
  const t = target as Partial<ShopifyBundleTarget> | null | undefined;
  const products = t?.products;
  if (
    !Array.isArray(products) ||
    products.length !== 2 ||
    !products.every((p) => typeof p === "string" && PRODUCT_GID.test(p)) ||
    products[0] === products[1] ||
    typeof t?.title !== "string" ||
    t.title.trim() === ""
  ) {
    return { unroutable: SET_UP_YOURSELF };
  }
  return {
    plan: {
      provider: "shopify_write",
      op: "create_bundle",
      params: { title: t.title, product_ids: [products[0], products[1]], status: "ACTIVE" },
    },
  };
}

/**
 * The due runner's route for a shop change: a bundle (idea 48), or a
 * slow-stock markdown or pair (feature 34). Null = not a shop proposal.
 */
export function shopPlanFor(
  proposal: Pick<ProposalRow, "module" | "action" | "originating_finding">,
): Routed | null {
  const ref = proposal.originating_finding ?? "";
  const detail = ((proposal.action as { detail?: Record<string, unknown> } | null)?.detail ??
    {}) as Record<string, unknown>;
  if (proposal.module === "bundles" && ref.startsWith("bundle:")) {
    return bundlePlan(detail.shopify);
  }
  if (proposal.module !== "stock") return null;
  if (ref.startsWith("stock:markdown:") && detail.option === "markdown") {
    const t = detail.shopify as Partial<ShopifyMarkdownTarget> | null | undefined;
    if (typeof t?.product_id !== "string" || !PRODUCT_GID.test(t.product_id)) {
      return { unroutable: SET_UP_YOURSELF };
    }
    return {
      plan: {
        provider: "shopify_write",
        op: "set_variant_price",
        params: { product_id: t.product_id, share_bp: MARKDOWN_SHARE_BP },
      },
    };
  }
  if (ref.startsWith("stock:bundle:") && detail.option === "bundle") {
    return bundlePlan(detail.shopify);
  }
  return null;
}
