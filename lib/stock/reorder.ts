// Reorder suggestions, as notes — Phase 5 Session A (P5-03, rule 27).
//
// A stock-out warning (./warnings) can carry one proposal: a note that the
// item wants reordering, with the quantity's arithmetic from the owner's own
// sales, delivery time and minimum order (./cover's reorderFor). Its action
// kind is "stock_reorder_note" (NOTE_KINDS), which no executor knows and the
// due runner leaves unrouted: approving it writes the owner's decision and
// nothing else. SYB never places, edits or cancels a supplier order, and
// nothing in this file can reach a supplier, a shop or the network.
//
// The same guards as every proposal: the owner's standing rules first (rule
// 14 — a limit that names the kind blocks it, visibly; manual limits ride
// along), then suppression (three declines silence the kind, P3-28), then
// createProposal, which writes the proposal and its decision-log entry
// together. Nothing is proposed before a business is in care or while it is
// watched (rule 15); the /stock screen still shows the arithmetic. One note
// per item per month, raced safely by the stock unique index (0053).

import { and, eq, like } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, proposals } from "../../db/schema";
import { careState } from "../care/day-zero";
import type { HardLimit, LimitLlm, LimitVerdict, NoteKind } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { NewProposal, ProposalRow } from "../proposals/service";
import { suppressedKinds } from "../trust/suppression";
import type { CoverRow, CoverView } from "./cover-load";
import { loadCover } from "./cover-load";
import { stockApplies } from "./load";
import type { StockProposalOutcome } from "./propose";
import { STOCK_MODULE, createOnce, fmtFor } from "./propose";

export const REORDER_KIND: NoteKind = "stock_reorder_note";

export const REORDER = {
  /** A reorder note is about this week's stock: it lapses after this many days. */
  expiry_days: 14,
} as const;

const monthOf = (now: Date) => now.toISOString().slice(0, 7);

/** The ref a reorder note is deduped by: once per item per month. */
export function reorderRef(row: Pick<CoverRow, "item">, now: Date): string {
  return `stock:reorder:${row.item.connection_id}:${row.item.ref}:${monthOf(now)}`;
}

/** Why nothing may be proposed yet, or null when it may (rule 15). */
export async function reorderHold(profileId: string, now: Date): Promise<string | null> {
  if (!(await stockApplies(profileId))) return "the business doesn't hold stock";
  const care = await careState(profileId);
  if (!care) return "not in care yet — no mode decision";
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    return `still watching until ${care.watch_ends_at.slice(0, 10)} — nothing is proposed before then (rule 15)`;
  }
  return null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Pure: the note's proposal, from one warned row. */
export function reorderProposal(
  profileId: string,
  row: CoverRow,
  now: Date,
  verdict: LimitVerdict,
): NewProposal {
  const { item, cover: c } = row;
  const r = c.reorder!;
  const w = c.warning!;
  const lead = c.lead;
  const fmt = fmtFor(item.currency);
  const from = lead.supplier ? ` from ${lead.supplier.name}` : "";
  const supplierWord = lead.supplier?.name ?? "your supplier";
  const evidence = [
    `${item.on_hand} on hand, read from ${row.source} on ${item.as_of}`,
    c.rate
      ? `${c.rate.units} sold in ${plural(c.rate.over_days, "day")}: ${c.rate.per_day.toFixed(1)} a day (${c.rate.low.toFixed(1)}–${c.rate.high.toFixed(1)})`
      : "no rate of sale",
    c.sell_through.sentence,
    `delivery time: ${lead.why}`,
    ...(c.boosted && c.boost ? [c.boost.sentence] : []),
    `${w.flag}: ${w.sentence}`,
  ];
  const assumptions: NewProposal["scenario"]["assumptions"] = [
    {
      statement: `${item.on_hand} on hand, and ${c.rate?.units ?? 0} sold in the last ${plural(c.rate?.over_days ?? 0, "day")}`,
      value: null,
      source_field: null,
      measured: c.sources,
      sensitivity: "high",
    },
    {
      statement: `Delivery time: ${lead.why}`,
      value: lead.days,
      source_field: lead.source_field,
      sensitivity: "high",
    },
    ...(r.moq !== null
      ? [
          {
            statement: `Minimum order: ${r.moq}`,
            value: r.moq,
            source_field: lead.moq_field,
            sensitivity: "medium" as const,
          },
        ]
      : []),
    ...c.assumed.slice(1).map((a) => ({
      statement: a,
      value: null,
      source_field: null,
      sensitivity: "medium" as const,
    })),
  ];
  const runsOut = c.runs_out
    ? c.runs_out.latest === null || c.runs_out.latest === c.runs_out.earliest
      ? c.runs_out.earliest
      : `${c.runs_out.earliest} to ${c.runs_out.latest}`
    : "soon";
  return {
    profile_id: profileId,
    module: STOCK_MODULE,
    originating_finding: reorderRef(row, now),
    action: {
      kind: REORDER_KIND,
      summary: `Reorder ${r.quantity} × ${item.name}${from} — a note for you, not an order`,
      detail: {
        note_only: true,
        stock: {
          connection_id: item.connection_id,
          ref: item.ref,
          name: item.name,
          source: row.source,
          as_of: item.as_of,
          on_hand: item.on_hand,
          currency: item.currency,
          offer_id: item.offer_id,
        },
        cover: {
          low: c.cover ? Math.round(c.cover.low * 10) / 10 : null,
          mid: c.cover ? Math.round(c.cover.mid * 10) / 10 : null,
          high: c.cover?.high == null ? null : Math.round(c.cover.high * 10) / 10,
          runs_out: c.runs_out,
          level: w.level,
          flag: w.flag,
          sentence: w.sentence,
        },
        lead: {
          days: lead.days,
          basis: lead.basis,
          supplier: lead.supplier,
          why: lead.why,
          source_field: lead.source_field,
        },
        reorder: r,
        season:
          c.boosted && c.boost ? { sentence: c.boost.sentence, multiple: c.boost.multiple } : null,
        arithmetic: r.arithmetic,
        evidence,
        assumed: c.assumed,
        sources: c.sources,
        manual_limits: verdict.manual.map((l) => l.quote),
        sending: `Approving records that you mean to reorder, and nothing else. I don't contact ${supplierWord}, and I never place, change or cancel an order: you do.`,
      },
    },
    scenario: {
      assumptions,
      base_case: {
        case: "base",
        statement: `Ordered today, ${r.quantity} arrive in about ${plural(lead.days, "day")}${r.cost ? `, about ${fmt(r.cost.amount_minor)} at cost` : ""}; ${item.name} is expected to run out ${runsOut}.`,
        profit_delta_monthly: null,
        formula: r.arithmetic,
      },
      downside_case: {
        case: "downside",
        statement:
          w.level === "before_restock"
            ? `Even ordered today, ${item.name} likely sells out before the delivery lands: the gap is lost sales, not stock.`
            : `If it sells at the fast end, ${item.name} runs out before the delivery lands.`,
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: `If it sells at the slow end, ${item.name} outlasts the delivery and the extra units sit as stock.`,
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: `Nothing to break even on: a note costs nothing. The order itself is yours to weigh${r.cost_arithmetic ? ` — ${r.cost_arithmetic}` : ""}.`,
    },
    reversibility: {
      level: "easy",
      if_you_change_your_mind: "Nothing was ordered, so there is nothing to undo.",
    },
    expires_at: new Date(now.getTime() + REORDER.expiry_days * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  };
}

/**
 * Propose a reorder note for every item running low. Honest about every
 * skip: not in care, watching, nothing running low, suppressed, already
 * proposed this month.
 */
export async function proposeReorders(
  profileId: string,
  opts: { now?: Date; limitLlm?: LimitLlm; view?: CoverView } = {},
): Promise<StockProposalOutcome> {
  const now = opts.now ?? new Date();
  const out: StockProposalOutcome = { created: [], blocked: [], skipped: [] };
  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) return out;
  const hold = await reorderHold(profileId, now);
  if (hold !== null) {
    out.skipped.push({ ref: "profile", reason: hold });
    return out;
  }
  const view = opts.view ?? (await loadCover(profile.account_id, profileId, now));
  const warned = view.warnings.filter((r) => r.cover.reorder !== null);
  if (warned.length === 0) {
    out.skipped.push({ ref: "profile", reason: "nothing is running low" });
    return out;
  }
  const existing = new Set(
    (
      await db
        .select({ ref: proposals.originating_finding })
        .from(proposals)
        .where(
          and(
            eq(proposals.profile_id, profileId),
            like(proposals.originating_finding, "stock:reorder:%"),
          ),
        )
    ).map((r) => r.ref),
  );
  const silenced = (await suppressedKinds(profileId)).get(REORDER_KIND);
  let limits: HardLimit[] | null = null;
  for (const row of warned) {
    const ref = reorderRef(row, now);
    if (existing.has(ref)) {
      out.skipped.push({ ref, reason: "already proposed this month" });
      continue;
    }
    if (silenced) {
      out.skipped.push({
        ref,
        reason: `you've declined reorder notes ${silenced.rejections} times — I've stopped proposing them`,
      });
      continue;
    }
    limits ??= (await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm)).limits;
    const verdict = checkHardLimits(limits, REORDER_KIND);
    const created: ProposalRow | null = await createOnce(
      reorderProposal(profileId, row, now, verdict),
    );
    if (created === null) {
      out.skipped.push({ ref, reason: "already proposed this month" });
      continue;
    }
    (verdict.verdict === "blocked" ? out.blocked : out.created).push(created);
  }
  console.log(
    JSON.stringify({
      event: "stock_reorder_notes",
      profile_id: profileId,
      account_id: profile.account_id,
      warned: warned.length,
      created: out.created.length,
      blocked: out.blocked.length,
      skipped: out.skipped.length,
    }),
  );
  return out;
}
