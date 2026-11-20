// A pair that sells together, as a proposal — idea 48.
//
// The owner chooses a pair on /patterns and asks for it; this drafts ONE
// proposal through the existing path, and nothing else:
//
//   · nothing before the business is in care, or while it is watched
//     (rule 15), the same hold as every proposal kind;
//   · suppression learning (P3-28): three declines of offer changes and it
//     stops proposing them;
//   · the owner's standing rules (rule 14) checked for the kind; an offer
//     change at full price is not a discount, and it never becomes one;
//   · createProposal writes it with its decision-log entry (rule 7).
//
// Where the pair's orders came from a Shopify store whose owner connected
// store changes (D6, 2026-11-16), the proposal carries the two product ids
// and runs on approval: lib/shop/writes routes it to shopify_write's
// create_bundle — one bundle product at the two items' full price, undone by
// archiving it. Otherwise it is a DRAFT for the owner to act on: an approval
// is recorded and left for them, no price written, no product created.
// Checkout is untouched either way (rule 18). The detail says which, in its
// own words, and the queue shows it.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, connections, proposals } from "../../db/schema";
import type { ShopifyBundleTarget } from "../shop/writes";
import { bundleTitle, shopifyWriteConnected } from "../shop/writes";
import { careState } from "../care/day-zero";
import { format, money } from "../core/money";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import type { BundleSource, PairView } from "./load";
import { loadBundles } from "./load";
import { watchingUntil } from "../care/watch-words";

export const BUNDLES_MODULE = "bundles";
export const BUNDLE_KIND = "offer_change";
const EXPIRY_DAYS = 14;

export type BundleProposalOutcome =
  | { status: "created" | "blocked"; proposal: ProposalRow }
  | { status: "held" | "not_found" | "already" | "suppressed"; reason: string };

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

/** The ref a pair's proposal is deduped by: once per pair per month. */
export function bundleRef(key: string, now: Date): string {
  return `bundle:${key}:${monthOf(now)}`;
}

function moneyText(minor: number, currency: string): string {
  return format(money(minor, currency));
}

export function bundleEvidence(p: PairView, source: BundleSource): string[] {
  const unit = source.kind === "orders" ? "orders" : "visits";
  const lines = [
    `${p.together} of ${p.baskets} ${unit} from ${source.label}, ${source.from} to ${source.to}, held both`,
    `${Math.round(p.confidence * 100)}% of the ${p.count_a} ${unit} with ${p.a_name} also had ${p.b_name}; ${Math.round(p.confidence_ba * 100)}% of the ${p.count_b} with ${p.b_name} had ${p.a_name}`,
    `chance alone would give about ${Math.round(p.expected)}: ${(Math.round(p.lift * 10) / 10).toFixed(1)}× that`,
  ];
  if (p.margin.known) {
    lines.push(
      `the pair at full price: ${moneyText(p.margin.price_minor, p.margin.currency)}, ${moneyText(p.margin.contribution_minor, p.margin.currency)} after costs (${p.margin.margin_pct}%), from your own prices and costs`,
    );
  } else {
    lines.push(`the pair's margin is unknown: ${p.margin.why}`);
  }
  return lines;
}

/**
 * D6: the Shopify target for a pair, when its orders came from a Shopify
 * store and the account's store is connected for changes; else null, and
 * the proposal stays the owner's to set up.
 */
async function shopifyBundleTarget(
  accountId: string,
  source: BundleSource,
  pair: PairView,
): Promise<ShopifyBundleTarget | null> {
  if (source.kind !== "orders") return null;
  const [conn] = await db
    .select({ provider: connections.provider })
    .from(connections)
    .where(eq(connections.id, source.connection_id));
  if (conn?.provider !== "shopify") return null;
  const gid = /^gid:\/\/shopify\/Product\/\d+$/;
  if (!gid.test(pair.a) || !gid.test(pair.b) || pair.a === pair.b) return null;
  if (!(await shopifyWriteConnected(accountId))) return null;
  return { products: [pair.a, pair.b], title: bundleTitle(pair.a_name, pair.b_name) };
}

export async function proposeBundle(
  profileId: string,
  key: string,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<BundleProposalOutcome> {
  const now = opts.now ?? new Date();
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return { status: "not_found", reason: "no such business" };

  const care = await careState(profileId);
  if (!care) {
    return {
      status: "held",
      reason: "I propose once you've chosen how I work for you.",
    };
  }
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return {
      status: "held",
      reason: watchingUntil(care.watch_ends_at),
    };
  }

  const view = await loadBundles(profile.account_id, profileId, now);
  let found: { pair: PairView; source: BundleSource } | null = null;
  for (const source of view.sources) {
    const pair = source.pairs.find((p) => p.key === key);
    if (pair) found = { pair, source };
  }
  if (!found) {
    return { status: "not_found", reason: "that pair isn't among the ones shown any more" };
  }
  const { pair, source } = found;

  const ref = bundleRef(key, now);
  const [existing] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.originating_finding, ref)));
  if (existing) return { status: "already", reason: "already proposed this month" };

  const silenced = (await suppressedKinds(profileId)).get(BUNDLE_KIND);
  if (silenced) {
    return {
      status: "suppressed",
      reason: `you've declined offer changes ${silenced.rejections} times: I've stopped proposing them`,
    };
  }

  const limits = (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
  const verdict = checkHardLimits(limits, BUNDLE_KIND);
  const evidence = bundleEvidence(pair, source);
  // D6: a pair from a Shopify store connected for changes is made there on approval.
  const shopify = await shopifyBundleTarget(profile.account_id, source, pair);
  const what =
    source.kind === "orders"
      ? `Show ${pair.a_name} and ${pair.b_name} together (side by side on each product's page, or as a set), both at full price. No discount in it.`
      : `Offer ${pair.a_name} and ${pair.b_name} together in one visit (at the booking, or when one of them is booked), both at full price. No discount in it.`;
  const row = await createProposal({
    profile_id: profileId,
    module: BUNDLES_MODULE,
    originating_finding: ref,
    action: {
      kind: BUNDLE_KIND,
      summary:
        source.kind === "orders"
          ? `Show "${pair.a_name}" and "${pair.b_name}" together, both at full price`
          : `Offer "${pair.a_name}" and "${pair.b_name}" together in one visit, at full price`,
      detail: {
        what,
        pair: {
          key,
          source: source.label,
          kind: source.kind,
          a: { ref: pair.a, name: pair.a_name },
          b: { ref: pair.b, name: pair.b_name },
          together: pair.together,
          baskets: pair.baskets,
          confidence: pair.confidence,
          lift: pair.lift,
          expected: pair.expected,
          margin: pair.margin,
        },
        evidence,
        ...(shopify
          ? {
              shopify,
              execute_on_approval: true,
              sending: `Approving lets me create "${shopify.title}" in your Shopify store as one bundle product at the two items' full price, on the next run. I don't touch either item, your prices or your checkout.`,
            }
          : {
              draft_only: true,
              sending:
                source.kind === "orders"
                  ? "Approving records your yes. I don't change your shop, your prices or your checkout: you set the pair up yourself."
                  : "Approving records your yes. I don't change your booking system or your prices: you offer the pair yourself.",
            }),
        manual_limits: verdict.manual.map((l) => l.quote),
      },
    },
    scenario: {
      assumptions: [
        ...evidence.map((statement) => ({
          statement,
          value: null,
          source_field: null,
          measured: source.label,
          sensitivity: "low" as const,
        })),
        {
          statement:
            "showing the two together adds sales of the second one; how many is not measured until you've tried it",
          value: null,
          source_field: null,
          sensitivity: "high" as const,
        },
      ],
      base_case: {
        case: "base",
        statement: `Some of the ${pair.count_a - pair.together} ${source.kind} with ${pair.a_name} and not ${pair.b_name} add it. Nothing is given up: both stay at full price.`,
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement:
          "Nobody adds the second item: you've spent the time setting it up, and nothing else.",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: pair.margin.known
          ? `Each extra pair sold earns about ${moneyText(pair.margin.contribution_minor, pair.margin.currency)} after costs.`
          : "Each extra pair sold earns its full margin, unknown until its costs are on record.",
        profit_delta_monthly: null,
        formula: pair.margin.known ? pair.margin.formula : null,
      },
      breakeven_condition: "nothing to break even on: it gives nothing up",
    },
    reversibility: {
      level: "easy",
      if_you_change_your_mind: shopify
        ? "Undo it from ScaleX and I archive the bundle I made (never delete it); nothing about either item changed."
        : "Take the pair down again; nothing about either item changed.",
    },
    expires_at: new Date(now.getTime() + EXPIRY_DAYS * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
  console.log(
    JSON.stringify({
      event: "bundle_proposal",
      profile_id: profileId,
      account_id: profile.account_id,
      ref,
      status: verdict.verdict === "blocked" ? "blocked" : "created",
    }),
  );
  return { status: verdict.verdict === "blocked" ? "blocked" : "created", proposal: row };
}
