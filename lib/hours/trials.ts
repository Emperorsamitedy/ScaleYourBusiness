// Trading-hours trials — P3-41 (Phase 3 Session I).
//
// The analysis (P2-30) can only SUGGEST: a closed hour records no sales.
// So a signal never becomes a recommendation taken on faith — it becomes
// a four-week TRIAL in the approval queue, with three scenarios worked
// in minor units, and afterwards a verdict from what was measured.
//
//   open earlier   the new hour earns some share of today's first hour,
//                  minus what an open hour costs
//                    downside 25% · base 50% · upside 100%
//   close earlier  the hour's cost is saved, minus the share of the last
//                  hour's takings that is lost rather than moved earlier
//                    downside 100% lost · base 50% · upside 0%
//
// The shares are assumptions, stated as such on the card, and the trial
// exists precisely to replace them with a measurement. Nothing here
// touches the business's Google listing or website: the owner changes
// their own hours (rule 12 — and a listing edit would be a write no
// connector holds). Watching mode (rule 15), hard limits (rule 14) and
// decline-suppression (P3-28) apply as to every proposal. One trial per
// weekday at a time, so two verdicts never mix.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { modeDecisions, proposals } from "../../db/schema";
import { careState } from "../care/day-zero";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { readCurrentField, writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import type { ProposalOutcome } from "../trust/readback";
import { READBACK } from "../trust/readback";
import { shiftDay } from "../trust/series";
import { suppressedKinds } from "../trust/suppression";
import { parseCompetitorHours } from "./competitors";
import type { Weekday } from "./schedule";
import type { WeekdayAnalysis } from "./trading";
import { TRIALS_KEY, label, loadTradingSales, openHourCost, tradingAnalysis } from "./trading";

export const HOURS_MODULE = "hours";
export const TRIAL_KIND = "operations_change";

export const TRIAL = {
  weeks: 4,
  /** Share of today's first-hour takings the new earlier hour earns. */
  earlier_share: { downside: 0.25, base: 0.5, upside: 1 },
  /** Share of the last hour's takings lost (not moved earlier) by closing an hour sooner. */
  lost_share: { downside: 1, base: 0.5, upside: 0 },
  /** Fewer measured trial days than this: too_early. */
  min_trial_days: 3,
  expiry_days: 14,
} as const;

const DAY_WORD: Record<Weekday, string> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};

export type TrialChange = "open_earlier" | "close_earlier";

export interface TrialDetail {
  weekday: Weekday;
  change: TrialChange;
  /** Trading-day hours: the hour gained or given up. */
  hour: number;
  trial_weeks: number;
  currency: string;
  /** The measured mean the scenarios rest on: first-hour or last-hour takings. */
  anchor_minor: number;
  hour_cost_minor: number | null;
}

type Fmt = (minor: number) => string;

function outcome(
  c: "base" | "downside" | "upside",
  perDay: number,
  currency: string,
  fmt: Fmt,
  formula: string,
  costKnown: boolean,
) {
  const total = perDay * TRIAL.weeks;
  return {
    case: c,
    statement: `${total >= 0 ? "+" : "−"}${fmt(Math.abs(total))} over the ${TRIAL.weeks}-week trial${costKnown ? "" : " in takings (cost of an open hour unknown, so not profit)"}`,
    profit_delta_monthly: costKnown ? money(total, currency) : null,
    formula: `${formula} = ${perDay >= 0 ? "+" : "−"}${fmt(Math.abs(perDay))} a day × ${TRIAL.weeks} = ${total >= 0 ? "+" : "−"}${fmt(Math.abs(total))}`,
  };
}

/** Pure: the trial proposal's text and scenarios for one weekday signal. Exported for tests. */
export function trialFor(
  w: WeekdayAnalysis,
  change: TrialChange,
  currency: string,
  costMinor: number | null,
  fmt: Fmt,
): { summary: string; detail: TrialDetail; scenario: unknown } | null {
  if (w.first_hour === null || w.last_hour === null) return null;
  const cost = costMinor ?? 0;
  const costKnown = costMinor !== null;
  const days = DAY_WORD[w.weekday];

  if (change === "open_earlier") {
    const hour = w.first_hour - 1;
    const first = w.curve.find((c) => c.hour === w.first_hour)?.mean_minor ?? 0;
    const per = (share: number) => Math.round(first * share) - cost;
    const formula = (share: number) =>
      `${share * 100}% × ${fmt(first)} first-hour takings${costKnown ? ` − ${fmt(cost)} open-hour cost` : ""}`;
    return {
      summary: `Open at ${label(hour)} on ${days} for ${TRIAL.weeks} weeks (a trial)`,
      detail: {
        weekday: w.weekday,
        change,
        hour,
        trial_weeks: TRIAL.weeks,
        currency,
        anchor_minor: first,
        hour_cost_minor: costMinor,
      },
      scenario: {
        assumptions: [
          {
            statement: `Your first hour (${label(w.first_hour)}) averages ${fmt(first)} on ${days}, measured over ${w.days_measured} days`,
            value: money(first, currency),
            source_field: "connector:revenue.hourly",
            sensitivity: "high",
          },
          {
            statement: `The new ${label(hour)} hour earns ${TRIAL.earlier_share.downside * 100}–${TRIAL.earlier_share.upside * 100}% of that — an assumption; the trial measures it`,
            value: null,
            source_field: null,
            sensitivity: "high",
          },
          {
            statement: costKnown
              ? `One open hour costs ${fmt(cost)} (your answer)`
              : "What an open hour costs isn't known, so these are takings, not profit",
            value: costKnown ? money(cost, currency) : null,
            source_field: costKnown ? "presence.open_hour_cost" : null,
            sensitivity: "medium",
          },
        ],
        downside_case: outcome(
          "downside",
          per(TRIAL.earlier_share.downside),
          currency,
          fmt,
          formula(TRIAL.earlier_share.downside),
          costKnown,
        ),
        base_case: outcome(
          "base",
          per(TRIAL.earlier_share.base),
          currency,
          fmt,
          formula(TRIAL.earlier_share.base),
          costKnown,
        ),
        upside_case: outcome(
          "upside",
          per(TRIAL.earlier_share.upside),
          currency,
          fmt,
          formula(TRIAL.earlier_share.upside),
          costKnown,
        ),
        breakeven_condition: costKnown
          ? first > 0
            ? `pays for itself if the new hour takes at least ${fmt(cost)} — ${Math.round((cost / first) * 100)}% of today's first hour`
            : "today's first hour takes nothing, so an earlier one is unlikely to pay"
          : "not computable without the cost of an open hour",
      },
    };
  }

  const hour = w.last_hour;
  const last = w.curve.find((c) => c.hour === w.last_hour)?.mean_minor ?? 0;
  if (!costKnown) return null; // closing earlier only makes sense against what the hour costs
  const per = (lost: number) => cost - Math.round(last * lost);
  const formula = (lost: number) =>
    `${fmt(cost)} open-hour cost saved − ${lost * 100}% × ${fmt(last)} last-hour takings lost`;
  return {
    summary: `Close at ${label(hour)} on ${days} — one hour sooner — for ${TRIAL.weeks} weeks (a trial)`,
    detail: {
      weekday: w.weekday,
      change,
      hour,
      trial_weeks: TRIAL.weeks,
      currency,
      anchor_minor: last,
      hour_cost_minor: costMinor,
    },
    scenario: {
      assumptions: [
        {
          statement: `Your last hour (${label(hour)}) averages ${fmt(last)} on ${days}, measured over ${w.days_measured} days`,
          value: money(last, currency),
          source_field: "connector:revenue.hourly",
          sensitivity: "high",
        },
        {
          statement: `One open hour costs ${fmt(cost)} (your answer)`,
          value: money(cost, currency),
          source_field: "presence.open_hour_cost",
          sensitivity: "high",
        },
        {
          statement:
            "Some of the last hour's customers come earlier instead; how many is an assumption the trial measures",
          value: null,
          source_field: null,
          sensitivity: "high",
        },
      ],
      downside_case: outcome(
        "downside",
        per(TRIAL.lost_share.downside),
        currency,
        fmt,
        formula(TRIAL.lost_share.downside),
        true,
      ),
      base_case: outcome(
        "base",
        per(TRIAL.lost_share.base),
        currency,
        fmt,
        formula(TRIAL.lost_share.base),
        true,
      ),
      upside_case: outcome(
        "upside",
        per(TRIAL.lost_share.upside),
        currency,
        fmt,
        formula(TRIAL.lost_share.upside),
        true,
      ),
      breakeven_condition: `pays if less than ${fmt(cost)} a night is lost — ${last > 0 ? Math.round((cost / last) * 100) : 100}% of today's last hour`,
    },
  };
}

export interface TrialRunResult {
  created: ProposalRow[];
  skipped: { ref: string; reason: string }[];
}

/** A trial still pending or inside its weeks, per weekday — one at a time. */
async function weekdaysInTrial(profileId: string, now: Date): Promise<Set<Weekday>> {
  const rows = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, HOURS_MODULE)));
  const busy = new Set<Weekday>();
  for (const row of rows) {
    const detail = (row.action as { detail?: TrialDetail }).detail;
    if (!detail) continue;
    const live =
      row.status === "pending" ||
      ((row.status === "approved" || row.status === "executed") &&
        row.decided_at !== null &&
        now.getTime() < Date.parse(row.decided_at) + (detail.trial_weeks * 7 + 7) * 86_400_000);
    if (live) busy.add(detail.weekday);
  }
  return busy;
}

/**
 * Turn this month's signals into trial proposals. Idempotent per weekday,
 * change and month, at zero model cost once the owner's limits are parsed.
 */
export async function proposeHoursTrials(
  profileId: string,
  opts: {
    now?: Date;
    limitLlm?: LimitLlm;
    format?: (minor: number, currency: string) => string;
  } = {},
): Promise<TrialRunResult> {
  const now = opts.now ?? new Date();
  const out: TrialRunResult = { created: [], skipped: [] };
  const care = await careState(profileId);
  if (!care) {
    out.skipped.push({ ref: "profile", reason: "not in care yet — no mode decision" });
    return out;
  }
  if (care.watch_ends_at && now.toISOString() < care.watch_ends_at) {
    out.skipped.push({
      ref: "profile",
      reason: `still watching until ${care.watch_ends_at.slice(0, 10)} — nothing is proposed before then (rule 15)`,
    });
    return out;
  }
  const analysis = await tradingAnalysis(profileId, now);
  if (analysis.status !== "ok") {
    out.skipped.push({ ref: "profile", reason: analysis.reason });
    return out;
  }
  const fmt: Fmt = (m) =>
    (opts.format ?? ((x: number, c: string) => `${(x / 100).toFixed(2)} ${c}`))(
      m,
      analysis.currency,
    );
  const cost = await openHourCost(profileId, analysis.currency);
  const busy = await weekdaysInTrial(profileId, now);
  const existing = new Set(
    (
      await db
        .select({ ref: proposals.originating_finding })
        .from(proposals)
        .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, HOURS_MODULE)))
    ).map((r) => r.ref),
  );
  const suppression = (await suppressedKinds(profileId)).get(TRIAL_KIND);
  const { limits } = await ensureHardLimits(profileId, opts.limitLlm ?? liveLimitLlm);
  const verdict = checkHardLimits(limits, TRIAL_KIND);
  const month = now.toISOString().slice(0, 7);

  for (const w of analysis.weekdays) {
    const changes: TrialChange[] = [];
    if (w.opening_signal) changes.push("open_earlier");
    if (w.closing_signal) changes.push("close_earlier");
    for (const change of changes) {
      const ref = `hours:${w.weekday}:${change}:${month}`;
      if (existing.has(ref)) {
        out.skipped.push({ ref, reason: "already proposed this month" });
        continue;
      }
      if (busy.has(w.weekday)) {
        out.skipped.push({
          ref,
          reason: `a trial on ${DAY_WORD[w.weekday]} is already running — one at a time`,
        });
        continue;
      }
      if (suppression) {
        out.skipped.push({
          ref,
          reason: `you've declined operations changes ${suppression.rejections} times — I've stopped proposing them`,
        });
        continue;
      }
      const trial = trialFor(w, change, analysis.currency, cost, fmt);
      if (!trial) {
        out.skipped.push({ ref, reason: "a closing trial needs the cost of an open hour" });
        continue;
      }
      const row = await createProposal({
        profile_id: profileId,
        module: HOURS_MODULE,
        originating_finding: ref,
        action: {
          kind: TRIAL_KIND,
          summary: trial.summary,
          detail: {
            ...trial.detail,
            how: "You change your own hours — we won't touch your Google listing or website. The trial starts the first such day after you approve, and the verdict comes from what's measured.",
          },
        },
        scenario: trial.scenario as never,
        reversibility: {
          level: "easy",
          if_you_change_your_mind:
            "Go back to your usual hours any week — the trial simply ends early.",
        },
        expires_at: new Date(now.getTime() + TRIAL.expiry_days * 86_400_000).toISOString(),
        blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
      });
      busy.add(w.weekday);
      out.created.push(row);
    }
  }
  return out;
}

export { TRIALS_KEY };
export const TRIALS_METHOD = "approved-hours-trials-v1";

export interface RunningTrial {
  proposal_id: string;
  weekday: Weekday;
  change: TrialChange;
  /** Trading-day hour gained or given up. */
  hour: number;
  /** First and last trading day of the trial, inclusive. */
  from: string;
  to: string;
}

/** The trading days an approved trial covers: the four weeks after approval. */
export function trialWindow(decidedAt: string, weeks: number): { from: string; to: string } {
  const from = shiftDay(decidedAt.slice(0, 10), 1);
  return { from, to: shiftDay(from, weeks * 7 - 1) };
}

/**
 * Keep presence.hours_trials equal to the trials running today, so the
 * profile says "Fridays open at 19:00 until 14 Nov (a trial)" while one
 * runs and stops saying it when it ends. Written only when the list
 * changes; every change supersedes (rule 3), so the history of trials is
 * the field's own history. Derived from the owner's approvals (rule 6).
 */
export async function syncRunningTrials(
  profileId: string,
  now: Date = new Date(),
): Promise<RunningTrial[]> {
  const today = now.toISOString().slice(0, 10);
  const rows = await db
    .select()
    .from(proposals)
    .where(and(eq(proposals.profile_id, profileId), eq(proposals.module, HOURS_MODULE)));
  const running: RunningTrial[] = [];
  for (const row of rows) {
    const detail = (row.action as { detail?: TrialDetail }).detail;
    if (!detail || !row.decided_at || (row.status !== "approved" && row.status !== "executed"))
      continue;
    const window = trialWindow(row.decided_at, detail.trial_weeks);
    if (today < window.from || today > window.to) continue;
    running.push({
      proposal_id: row.id,
      weekday: detail.weekday,
      change: detail.change,
      hour: detail.hour,
      ...window,
    });
  }
  running.sort((a, b) => a.proposal_id.localeCompare(b.proposal_id));

  const current = await readCurrentField<RunningTrial[]>(profileId, TRIALS_KEY);
  // Compared field by field: jsonb does not keep key order, so a JSON.stringify
  // of the stored value would never equal the fresh one.
  const sig = (ts: readonly RunningTrial[]) =>
    ts.map((t) => [t.proposal_id, t.weekday, t.change, t.hour, t.from, t.to].join("|")).join(";");
  if (sig(current?.value ?? []) === sig(running)) return running;
  if (!current && running.length === 0) return running;
  const at = isoDateTime(now.toISOString());
  await writeField(
    profileId,
    createField<RunningTrial[]>({
      id: fieldId(TRIALS_KEY),
      value: running,
      status: "inferred",
      confidence: confidence(0.9),
      source: {
        kind: "inferred",
        derived_from: (running.length > 0 ? running : [{ proposal_id: "none" }]).map((t) =>
          fieldId(`proposal:${t.proposal_id}`),
        ),
        method: TRIALS_METHOD,
      },
      observed_at: at,
      recorded_at: at,
      note: running.length === 0 ? "no trial running" : null,
    }),
  );
  return running;
}

/** The weekly sweep: every business in care, one failure never stopping the rest. */
export async function runHoursTrials(
  now: Date = new Date(),
): Promise<{ created: number; failed: number }> {
  const inCare = await db
    .selectDistinct({ profile_id: modeDecisions.profile_id })
    .from(modeDecisions);
  let created = 0;
  let failed = 0;
  for (const { profile_id } of inCare) {
    try {
      await syncRunningTrials(profile_id, now);
      await parseCompetitorHours(profile_id);
      created += (await proposeHoursTrials(profile_id, { now })).created.length;
    } catch (error) {
      failed++;
      console.error(
        JSON.stringify({ event: "hours_trials_failed", profile_id, message: String(error) }),
      );
    }
  }
  return { created, failed };
}

/**
 * The trial's verdict in the scorecard's own shape. A trial stays
 * "approved" — the owner changes the hours, no executor runs — so the
 * scorecard judges approved trials through this, beside executed proposals.
 */
export async function trialOutcome(
  row: ProposalRow,
  now: Date = new Date(),
): Promise<ProposalOutcome> {
  const v = await judgeHoursTrial(row, now);
  const detail = (row.action as { detail?: TrialDetail }).detail;
  const scenario = row.scenario as {
    base_case?: { statement?: string };
    assumptions?: { statement: string; sensitivity: string }[];
  } | null;
  return {
    proposal_id: row.id,
    verdict: v.verdict,
    executed_on: row.decided_at ? row.decided_at.slice(0, 10) : null,
    metric: `revenue.hourly (${detail ? DAY_WORD[detail.weekday] : "trial weekday"}, net of the hour)`,
    currency: detail?.currency ?? null,
    before: null,
    after: null,
    delta_pct: v.delta_pct,
    arithmetic: v.arithmetic,
    predicted: scenario?.base_case?.statement ?? null,
    assumptions: (scenario?.assumptions ?? []).map((a) => ({
      statement: a.statement,
      sensitivity: a.sensitivity,
    })),
  };
}

export interface TrialVerdict {
  proposal_id: string;
  verdict: "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";
  /** Net change against the weeks before, in percent; null without a verdict. */
  delta_pct: number | null;
  arithmetic: string;
}

/**
 * Judge an approved trial: the weekday's takings during the trial, net of
 * the hour's cost (added for an earlier opening, saved for an earlier
 * closing), against the same weekday's takings in the four weeks before.
 * The readback's own thresholds (±5%) decide the word.
 */
export async function judgeHoursTrial(
  row: ProposalRow,
  now: Date = new Date(),
): Promise<TrialVerdict> {
  const detail = (row.action as { detail?: TrialDetail }).detail;
  const base = { proposal_id: row.id, delta_pct: null };
  if (!detail || !row.decided_at || (row.status !== "approved" && row.status !== "executed")) {
    return { ...base, verdict: "unmeasured", arithmetic: "not an approved trial" };
  }
  const { from: start, to: end } = trialWindow(row.decided_at, detail.trial_weeks);
  const today = shiftDay(now.toISOString().slice(0, 10), -1);
  const beforeFrom = shiftDay(start, -detail.trial_weeks * 7);
  const sales = await loadTradingSales(row.profile_id, beforeFrom, end < today ? end : today);
  if ("reason" in sales) return { ...base, verdict: "unmeasured", arithmetic: sales.reason };

  const days = sales.measuredDays.get(detail.weekday) ?? [];
  const total = (d: string) => [...(sales.byDay.get(d)?.values() ?? [])].reduce((s, v) => s + v, 0);
  const before = days.filter((d) => d < start);
  const during = days.filter((d) => d >= start && d <= end);
  if (during.length < TRIAL.min_trial_days) {
    return {
      ...base,
      verdict: "too_early",
      arithmetic: `${during.length} measured trial day(s) — a verdict needs ${TRIAL.min_trial_days}`,
    };
  }
  if (before.length === 0) {
    return {
      ...base,
      verdict: "unmeasured",
      arithmetic: "no measured days before the trial to compare with",
    };
  }
  const mean = (xs: string[]) => xs.reduce((s, d) => s + total(d), 0) / xs.length;
  const cost = detail.hour_cost_minor ?? 0;
  const adjust = detail.change === "open_earlier" ? -cost : cost;
  const was = mean(before);
  const now_ = mean(during) + adjust;
  const delta = was === 0 ? 0 : (now_ - was) / was;
  const pct = Math.round(delta * 1000) / 10;
  const verdict =
    delta >= READBACK.helped_at
      ? "helped"
      : delta <= READBACK.backfired_at
        ? "backfired"
        : "did_nothing";
  const fmt = (m: number) => `${(m / 100).toFixed(2)} ${detail.currency}`;
  return {
    ...base,
    verdict,
    delta_pct: pct,
    arithmetic:
      `${DAY_WORD[detail.weekday]} averaged ${fmt(Math.round(now_))} net over ${during.length} trial day(s)` +
      `${cost ? ` (takings ${detail.change === "open_earlier" ? "minus" : "plus"} the ${fmt(cost)} hour)` : ""}` +
      `, against ${fmt(Math.round(was))} over the ${before.length} before — ${pct >= 0 ? "+" : ""}${pct}%` +
      ` (helped at +${READBACK.helped_at * 100}%, backfired at ${READBACK.backfired_at * 100}%)`,
  };
}
