// Pure helpers for the approval queue (ux-spec §2 sheet system, §8 approval
// pattern). Everything the queue shows that is arithmetic or wording lives
// here, so it is testable without a browser and without the database.

import { type BasisInput, basisOfKey, sourceLabel } from "../report/basis";
import { moneyText, num } from "../sheet/num";
import { CREATES_PAUSED_NOTE } from "../../lib/ads/ad-words";

export interface MoneyLike {
  amount_minor: number;
  currency: string;
}

export interface ScenarioOutcomeLike {
  statement: string;
  profit_delta_monthly?: MoneyLike | null;
}

export interface ReversibilityLike {
  level?: string | null;
  if_you_change_your_mind?: string | null;
}

/* ── the change: before → after, only where the data says both ── */

function isMoney(v: unknown): v is MoneyLike {
  return (
    typeof v === "object" &&
    v !== null &&
    Number.isSafeInteger((v as MoneyLike).amount_minor) &&
    typeof (v as MoneyLike).currency === "string"
  );
}

function valueWord(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isMoney(v)) return moneyText(v.amount_minor, v.currency);
  return null;
}

/**
 * The change as before → after, when the action's detail carries both
 * (`detail.before` / `detail.after`: text, a number, or Money). Null when
 * either is missing — the caller then shows the summary alone. Nothing is
 * inferred: a before/after the generator didn't state is not invented.
 */
export function changeOf(detail: unknown): { before: string; after: string } | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as { before?: unknown; after?: unknown };
  const before = valueWord(d.before);
  const after = valueWord(d.after);
  return before !== null && after !== null ? { before, after } : null;
}

/* ── the expected effect: a range, never a point ── */

/** A signed money word: "+€340", "−€120", "€0". */
export function signedMoney(m: MoneyLike): string {
  const body = moneyText(Math.abs(m.amount_minor), m.currency);
  if (m.amount_minor > 0) return `+${body}`;
  if (m.amount_minor < 0) return `−${body}`;
  return body;
}

/**
 * The monthly profit effect as a range from the downside and upside
 * cases. Null — statements only — unless BOTH ends are present, integer,
 * and in one currency (no blending, rule 1). A forecast is never shown as
 * a single point, so equal ends still read as a range of one width.
 */
export function effectRange(
  downside: ScenarioOutcomeLike | null | undefined,
  upside: ScenarioOutcomeLike | null | undefined,
): { low: MoneyLike; high: MoneyLike; text: string } | null {
  const a = downside?.profit_delta_monthly;
  const b = upside?.profit_delta_monthly;
  if (!isMoney(a) || !isMoney(b)) return null;
  if (a.currency.toUpperCase() !== b.currency.toUpperCase()) return null;
  const [low, high] = a.amount_minor <= b.amount_minor ? [a, b] : [b, a];
  return { low, high, text: `${signedMoney(low)} to ${signedMoney(high)}` };
}

/* ── reversibility: worded, and absent means permanent ── */

const LEVELS = new Set(["easy", "moderate", "hard"]);

/**
 * REVERSIBLE with its level word, or IRREVERSIBLE. A missing or
 * unrecognised reversibility is IRREVERSIBLE: no declared undo is
 * treated as permanent (db/schema.ts — null undo = irreversible,
 * labelled before approval).
 */
export function reversibilityLabel(rev: ReversibilityLike | null | undefined): {
  reversible: boolean;
  word: string;
  note: string;
} {
  const level = rev?.level ?? null;
  const note = rev?.if_you_change_your_mind?.trim() ?? "";
  if (level !== null && LEVELS.has(level)) {
    return {
      reversible: true,
      word: `REVERSIBLE · ${level.toUpperCase()} TO UNDO`,
      note,
    };
  }
  return {
    reversible: false,
    word: "IRREVERSIBLE",
    note: note || "No undo is declared for this — treat it as permanent.",
  };
}

/* ── dates and the stamp ── */

/** "Monday 19 October" — the weekday is part of a deadline. */
export function dayWord(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** "14:02" in 24-hour time. */
export function clockWord(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The first eight characters of an id — enough to find it in the log. */
export function shortRef(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

export type Decision = "approved" | "rejected" | "changes_requested";

export interface Stamp {
  decision: Decision;
  /** ISO time of the decision. */
  at: string;
  /** True when `at` is this device's clock, not the recorded time. */
  clientTime: boolean;
}

const STAMP_VERB: Record<Decision, string> = {
  approved: "APPROVED",
  rejected: "DECLINED",
  changes_requested: "CHANGES REQUESTED",
};

/** "APPROVED 14:02 · ref 3f2a9c1b" — the recorded time unless labelled otherwise. */
export function stampText(id: string, stamp: Stamp, timeZone?: string): string {
  const verb = STAMP_VERB[stamp.decision];
  const clock = clockWord(stamp.at, timeZone);
  const when = stamp.clientTime ? `${clock} (this device's clock)` : clock;
  return `${verb} ${when} · ref ${shortRef(id)}`;
}

/* ── decline reasons ── */

export const REASON_CHIPS = ["WRONG DATA", "WRONG TIMING", "TOO RISKY", "NOT MY STRATEGY"] as const;
export type ReasonChip = (typeof REASON_CHIPS)[number];

/** "WRONG DATA" → "Wrong data" — the words that land in the record. */
export function chipPhrase(chip: ReasonChip): string {
  const lower = chip.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Put a chip's phrase at the front of the reason, replacing any chip
 * phrase already there and keeping whatever the owner typed after it.
 * "" + WRONG DATA → "Wrong data"; "Wrong data — the stock is off" +
 * TOO RISKY → "Too risky — the stock is off".
 */
export function applyReasonChip(current: string, chip: ReasonChip): string {
  let rest = current.trim();
  for (const c of REASON_CHIPS) {
    const p = chipPhrase(c);
    if (rest === p) {
      rest = "";
      break;
    }
    if (rest.startsWith(`${p} — `)) {
      rest = rest.slice(p.length + 3).trim();
      break;
    }
  }
  const phrase = chipPhrase(chip);
  return rest === "" ? phrase : `${phrase} — ${rest}`;
}

/** Which chip, if any, currently leads the reason. */
export function activeChip(current: string): ReasonChip | null {
  const t = current.trim();
  for (const c of REASON_CHIPS) {
    const p = chipPhrase(c);
    if (t === p || t.startsWith(`${p} — `)) return c;
  }
  return null;
}

/* ── keyboard: roving focus between pending proposals ── */

/** True when a key press belongs to a text field, not to the queue. */
export function isTypingTarget(
  el: { tagName?: string; isContentEditable?: boolean } | null | undefined,
): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** J → +1, K → −1, clamped to the list (no wrap: the ends are the ends). */
export function moveFocus(
  ids: readonly string[],
  current: string | null,
  step: 1 | -1,
): string | null {
  if (ids.length === 0) return null;
  const i = current === null ? -1 : ids.indexOf(current);
  if (i === -1) return step === 1 ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null);
  const next = Math.min(ids.length - 1, Math.max(0, i + step));
  return ids[next] ?? null;
}

/**
 * Approve-and-advance: after deciding `decided`, the next pending
 * proposal below it in `order`, else the nearest one above, else null.
 * `pending` is what is still undecided after the decision.
 */
export function nextAfterDecision(
  order: readonly string[],
  decided: readonly string[],
  pending: ReadonlySet<string>,
): string | null {
  const gone = new Set(decided);
  const anchor = order.reduce((at, id, i) => (gone.has(id) ? Math.max(at, i) : at), -1);
  for (let i = anchor + 1; i < order.length; i++) {
    const id = order[i];
    if (id !== undefined && pending.has(id) && !gone.has(id)) return id;
  }
  for (let i = Math.min(anchor, order.length) - 1; i >= 0; i--) {
    const id = order[i];
    if (id !== undefined && pending.has(id) && !gone.has(id)) return id;
  }
  return null;
}

/* ── schedule ── */

export interface ScheduleChoice {
  key: "now" | "tomorrow" | "next_week";
  days: number | null;
}

export const SCHEDULE_CHOICES: readonly ScheduleChoice[] = [
  { key: "now", days: null },
  { key: "tomorrow", days: 1 },
  { key: "next_week", days: 7 },
];

/**
 * The execute_not_before to send for a schedule key, or null for "now"
 * (stores nothing: the proposal's own posting time, if any, is kept).
 */
export function executeNotBefore(key: string, nowMs: number): string | null {
  const days = SCHEDULE_CHOICES.find((s) => s.key === key)?.days ?? null;
  return days === null ? null : new Date(nowMs + days * 86_400_000).toISOString();
}

/* ── the approval-queue design (2026-10-17): derived lines, all from data ── */

export interface ActionLike {
  kind?: string;
  summary: string;
  detail?: unknown;
}

export interface ChangeLine {
  /** What changes, in words — "Campaign “Autumn menu”". */
  line: string;
  /** A mono qualifier under it, when the data gives one. */
  sub: string | null;
  before: string;
  after: string;
}

type Detail = Record<string, unknown>;

const asDetail = (d: unknown): Detail | null =>
  typeof d === "object" && d !== null && !Array.isArray(d) ? (d as Detail) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null;
const int = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);

/* ── P3-54: an ad, created paused, and its separate go-live ── */

interface AdBudget {
  daily_minor: number;
  currency: string;
  run_days: number;
  total_minor: number;
}

function adBudget(d: Detail): AdBudget | null {
  const b = asDetail(d.budget);
  if (!b) return null;
  const daily = int(b.daily_minor);
  const days = int(b.run_days);
  const total = int(b.total_minor);
  const currency = str(b.currency);
  return daily !== null && days !== null && total !== null && currency
    ? { daily_minor: daily, currency, run_days: days, total_minor: total }
    : null;
}

function adName(d: Detail): string {
  const ad = asDetail(d.ad);
  return str(ad?.name) ?? str(d.campaign_name) ?? str(d.item_title) ?? "the ad";
}

/** The before → after of an ad: nothing → created paused; paused → live. Null for anything else. */
function adLines(d: Detail): ChangeLine[] | null {
  const change = str(d.change);
  if (change !== "run_ad" && change !== "go_live") return null;
  const budget = adBudget(d);
  const spend = budget
    ? `up to ${moneyText(budget.daily_minor, budget.currency)} a day for ${budget.run_days} days`
    : "spends its daily budget";
  if (change === "run_ad") {
    const creates = Array.isArray(d.creates)
      ? d.creates.filter((c): c is string => typeof c === "string")
      : [];
    return [
      {
        line: `Ad “${adName(d)}”`,
        sub: creates.length > 0 ? `creates its ${creates.join(", ")}` : null,
        before: "no ad",
        after: "on Meta, paused · spends nothing",
      },
    ];
  }
  return [
    {
      line: `Ad “${adName(d)}”`,
      sub: "its ad, ad set and campaign",
      before: "paused · spends nothing",
      after: `live · ${spend}`,
    },
  ];
}

export interface AdFact {
  label: string;
  value: string;
}

/**
 * P3-54: what an ad proposal's card states beside its change — budget,
 * duration, audience, placements, what it optimises for, any special ad
 * category — and the one sentence about what can't be undone. Null for
 * anything that isn't an ad being created or put live.
 */
export function adFacts(action: ActionLike): { facts: AdFact[]; note: string | null } | null {
  const d = asDetail(action.detail);
  if (!d) return null;
  const change = str(d.change);
  if (change !== "run_ad" && change !== "go_live") return null;
  const facts: AdFact[] = [];
  const budget = adBudget(d);
  if (budget) {
    facts.push({
      label: "Budget",
      value: `${moneyText(budget.daily_minor, budget.currency)} a day · at most ${moneyText(budget.total_minor, budget.currency)} in all`,
    });
    facts.push({
      label: "Duration",
      value: `${budget.run_days} days from the day it goes live, then it stops by itself`,
    });
  }
  const audience = asDetail(d.audience);
  if (audience) {
    const where = str(audience.location);
    const age = str(audience.age);
    if (where || age)
      facts.push({
        label: "Audience",
        value: [where, age && `aged ${age}`].filter(Boolean).join(" · "),
      });
    const interests = str(audience.interests);
    if (interests) facts.push({ label: "Interests", value: interests });
    const placements = str(audience.placements);
    if (placements) facts.push({ label: "Placements", value: placements });
  }
  const goal = str(d.goal);
  if (goal) facts.push({ label: "Optimised for", value: goal });
  const special = Array.isArray(d.special_ad_categories)
    ? d.special_ad_categories.filter((c): c is string => typeof c === "string")
    : [];
  if (special.length > 0) {
    facts.push({
      label: "Special category",
      value: `${special.join(", ")} — Meta's restricted targeting applies`,
    });
  }
  const notes = Array.isArray(d.notes)
    ? d.notes.filter((n): n is string => typeof n === "string")
    : [];
  for (const n of notes) facts.push({ label: "Note", value: n });
  return {
    facts,
    note:
      change === "run_ad"
        ? (str(d.paused_note) ?? CREATES_PAUSED_NOTE)
        : "Switches on the ad, its ad set, then the campaign. Pausing it again stops the spend.",
  };
}

/** The effect's span: "a month", or an ad's own run ("over 7 days"). */
export function effectSpan(action: ActionLike): string {
  const d = asDetail(action.detail);
  const budget = d ? adBudget(d) : null;
  return budget ? `over ${budget.run_days} days` : "a month";
}

/**
 * The "what changes — before → after" lines, read from what the
 * proposal's own detail states. Null when it states no before and after:
 * the sheet then prints the summary alone rather than invent a "before".
 *
 *   - any detail with `before` / `after` (changeOf)
 *   - an ad change (detail.change "pause" | "raise_budget" with the
 *     measured spend): the campaign's average daily spend over the
 *     measured days, before and after
 *   - a customer email (detail.contact_ids): who receives it, and what
 *   - a publish (detail.platform + publish_at): not posted → posted then
 */
export function changeLines(action: ActionLike, timeZone?: string): ChangeLine[] | null {
  const d = asDetail(action.detail);
  if (!d) return null;

  const stated = changeOf(d);
  if (stated) return [{ line: "The change", sub: null, ...stated }];

  const ad = adLines(d);
  if (ad) return ad;

  const change = str(d.change);
  const name = str(d.campaign_name);
  const spend = int(d.spend_minor);
  const days = int(d.measured_days);
  const currency = str(d.currency);
  if (
    (change === "pause" || change === "raise_budget") &&
    name &&
    spend !== null &&
    days &&
    currency
  ) {
    const daily = Math.round(spend / Math.max(1, days));
    const over = `daily spend, average over ${days} measured day${days === 1 ? "" : "s"}`;
    if (change === "pause") {
      return [
        {
          line: `Campaign “${name}”`,
          sub: over,
          before: `${moneyText(daily, currency)} a day`,
          after: "paused · nothing spent",
        },
      ];
    }
    const share = typeof d.share === "number" && Number.isFinite(d.share) ? d.share : null;
    if (share !== null) {
      return [
        {
          line: `Campaign “${name}”`,
          sub: over,
          before: `${moneyText(daily, currency)} a day`,
          after: `about ${moneyText(Math.round(daily * (1 + share)), currency)} a day (+${num(share * 100)} %)`,
        },
      ];
    }
  }

  if (Array.isArray(d.contact_ids)) {
    const n = d.contact_ids.length;
    const lines: ChangeLine[] = [
      {
        line: "Audience",
        sub: str(d.label),
        before: "nobody",
        after: `${num(n)} ${n === 1 ? "person" : "people"}`,
      },
    ];
    const what = str(d.what);
    if (what) lines.push({ line: "Email", sub: null, before: "—", after: what });
    return lines;
  }

  const platform = str(d.platform);
  const at = str(d.publish_at);
  if (platform && at && !Number.isNaN(Date.parse(at))) {
    return [
      {
        line: `Post on ${platform}`,
        sub: str(d.target),
        before: "not posted",
        after: `posted ${dayWord(at, timeZone)} ${clockWord(at, timeZone)}`,
      },
    ];
  }
  return null;
}

/**
 * The primary button states the consequence (the owner's mobile design):
 * what approving this proposal asks for, from its own action data —
 * "Pause “Autumn menu”", "Send to 398 customers". "Approve" when the
 * data names no specific consequence.
 */
export function consequence(action: ActionLike): string {
  const d = asDetail(action.detail);
  if (!d) return "Approve";
  const change = str(d.change);
  // P3-54: what approving an ad asks for — creating it paused, or putting it live.
  if (change === "run_ad") return "Create the ad, paused";
  if (change === "go_live") return "Put the ad live";
  const name = str(d.campaign_name);
  if (change === "pause" && name) return `Pause “${name}”`;
  if (change === "raise_budget" && name && typeof d.share === "number") {
    return `Raise “${name}” by ${num(d.share * 100)} %`;
  }
  if (Array.isArray(d.contact_ids) && d.contact_ids.length > 0) {
    const n = d.contact_ids.length;
    return `Send to ${num(n)} ${n === 1 ? "customer" : "customers"}`;
  }
  const platform = str(d.platform);
  if (platform && str(d.publish_at)) return `Publish to ${platform}`;
  return "Approve";
}

const ORIGIN_WORDS: Record<string, string> = {
  anomaly: "an alert in your numbers",
  ads: "the ad review",
  publish: "the content plan",
  alert_review: "an alert review",
  utterance: "something you asked for",
  crm: "the customer review",
  hours: "the opening-hours review",
};

/** Where a proposal came from, in words, from its originating_finding ref. */
export function originWord(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const rec = /^report:[^:]+:rec:(\d+)$/.exec(ref);
  if (rec) return `report recommendation ${Number(rec[1]) + 1}`;
  const prefix = ref.split(":")[0] ?? "";
  return ORIGIN_WORDS[prefix] ?? ref;
}

/** The list's short reversibility: "easy to undo" … "irreversible". */
export function shortReversibility(rev: ReversibilityLike | null | undefined): string {
  const level = rev?.level ?? null;
  return level !== null && LEVELS.has(level) ? `${level} to undo` : "irreversible";
}

/* ── evidence: every line with its source and basis ── */

export interface AssumptionLike {
  statement: string;
  source_field?: string | null;
  /**
   * P3-23c: computed from measured rows rather than read from one fact —
   * the per-post evidence line. Its own source text; basis DERIVED (the
   * arithmetic is in the text).
   */
  measured?: string | null;
  sensitivity?: string;
}

export interface EvidenceLine {
  statement: string;
  /** The source half of the mono line. */
  source: string;
  /** OBSERVED · DERIVED · ESTIMATED · STATED · ASSUMED, or NOT RECORDED. */
  basis: string;
  leansHard: boolean;
}

/**
 * Each assumption as an evidence line. With a source field: the field's
 * current record decides the basis (basis.ts) and the source word; a
 * named field with no current record is NOT RECORDED. Without one it is
 * ASSUMED — basis.ts: "an input to a forecast that nobody measured or
 * stated" — never promoted to anything stronger.
 */
export function evidenceLines(
  assumptions: readonly AssumptionLike[],
  facts: Record<string, BasisInput | undefined>,
): EvidenceLine[] {
  return assumptions.map((a) => {
    const key = str(a.source_field);
    const leansHard = a.sensitivity === "high";
    if (!key) {
      const measured = str(a.measured);
      if (measured)
        return { statement: a.statement, source: measured, basis: "DERIVED", leansHard };
      return { statement: a.statement, source: "no source field", basis: "ASSUMED", leansHard };
    }
    const fact = facts[key];
    const basis = basisOfKey(key, facts);
    const source = fact ? `${sourceLabel(fact.source_kind)} · ${key}` : key;
    return { statement: a.statement, source, basis: basis ?? "NOT RECORDED", leansHard };
  });
}

/* ── the effect axis: the range on a scale that includes zero ── */

function niceStep(span: number): number {
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

/**
 * The scale and ticks for the range bar, in minor units: always spans
 * zero (an effect is read against "nothing changes"), stepped at 1 / 2 /
 * 2.5 / 5 × 10ⁿ with about four intervals.
 */
export function rangeAxis(
  lowMinor: number,
  highMinor: number,
): { scale: [number, number]; ticks: number[] } {
  const lo = Math.min(0, lowMinor, highMinor);
  const hi = Math.max(0, lowMinor, highMinor);
  const step = niceStep(hi - lo || 100);
  const start = Math.floor(lo / step) * step;
  let end = Math.ceil(hi / step) * step;
  if (end === start) end = start + step;
  const ticks: number[] = [];
  for (let t = start; t <= end + step / 1000; t += step) ticks.push(Math.round(t));
  return { scale: [start, end], ticks };
}

/* ── the masthead's review stats, from decided_at and created_at ── */

export interface DecidedLike {
  status: string;
  created_at: string;
  decided_at: string | null;
}

const HUMAN_DECISIONS = new Set(["approved", "executed", "rejected", "changes_requested"]);

/**
 * This calendar month's decisions (in `timeZone`, default the device's):
 * the median time from drafted to decided, and how many were approved
 * (approved or since executed) of all decided. Expired proposals are not
 * decisions and are not counted. Null when nothing was decided this month.
 */
export function reviewStats(
  rows: readonly DecidedLike[],
  now: Date,
  timeZone?: string,
): { medianMs: number; approved: number; decided: number } | null {
  const monthOf = (d: Date) =>
    d.toLocaleDateString("en-GB", {
      year: "numeric",
      month: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    });
  const month = monthOf(now);
  const waits: number[] = [];
  let approved = 0;
  for (const r of rows) {
    if (!HUMAN_DECISIONS.has(r.status) || !r.decided_at) continue;
    const decided = new Date(r.decided_at);
    if (monthOf(decided) !== month) continue;
    const wait = decided.getTime() - new Date(r.created_at).getTime();
    if (!Number.isFinite(wait) || wait < 0) continue;
    waits.push(wait);
    if (r.status === "approved" || r.status === "executed") approved++;
  }
  if (waits.length === 0) return null;
  waits.sort((a, b) => a - b);
  const mid = Math.floor(waits.length / 2);
  const upper = waits[mid] ?? 0;
  const medianMs = waits.length % 2 === 1 ? upper : ((waits[mid - 1] ?? 0) + upper) / 2;
  return { medianMs: Math.round(medianMs), approved, decided: waits.length };
}

/** "40 s", "2 m 40 s", "3 h 05 m", "2 d 4 h". */
export function durationWord(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} m ${String(s % 60).padStart(2, "0")} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, "0")} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** Same calendar day as `now`, in `timeZone` (default the device's). */
export function isSameDay(iso: string, now: Date, timeZone?: string): boolean {
  const day = (d: Date) => d.toLocaleDateString("en-GB", timeZone ? { timeZone } : {});
  return day(new Date(iso)) === day(now);
}

/* ── what approving actually does — only what is true ── */

/**
 * The line under the decision buttons. The design's "you can undo until
 * then" is not offered: no un-approve window exists (lib/execution — an
 * approved proposal stays approved; the emergency stop halts runs, and
 * the undo is the permanent post-run one, rule 16). So it says when it
 * can run, what the proposal itself says about sending, and that the
 * stop still holds.
 */
export function approvalNote(args: {
  /** The execute_not_before the approval would carry, or null. */
  runAt: string | null;
  /** The proposal's own statement of what approval sends, if any. */
  sending?: unknown;
  timeZone?: string;
}): string {
  const parts: string[] = [];
  if (args.runAt) {
    parts.push(
      `Approving queues it to run no earlier than ${dayWord(args.runAt, args.timeZone)}, ${clockWord(args.runAt, args.timeZone)}. There is no un-approve; the emergency stop can still halt it.`,
    );
  } else {
    parts.push(
      "Approving records your yes with your name. With no set time, it doesn't run by itself.",
    );
  }
  const sending = str(args.sending);
  if (sending) parts.push(sending);
  return parts.join(" ");
}

/**
 * Review 2026-10-23 (Session D #1): an approval that went stale before it
 * could run is expired with the decision kept — "you approved this", never
 * "ran out of time undecided". Null for an ordinary, undecided expiry.
 */
export function lapsedSentence(p: {
  status: string;
  decided_at: string | null;
  execution_result?: unknown;
}): string | null {
  if (p.status !== "expired" || !p.decided_at) return null;
  const r = p.execution_result as { lapsed?: unknown; sentence?: unknown } | null | undefined;
  const why = r?.lapsed === true && typeof r.sentence === "string" ? ` ${r.sentence}` : "";
  return `You approved this, but it lapsed before it could run — nothing ran.${why}`;
}
