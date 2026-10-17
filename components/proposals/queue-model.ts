// Pure helpers for the approval queue (ux-spec §2 sheet system, §8 approval
// pattern). Everything the queue shows that is arithmetic or wording lives
// here, so it is testable without a browser and without the database.

import { moneyText } from "../sheet/num";

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

export interface Stamp {
  decision: "approved" | "rejected";
  /** ISO time of the decision. */
  at: string;
  /** True when `at` is this device's clock, not the recorded time. */
  clientTime: boolean;
}

/** "APPROVED 14:02 · ref 3f2a9c1b" — the recorded time unless labelled otherwise. */
export function stampText(id: string, stamp: Stamp, timeZone?: string): string {
  const verb = stamp.decision === "approved" ? "APPROVED" : "DECLINED";
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
