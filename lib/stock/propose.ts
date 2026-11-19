// Clearing slow stock, as proposals — feature 34.
//
// Every option is a PROPOSAL through the existing generation path: the
// owner's standing rules first (rule 14, the hard limits parsed once from
// 13.5 — "we never discount" blocks a markdown, and the block is stored and
// shown, not hidden), then suppression learning (P3-28: three declines of a
// kind silence it, as for every kind), then createProposal, which writes
// the proposal and its decision-log entry together. Nothing here executes
// anything (rule 12). A markdown or a pair for an item in a Shopify store
// connected for changes carries its Shopify ids (shopDetail, D6, owner
// 2026-11-16) and runs through shopify_write once approved; any other
// markdown or pair waits for the owner to act, and the two that have their
// own path keep it — a post goes through /content's drafting and its own publish
// approval, an email through the campaign path's drafting, the owner's
// approval of the exact email, and the per-recipient consent check at the
// moment of sending (P4-14/15).
//
// Like the ad proposals (P3-22a) and the hours trials, nothing is proposed
// before a business is in care or while it is being watched (rule 15); the
// screen still shows the arithmetic, and says when proposals will come.
// One proposal per item, per option, per month, and one email per month
// for the items together — re-running is idempotent at zero model cost.

import { and, eq, like } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, modeDecisions, proposals } from "../../db/schema";
import { careState } from "../care/day-zero";
import { CADENCE, listChannels } from "../content/plan";
import type { PlannedItem } from "../content/plan";
import { logSafeError } from "../core/log-safe";
import { outboundPosture } from "../crm/contacts";
import { SEGMENT_KIND, SEGMENT_MODULE } from "../crm/segment-proposals";
import { computeSegments } from "../crm/segments";
import type { HardLimit, LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import type { RankedItem } from "./assess";
import { STOCK, shiftDay } from "./assess";
import type { StockView } from "./load";
import { loadStock, stockApplies } from "./load";
import type { ClearanceOption, OptionContext, OptionKey } from "./options";
import { CLEARANCE, clearanceOptions, efficiencyLine, rankOptions } from "./options";
import { proposeReorders } from "./reorder";
import { watchingUntil } from "../care/watch-words";
import type { Words } from "./words";
import { englishStock, exactMoney } from "./words";
import { bundleTitle, shopifyWriteConnected } from "../shop/writes";

export const STOCK_MODULE = "stock";

/** The partial unique index that makes a stock proposal's ref once-only (migration 0053). */
export const STOCK_FINDING_INDEX = "proposals_stock_finding_idx";

/**
 * Create a stock proposal at most once per ref. The read of existing refs
 * above is the fast path; two runs racing past it both reach the insert,
 * and the database's unique index lets one in (review 2026-10-23, #22).
 * The loser's transaction rolls back whole, its log entry with it.
 */
export async function createOnce(
  input: Parameters<typeof createProposal>[0],
): Promise<ProposalRow | null> {
  try {
    return await createProposal(input);
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string }; constraint?: string }) ?? {};
    if ((cause.cause?.constraint ?? cause.constraint) === STOCK_FINDING_INDEX) return null;
    throw error;
  }
}

/** The email recipients: the campaign path's own best-customers segment. */
const EMAIL_SEGMENT = "vip";

export interface Shared {
  content_channel: { channel_id: string; label: string; format: PlannedItem["format"] } | null;
  emailable_ids: string[];
  email_segment: { label: string; in_segment: number; excluded: unknown; evidence: string[] };
  email_off: string | null;
}

/**
 * What the options need from outside the stock itself: a channel, and who
 * may be emailed. L-4b: `email_off` is in `w`, English by default — the
 * proposals below are stored, so only the /stock screen passes other words.
 */
export async function sharedContext(
  profileId: string,
  accountId: string,
  now: Date,
  w: Words = englishStock(),
): Promise<Shared> {
  const channels = (await listChannels(profileId)).filter(
    (c) => c.type !== null && c.type in CADENCE,
  );
  const first = channels[0];
  const posture = await outboundPosture(profileId);
  const segments = await computeSegments(accountId, now);
  const vip = segments.segments.find((s) => s.key === EMAIL_SEGMENT);
  return {
    content_channel: first
      ? { channel_id: first.channel_id, label: first.label, format: CADENCE[first.type!]!.format }
      : null,
    emailable_ids: posture === "disabled" ? [] : (vip?.emailable_ids ?? []),
    email_segment: {
      label: vip?.label ?? "Best customers",
      in_segment: vip?.contact_ids.length ?? 0,
      excluded: vip?.excluded ?? null,
      evidence: vip?.evidence ?? [],
    },
    email_off: posture === "disabled" ? w.tr("option.emailOff") : null,
  };
}

/** A best seller from the same source with stock on hand: the most units sold in 90 days. */
export function bestSellerFor(
  item: RankedItem,
  all: readonly RankedItem[],
): { name: string; on_hand: number; ref: string } | null {
  const rate = (r: RankedItem) => r.assessment.rate?.per_day ?? 0;
  const candidates = all.filter(
    (r) =>
      r.item.connection_id === item.item.connection_id &&
      r.item.ref !== item.item.ref &&
      r.assessment.flag === null &&
      r.item.on_hand > 0 &&
      rate(r) > 0,
  );
  const best = candidates.sort((a, b) => rate(b) - rate(a))[0];
  return best ? { name: best.item.name, on_hand: best.item.on_hand, ref: best.item.ref } : null;
}

const SHOPIFY_PRODUCT = /^gid:\/\/shopify\/Product\/\d+$/;

/**
 * D6 (2026-11-16): what a markdown or a pair carries when the item is in a
 * Shopify store connected for changes — the ids lib/shop/writes routes to
 * shopify_write, and the words that say it happens on approval. Empty
 * otherwise: the option stays the owner's to carry out, as before.
 */
export function shopDetail(
  key: OptionKey,
  r: RankedItem,
  all: readonly RankedItem[],
  connected: boolean,
): Record<string, unknown> {
  if (!connected || r.item.provider !== "shopify" || !SHOPIFY_PRODUCT.test(r.item.ref)) return {};
  if (key === "markdown") {
    return {
      shopify: { product_id: r.item.ref },
      execute_on_approval: true,
      sending: `Approving lets me mark it down by ${Math.round(CLEARANCE.markdown_share * 100)}% in your Shopify store on the next run, with the old price shown as the compare-at price, never below its cost. Undo puts both prices back.`,
    };
  }
  if (key === "bundle") {
    const best = bestSellerFor(r, all);
    if (!best || !SHOPIFY_PRODUCT.test(best.ref)) return {};
    return {
      shopify: { products: [r.item.ref, best.ref], title: bundleTitle(r.item.name, best.name) },
      execute_on_approval: true,
      sending:
        "Approving lets me create the pair in your Shopify store as one bundle product at the two items' full price, on the next run. Undo archives it.",
    };
  }
  return {};
}

/** Money in one currency, at its full decimals; English by default (L-4b, ./words). */
export function fmtFor(
  currency: string | null,
  w: Words = englishStock(),
): (minor: number) => string {
  return (minor) =>
    currency === null
      ? w.tr("option.unknownCurrency", { amount: String(minor) })
      : exactMoney(minor, currency, w.locale);
}

/**
 * Pure-ish: the ranked options for one slow item, in its own currency.
 * L-4b: their words are `w`, English by default — proposals are made from
 * the default; the /stock screen passes the request's words.
 */
export function optionsFor(
  item: RankedItem,
  view: StockView,
  shared: Shared,
  w: Words = englishStock(),
): ClearanceOption[] {
  const ctx: OptionContext = {
    best_seller: bestSellerFor(item, view.items),
    content_channel: shared.content_channel?.label ?? null,
    emailable: shared.emailable_ids.length,
    email_off: shared.email_off,
    fmt: fmtFor(item.item.currency, w),
  };
  return rankOptions(clearanceOptions(item.item, ctx, w));
}

/** The item's own numbers, in words: the evidence every proposal carries. */
export function evidenceLines(r: RankedItem, sourceLabel: string): string[] {
  const { item, assessment: a } = r;
  const fmt = fmtFor(item.currency);
  const lines = [
    `${item.on_hand} on hand, read from ${sourceLabel} on ${item.as_of}`,
    `sold in the last 30 / 60 / 90 days: ${STOCK.windows.map((w) => a.sold[w] ?? "not measured").join(" / ")}`,
  ];
  if (a.days_since_sale !== null) lines.push(`last sale ${a.days_since_sale} days ago`);
  else if (a.no_sale_for_at_least !== null)
    lines.push(`no sale in the ${a.no_sale_for_at_least} days on record`);
  if (a.days_of_cover !== null) lines.push(`${Math.round(a.days_of_cover)} days of cover`);
  if (a.cash_tied_minor !== null) {
    lines.push(
      `${fmt(a.cash_tied_minor)} tied up at cost${item.cost_basis === "stated" ? " (your own cost for the offer, not measured)" : ""}`,
    );
  }
  if (item.value_at_price !== null) lines.push(`${fmt(item.value_at_price)} at full price`);
  lines.push(`${a.flag}: ${a.why}`);
  return lines;
}

export interface StockProposalOutcome {
  created: ProposalRow[];
  blocked: ProposalRow[];
  skipped: { ref: string; reason: string }[];
}

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

/** The ref an option's proposal is deduped by. */
export function optionRef(r: RankedItem, key: OptionKey, now: Date): string {
  return key === "email"
    ? `stock:email:${monthOf(now)}`
    : `stock:${key}:${r.item.connection_id}:${r.item.ref}:${monthOf(now)}`;
}

/**
 * Propose ways to clear the slow items with the most cash tied up. Honest
 * about every skip: not in care, watching, nothing slow, an option that
 * can't be proposed, suppressed, already proposed.
 */
export async function proposeClearance(
  profileId: string,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<StockProposalOutcome> {
  const now = opts.now ?? new Date();
  const out: StockProposalOutcome = { created: [], blocked: [], skipped: [] };
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return out;
  if (!(await stockApplies(profileId))) {
    out.skipped.push({ ref: "profile", reason: "the business doesn't hold stock" });
    return out;
  }
  const care = await careState(profileId);
  if (!care) {
    out.skipped.push({ ref: "profile", reason: "not in care yet: no mode decision" });
    return out;
  }
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    out.skipped.push({
      ref: "profile",
      reason: watchingUntil(care.watch_ends_at),
    });
    return out;
  }

  const view = await loadStock(profile.account_id, profileId, now);
  const top = view.slow.slice(0, CLEARANCE.max_items);
  if (top.length === 0) {
    out.skipped.push({ ref: "profile", reason: "no slow stock" });
    return out;
  }
  const shared = await sharedContext(profileId, profile.account_id, now);
  const shopConnected = await shopifyWriteConnected(profile.account_id);
  const existing = new Set(
    (
      await db
        .select({ ref: proposals.originating_finding })
        .from(proposals)
        .where(
          and(eq(proposals.profile_id, profileId), like(proposals.originating_finding, "stock:%")),
        )
    ).map((r) => r.ref),
  );
  const suppressed = await suppressedKinds(profileId);
  let limits: HardLimit[] | null = null;
  const expires = new Date(now.getTime() + CLEARANCE.expiry_days * 86_400_000).toISOString();
  const labelOf = (r: RankedItem) =>
    view.sources.find((s) => s.connection_id === r.item.connection_id)?.label ?? r.item.provider;

  const emailItems: { r: RankedItem; option: ClearanceOption }[] = [];

  for (const r of top) {
    const ranked = optionsFor(r, view, shared);
    const fmt = fmtFor(r.item.currency);
    const evidence = evidenceLines(r, labelOf(r));
    for (const [position, option] of ranked.entries()) {
      const ref = optionRef(r, option.key, now);
      if (option.unavailable !== null) {
        out.skipped.push({ ref, reason: option.unavailable });
        continue;
      }
      if (option.key === "email") {
        emailItems.push({ r, option });
        continue;
      }
      if (existing.has(ref)) {
        out.skipped.push({ ref, reason: "already proposed this month" });
        continue;
      }
      const silenced = suppressed.get(option.kind);
      if (silenced) {
        out.skipped.push({
          ref,
          reason: `you've declined ${option.kind.replace(/_/g, " ")} ${silenced.rejections} times: I've stopped proposing it`,
        });
        continue;
      }
      limits ??= (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
      const verdict = checkHardLimits(limits, option.kind);
      const row = await createOnce({
        profile_id: profileId,
        module: option.key === "content" ? "content" : STOCK_MODULE,
        originating_finding: ref,
        action: {
          kind: option.kind,
          summary: summaryFor(option.key, r, shared),
          detail: {
            ...detailFor(option, r, shared, now),
            ...shopDetail(option.key, r, view.items, shopConnected),
            stock: stockDetail(r, labelOf(r)),
            option: option.key,
            rank: position + 1,
            of: ranked.filter((o) => o.unavailable === null).length,
            efficiency: efficiencyLine(option, fmt),
            arithmetic: option.arithmetic,
            evidence,
            manual_limits: verdict.manual.map((l) => l.quote),
          },
        },
        scenario: scenarioFor(option, r, evidence, fmt) as never,
        reversibility: option.reversibility,
        expires_at: expires,
        blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
      });
      if (row === null) {
        out.skipped.push({ ref, reason: "already proposed this month" });
        continue;
      }
      (verdict.verdict === "blocked" ? out.blocked : out.created).push(row);
    }
  }

  // One email for the items together: the same customers never get three.
  if (emailItems.length > 0) {
    const ref = `stock:email:${monthOf(now)}`;
    const silenced = suppressed.get(SEGMENT_KIND);
    if (existing.has(ref)) out.skipped.push({ ref, reason: "already proposed this month" });
    else if (silenced) {
      out.skipped.push({
        ref,
        reason: `you've declined customer email ${silenced.rejections} times: I've stopped proposing it`,
      });
    } else {
      limits ??= (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
      const verdict = checkHardLimits(limits, SEGMENT_KIND);
      const row = await createOnce(
        emailProposal(profileId, ref, emailItems, shared, verdict, expires, labelOf),
      );
      if (row === null) out.skipped.push({ ref, reason: "already proposed this month" });
      else (verdict.verdict === "blocked" ? out.blocked : out.created).push(row);
    }
  }

  console.log(
    JSON.stringify({
      event: "stock_proposals",
      profile_id: profileId,
      account_id: profile.account_id,
      items: top.length,
      created: out.created.length,
      blocked: out.blocked.length,
      skipped: out.skipped.length,
    }),
  );
  return out;
}

function stockDetail(r: RankedItem, source: string) {
  const { item, assessment: a } = r;
  return {
    connection_id: item.connection_id,
    ref: item.ref,
    name: item.name,
    source,
    as_of: item.as_of,
    on_hand: item.on_hand,
    sold: a.sold,
    days_since_sale: a.days_since_sale,
    no_sale_for_at_least: a.no_sale_for_at_least,
    days_of_cover: a.days_of_cover === null ? null : Math.round(a.days_of_cover),
    cash_tied_minor: a.cash_tied_minor,
    value_at_price_minor: item.value_at_price,
    currency: item.currency,
    cost_basis: item.cost_basis,
    offer_id: item.offer_id,
    flag: a.flag,
  };
}

function summaryFor(key: OptionKey, r: RankedItem, shared: Shared): string {
  const name = r.item.name;
  switch (key) {
    case "content":
      return `Feature "${name}" in a ${shared.content_channel?.format === "short_video" ? "short video" : "post"} on ${shared.content_channel?.label ?? "your channel"}`;
    case "bundle":
      return `Pair "${name}" with a best seller, both at full price`;
    case "markdown":
      return `Mark "${name}" down by ${Math.round(CLEARANCE.markdown_share * 100)}%`;
    case "selloff":
      return `Sell off "${name}" or send it back to the supplier: advice only`;
    case "email":
      return `Email customers who said yes about "${name}"`;
  }
}

function detailFor(option: ClearanceOption, r: RankedItem, shared: Shared, now: Date): object {
  const name = r.item.name;
  if (option.key === "content") {
    const ch = shared.content_channel!;
    const brief = `A ${ch.format === "short_video" ? "short video" : "post"} that shows ${name} in use: what it is, what it's for, that it's in stock. No discount, no invented offer, no urgency that isn't true.`;
    const item: PlannedItem = {
      date: shiftDay(now.toISOString().slice(0, 10), 2),
      channel_id: ch.channel_id,
      channel_label: ch.label,
      format: ch.format,
      goal_id: null,
      focus: name,
      brief,
      evidence: r.item.offer_id ? [`offers.${r.item.offer_id}.name`] : [],
    };
    return {
      items: [item],
      rationale: `${name} isn't selling and holds cash; a post costs your review time and nothing else.`,
      sending:
        "Approving lets me draft it on Content. Nothing is posted until you approve the finished post itself.",
    };
  }
  if (option.key === "bundle") {
    return {
      what: `Show ${name} beside your best seller as a pair, both at full price. No discount in it.`,
      sending:
        "Approving records your yes. I don't change your shop: you set the pair up yourself.",
    };
  }
  if (option.key === "markdown") {
    const unit =
      r.item.value_at_price !== null && r.item.on_hand > 0
        ? Math.round(r.item.value_at_price / r.item.on_hand)
        : null;
    const cut = unit === null ? null : Math.round(unit * (1 - CLEARANCE.markdown_share));
    return {
      what: `Cut ${name}'s price by ${Math.round(CLEARANCE.markdown_share * 100)}% until it clears.`,
      ...(unit !== null && cut !== null && r.item.currency
        ? {
            before: { amount_minor: unit, currency: r.item.currency },
            after: { amount_minor: cut, currency: r.item.currency },
          }
        : {}),
      sending: "Approving records your yes. I don't change your prices: you do.",
    };
  }
  return {
    what: `Offer ${name} to a clearance buyer, or ask your supplier whether they take it back.`,
    advice_only: true,
    sending: "Advice only: I contact nobody. Approving records that you mean to do it.",
  };
}

function scenarioFor(
  option: ClearanceOption,
  r: RankedItem,
  evidence: string[],
  fmt: (minor: number) => string,
) {
  const rec = option.recovered;
  return {
    assumptions: [
      ...evidence.map((e) => ({
        statement: e,
        value: null,
        source_field:
          r.item.cost_basis === "stated" && r.item.offer_id && e.includes("tied up")
            ? `offers.${r.item.offer_id}.cost_to_deliver`
            : null,
        sensitivity: "low" as const,
      })),
      {
        statement: `the rates in "${option.arithmetic}" are assumptions pinned in code, not measured`,
        value: null,
        source_field: null,
        sensitivity: "high" as const,
      },
    ],
    base_case: {
      case: "base",
      statement: `About ${fmt(rec.expected)} back (${fmt(rec.low)} to ${fmt(rec.high)}), ${option.given_up.expected > 0 ? `giving up about ${fmt(option.given_up.expected)}` : "giving nothing up"}.`,
      profit_delta_monthly: null,
      formula: option.arithmetic,
    },
    downside_case: {
      case: "downside",
      statement: option.worst_case,
      profit_delta_monthly: null,
      formula: null,
    },
    upside_case: {
      case: "upside",
      statement: `Up to ${fmt(rec.high)} back, and the space and cash go to stock that sells.`,
      profit_delta_monthly: null,
      formula: null,
    },
    breakeven_condition:
      option.given_up.expected > 0
        ? `worth it while the cash back beats what holding it costs: ${efficiencyLine(option, fmt)}`
        : "nothing to break even on: it gives nothing up",
  };
}

function emailProposal(
  profileId: string,
  ref: string,
  items: { r: RankedItem; option: ClearanceOption }[],
  shared: Shared,
  verdict: ReturnType<typeof checkHardLimits>,
  expires: string,
  labelOf: (r: RankedItem) => string,
) {
  const names = items.map((i) => i.r.item.name);
  const list =
    names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const n = shared.emailable_ids.length;
  const evidence = items.flatMap(({ r }) => evidenceLines(r, labelOf(r)).slice(0, 3));
  const first = items[0]!;
  const fmt = fmtFor(first.r.item.currency);
  return {
    profile_id: profileId,
    module: SEGMENT_MODULE,
    originating_finding: ref,
    action: {
      kind: SEGMENT_KIND,
      summary: `Email ${n} customer${n === 1 ? "" : "s"} who said yes about ${list}`,
      detail: {
        segment: EMAIL_SEGMENT,
        label: shared.email_segment.label,
        what: `One email, in your voice, showing ${list} to your best customers who said yes to email: what each is and that it's in stock. No discount, no invented offer. I can't see who bought what, because your customer list carries totals, not products, so it goes to your best customers rather than to buyers of similar items.`,
        contact_ids: shared.emailable_ids,
        in_segment: shared.email_segment.in_segment,
        excluded: shared.email_segment.excluded,
        evidence: [...shared.email_segment.evidence, ...evidence],
        stock: items.map(({ r }) => stockDetail(r, labelOf(r))),
        option: "email",
        efficiency: items.map(
          ({ option, r }) => `${r.item.name}: ${efficiencyLine(option, fmtFor(r.item.currency))}`,
        ),
        arithmetic: items.map(({ option }) => option.arithmetic).join("; "),
        sending:
          "Nothing sends on approval. Approving lets me draft the email; nothing sends until you approve the finished email itself, and then every recipient's consent is checked again at the moment it goes.",
        manual_limits: verdict.manual.map((l) => l.quote),
      },
    },
    scenario: {
      ...scenarioFor(first.option, first.r, evidence, fmt),
      base_case: {
        case: "base" as const,
        statement: items
          .map(
            ({ option, r }) =>
              `${r.item.name}: about ${fmtFor(r.item.currency)(option.recovered.expected)} back`,
          )
          .join("; "),
        profit_delta_monthly: null,
        formula: items.map(({ option }) => option.arithmetic).join("; "),
      },
    } as never,
    reversibility: first.option.reversibility,
    expires_at: expires,
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  };
}

/**
 * The weekly sweep: every business in care, one failure never stopping the
 * rest. Clearing slow stock (feature 34), then reorder notes for what runs
 * low (P5-03).
 */
export async function runStockProposals(
  now: Date = new Date(),
  opts: { limitLlm?: LimitLlm } = {},
): Promise<{ created: number; blocked: number; failed: number }> {
  const inCare = await db
    .selectDistinct({ profile_id: modeDecisions.profile_id })
    .from(modeDecisions);
  let created = 0;
  let blocked = 0;
  let failed = 0;
  for (const { profile_id } of inCare) {
    try {
      const run = await proposeClearance(profile_id, { now, ...opts });
      created += run.created.length;
      blocked += run.blocked.length;
      // P5-03: items running low get a reorder note — a note, never an order.
      const notes = await proposeReorders(profile_id, { now, ...opts });
      created += notes.created.length;
      blocked += notes.blocked.length;
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({ event: "stock_proposals_failed", profile_id, ...logSafeError(error) }),
      );
    }
  }
  return { created, blocked, failed };
}
