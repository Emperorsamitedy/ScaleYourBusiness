// Per-campaign readback for customer email — P4-17 (Phase 4 Session F).
//
// A sent win-back or thank-you is judged like everything else — helped,
// did nothing, backfired, or the two honest non-verdicts — against what its
// own proposal predicted:
//
//   win-back   "Some of them come back; the readback counts the orders that follow."
//   thank-you  "They feel seen; the readback watches whether they keep buying."
//
// So the outcome that matters is the same question for both, asked over a
// different wait: of the recipients, how many bought again after the email —
// read from the owner's next shop export (contacts.last_purchase_at, which a
// later import refreshes; P4-13's import, extended here). Against what? The
// only baseline that invents nothing: the segment's members who were NOT
// emailed (no explicit consent, or refused at the moment of sending), as they
// stood when the send began (campaign_comparisons), asked the same question
// from the same moment. That comparison is observational, not randomised —
// those customers differ in more than the email (they never said yes to
// email) — and every sentence says so. SYB never withholds an approved send
// to build a control group: that would change what the owner approved.
// (A holdout the owner opts into is a possible future, recorded, not built.)
//
// Without a comparison group the verdict is weaker by rule: a lift alone is
// never "helped". Nobody buying again is still "did nothing", since no
// comparison could make zero purchases a gain.
//
// "Backfired" covers the harm that needs no baseline: unsubscribes plus spam
// complaints among the recipients, above a pinned rate, judged as soon as
// they happen. And a controlled comparison where the recipients bought LESS
// than the comparison group by the same margin that would have been "helped".
//
// What is not measured, and why, is said in words rather than shown as a
// noisy number: opens (no tracking pixel — under ePrivacy Art. 5(3) / PECR
// reg. 6 a pixel is itself a consent question, and Apple Mail Privacy
// Protection fires "opens" for mail nobody read), clicks (no link rewriting:
// it would route the unsubscribe link through a tracker), and replies (they
// go straight to the owner's own address, which their campaign-email consent
// names, so SYB never sees them).
//
// Pure arithmetic over recorded rows; thresholds pinned in EMAIL_READBACK
// and tested at every boundary both ways; integer cross-products so a
// boundary lands exactly. No model anywhere.

import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { campaignComparisons, campaignSends, contacts } from "../../db/schema";
import type { ProposalRow } from "../proposals/service";

export const EMAIL_READBACK = {
  /** Days between the email and the shop export that measures it, by the proposal's own scenario. */
  min_days_after: { winback: 14, vip: 28 },
  /** Recipients measured before any purchase verdict. */
  min_measured: 5,
  /** Comparison-group members measured before the comparison counts. */
  min_comparison: 5,
  /** Recipients' bought-again rate minus the comparison's, in percentage points. */
  helped_at_pp: 5,
  backfired_at_pp: -5,
  /** Unsubscribes + complaints, as a share of sent: backfired at or above this… */
  harm_rate_pct: 2,
  /** …when at least this many people did it. */
  harm_min_people: 2,
  /**
   * Spam complaints alone: backfired at one or more and at or above 0.3% of
   * sent — the ceiling Gmail's and Yahoo's bulk-sender rules set (2024).
   */
  complaint_rate_permille: 3,
} as const;

export type EmailCampaignKind = keyof typeof EMAIL_READBACK.min_days_after;
export type EmailVerdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

const DAY_MS = 86_400_000;

/* ── the pure parts ── */

/** One person in a group, as the record holds them. */
export interface Person {
  /** When "since" starts for them: their send, or the moment the send began. */
  ref_at: string;
  /** The last order date, as the latest shop export gave it. */
  last_purchase_at: string | null;
  /** When an export with a last-order column last covered them. */
  refreshed_at: string | null;
  /** Erased since (rule 22): nothing left to measure. */
  erased: boolean;
}

export interface GroupTally {
  size: number;
  erased: number;
  /** Covered by an export at least the wait after their ref moment. */
  measured: number;
  /** Of the measured: a last order on a day after their ref day. */
  returned: number;
  /** Not erased, not yet measured: a later export could still measure them. */
  waiting: number;
  /** The latest export date among the measured, or null. */
  measured_through: string | null;
}

/**
 * Pure: who in a group bought again. A purchase counts from the day AFTER
 * the email: the export gives only the day, so a same-day order can't be
 * told apart from one placed before the email arrived.
 */
export function tallyGroup(people: readonly Person[], minDays: number): GroupTally {
  const t: GroupTally = {
    size: people.length,
    erased: 0,
    measured: 0,
    returned: 0,
    waiting: 0,
    measured_through: null,
  };
  for (const p of people) {
    if (p.erased) {
      t.erased++;
      continue;
    }
    const ref = Date.parse(p.ref_at);
    const refreshed = p.refreshed_at === null ? NaN : Date.parse(p.refreshed_at);
    if (!(refreshed >= ref + minDays * DAY_MS)) {
      t.waiting++;
      continue;
    }
    t.measured++;
    if (p.refreshed_at && (t.measured_through === null || p.refreshed_at > t.measured_through)) {
      t.measured_through = p.refreshed_at;
    }
    if (p.last_purchase_at !== null && p.last_purchase_at.slice(0, 10) > p.ref_at.slice(0, 10)) {
      t.returned++;
    }
  }
  return t;
}

export interface DeliveryTally {
  /** Confirmed sent (Resend answered with an id). */
  sent: number;
  /** May have gone out; never re-sent, never counted as sent. */
  unknown: number;
  delivered: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  /** Distinct recipients who unsubscribed, complained, or both. */
  harmed: number;
}

export interface EmailJudgeInput {
  kind: EmailCampaignKind;
  delivery: DeliveryTally;
  recipients: GroupTally;
  comparison: GroupTally;
  /** The first send's day, for the wording. */
  sent_on: string | null;
}

export interface EmailJudgement {
  verdict: EmailVerdict;
  /** Recipients' bought-again rate minus the comparison's, percentage points, 1 decimal; null when not compared. */
  lift_pp: number | null;
  controlled: boolean;
  /** The arithmetic, with the real numbers in it — always present. */
  arithmetic: string;
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const GROUP_WORD: Record<EmailCampaignKind, string> = {
  winback: "lapsed customers",
  vip: "best customers",
};

/** Pure: is the harm alone enough to call it backfired? */
export function harmBackfired(d: DeliveryTally): "harm" | "complaints" | null {
  const R = EMAIL_READBACK;
  if (d.sent === 0) return null;
  if (d.complained >= 1 && d.complained * 1000 >= d.sent * R.complaint_rate_permille) {
    return "complaints";
  }
  if (d.harmed >= R.harm_min_people && d.harmed * 100 >= d.sent * R.harm_rate_pct) return "harm";
  return null;
}

/** Pure: the verdict from the tallies. */
export function judgeEmailCampaign(input: EmailJudgeInput): EmailJudgement {
  const R = EMAIL_READBACK;
  const { delivery: d, recipients: r, comparison: c, kind } = input;
  const wait = R.min_days_after[kind];
  const harmLine =
    `${plural(d.harmed, "recipient")} unsubscribed or marked it as spam ` +
    `(${d.unsubscribed} unsubscribed, ${d.complained} complained) of ${d.sent} sent, ${pct(d.harmed, d.sent)}` +
    ` — backfired at ${R.harm_rate_pct}% with at least ${R.harm_min_people} people, or any complaints at ${R.complaint_rate_permille / 10}% or more`;
  const result = (
    verdict: EmailVerdict,
    lines: string[],
    extra: Partial<EmailJudgement> = {},
  ): EmailJudgement => ({
    verdict,
    lift_pp: null,
    controlled: false,
    arithmetic: lines.join("; "),
    ...extra,
  });

  if (d.sent === 0) return result("unmeasured", ["nothing was sent — nothing to measure"]);

  const harm = harmBackfired(d);
  if (harm) return result("backfired", [harmLine]);

  const boughtLine = `bought again since: ${r.returned} of ${r.measured} measured recipients (${pct(r.returned, r.measured)})`;
  if (r.measured < R.min_measured) {
    const why =
      r.measured === 0 && r.waiting > 0
        ? `no shop export covering them has come in at least ${wait} days after the email${input.sent_on ? ` of ${input.sent_on}` : ""} — import one and the verdict becomes possible`
        : `${plural(r.measured, "recipient")} measured by a shop export at least ${wait} days after the email — the verdict needs ${R.min_measured}`;
    const verdict: EmailVerdict =
      r.measured + r.waiting >= R.min_measured ? "too_early" : "unmeasured";
    return result(verdict, [
      harmLine,
      verdict === "unmeasured"
        ? `only ${plural(r.measured + r.waiting, "recipient")} can ever be measured (${r.erased} erased) — the verdict needs ${R.min_measured}`
        : why,
    ]);
  }

  if (c.measured >= R.min_comparison) {
    // diff_pp × Rm × Cm = 100 × (Rr × Cm − Cr × Rm), exact in integers.
    const scaled = 100 * (r.returned * c.measured - c.returned * r.measured);
    const denom = r.measured * c.measured;
    const lift = Math.round((scaled / denom) * 10) / 10;
    const verdict: EmailVerdict =
      scaled >= R.helped_at_pp * denom
        ? "helped"
        : scaled <= R.backfired_at_pp * denom
          ? "backfired"
          : "did_nothing";
    return result(
      verdict,
      [
        harmLine,
        `${boughtLine}, against ${c.returned} of ${c.measured} ${GROUP_WORD[kind]} I couldn't email (${pct(c.returned, c.measured)})` +
          ` — ${lift >= 0 ? "+" : "−"}${Math.abs(lift).toFixed(1)} points (helped at +${R.helped_at_pp}, backfired at −${Math.abs(R.backfired_at_pp)})`,
        "not randomised: the comparison group never said yes to email, so they differ in more than the email",
      ],
      { lift_pp: lift, controlled: true },
    );
  }

  const uncontrolled = `${plural(c.measured, "comparison customer")} measured — the comparison needs ${R.min_comparison}`;
  if (r.returned === 0) {
    return result("did_nothing", [
      harmLine,
      boughtLine,
      `nobody bought again, so no comparison could make it a gain (${uncontrolled})`,
    ]);
  }
  if (c.measured + c.waiting >= R.min_comparison) {
    return result("too_early", [
      harmLine,
      boughtLine,
      `${uncontrolled}; the next export can measure the rest`,
    ]);
  }
  return result("unmeasured", [
    harmLine,
    boughtLine,
    `uncontrolled: ${uncontrolled}, so I can't say the email caused it — a lift alone is never "helped"`,
  ]);
}

/* ── the database side ── */

export interface EmailCampaignOutcome extends EmailJudgement {
  kind: EmailCampaignKind;
  delivery: DeliveryTally;
  recipients: GroupTally;
  comparison: GroupTally;
  sent_on: string | null;
}

/** Pure: which scenario a campaign proposal is judged against. */
export function campaignKind(action: unknown): EmailCampaignKind {
  const segment = (action as { detail?: { segment?: unknown } } | null)?.detail?.segment;
  return segment === "vip" ? "vip" : "winback";
}

/** Judge one sent campaign from its send rows, its comparison group and the latest exports. */
export async function emailCampaignOutcome(
  proposal: Pick<ProposalRow, "id" | "action">,
): Promise<EmailCampaignOutcome> {
  const kind = campaignKind(proposal.action);
  const wait = EMAIL_READBACK.min_days_after[kind];
  const sends = await db
    .select({
      status: campaignSends.status,
      contact_id: campaignSends.contact_id,
      created_at: campaignSends.created_at,
      sent_at: campaignSends.sent_at,
      delivered_at: campaignSends.delivered_at,
      bounced_at: campaignSends.bounced_at,
      complained_at: campaignSends.complained_at,
      unsubscribed_at: campaignSends.unsubscribed_at,
    })
    .from(campaignSends)
    .where(eq(campaignSends.proposal_id, proposal.id));
  const comparisonRows = await db
    .select({
      contact_id: campaignComparisons.contact_id,
      snapshot_at: campaignComparisons.snapshot_at,
    })
    .from(campaignComparisons)
    .where(eq(campaignComparisons.proposal_id, proposal.id));

  const ids = [
    ...new Set(
      [...sends, ...comparisonRows]
        .map((r) => r.contact_id)
        .filter((id): id is string => id !== null),
    ),
  ];
  const people = ids.length
    ? await db
        .select({
          id: contacts.id,
          last_purchase_at: contacts.last_purchase_at,
          refreshed_at: contacts.purchase_refreshed_at,
        })
        .from(contacts)
        .where(inArray(contacts.id, ids))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  // Postgres hands timestamps back in its own text form; compare them as ISO.
  const iso = (t: string | null | undefined): string | null =>
    t ? new Date(t).toISOString() : null;
  const person = (contactId: string | null, refAt: string): Person => {
    const p = contactId ? byId.get(contactId) : undefined;
    return {
      ref_at: iso(refAt) ?? refAt,
      last_purchase_at: iso(p?.last_purchase_at),
      refreshed_at: iso(p?.refreshed_at),
      erased: p === undefined,
    };
  };

  const sent = sends.filter((s) => s.status === "sent");
  const delivery: DeliveryTally = {
    sent: sent.length,
    unknown: sends.filter((s) => s.status === "unknown" || s.status === "sending").length,
    delivered: sent.filter((s) => s.delivered_at !== null).length,
    bounced: sent.filter((s) => s.bounced_at !== null).length,
    complained: sent.filter((s) => s.complained_at !== null).length,
    unsubscribed: sent.filter((s) => s.unsubscribed_at !== null).length,
    harmed: sent.filter((s) => s.complained_at !== null || s.unsubscribed_at !== null).length,
  };
  const recipients = tallyGroup(
    sent.map((s) => person(s.contact_id, s.sent_at ?? s.created_at)),
    wait,
  );
  // Not emailed: the segment's other members, and anyone refused at the moment of sending.
  const comparison = tallyGroup(
    [
      ...comparisonRows.map((r) => person(r.contact_id, r.snapshot_at)),
      ...sends.filter((s) => s.status === "refused").map((s) => person(s.contact_id, s.created_at)),
    ],
    wait,
  );
  const firstSent = sent
    .map((s) => s.sent_at)
    .filter((t): t is string => t !== null)
    .sort()[0];
  const sent_on = firstSent ? new Date(firstSent).toISOString().slice(0, 10) : null;
  const judgement = judgeEmailCampaign({ kind, delivery, recipients, comparison, sent_on });
  return { ...judgement, kind, delivery, recipients, comparison, sent_on };
}
