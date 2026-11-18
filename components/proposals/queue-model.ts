// Pure helpers for the approval queue (ux-spec §2 sheet system, §8 approval
// pattern). Everything the queue shows that is arithmetic or wording lives
// here, so it is testable without a browser and without the database.

//
// L-3a: the queue's fixed words — the reversibility labels, the stamps,
// the decline chips, the consequence on the primary button, where a
// proposal came from, the note under the decision — come from the
// "proposals" catalogue through an optional translator, English by
// default, with dates and figures in the reader's locale. The lines built
// from a proposal's own data (changeLines, adFacts, effectSpan, the
// evidence sources, durationWord) are L-4 of TASKS-LANGUAGES.md.

import { type BasisInput, basisOfKey, sourceLabel } from "../report/basis";
import { moneyText, num } from "../sheet/num";
import { CREATES_PAUSED_NOTE } from "../../lib/ads/ad-words";
import { minorUnitExponent } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { rangeOf } from "../../lib/i18n/range";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { readStored } from "../../lib/i18n/stored";

const EN = (): Tr => englishTr("proposals");

/**
 * L-4a: the lines built from a proposal's own data — the change lines, the
 * ad facts, the effect span, the evidence's "no source", the review time
 * and the proposal's own sending sentence — from the "queueWords"
 * catalogue, with figures in the reader's writing. English by default,
 * word for word what the queue always said.
 */
export interface QueueWords {
  tr: Tr;
  locale: AppLocale;
}
const QW = (): QueueWords => ({ tr: englishTr("queueWords"), locale: "en" });

/** Pure: a proposal's stored sending sentence in the reader's language; as stored otherwise. */
export function sendingWords(text: string, w: QueueWords = QW()): string {
  if (w.locale === "en") return text;
  return readStored(text, "queueWords.sending", (k, v) => w.tr(`sending.${k}`, v));
}

/** The English words an ad proposal lists in detail.creates, by their key. */
const CREATES: Record<string, string> = {
  campaign: "campaign",
  "ad set": "adSet",
  "ad video": "adVideo",
  creative: "creative",
  ad: "ad",
};
/** The Intl tag dates are written in: English keeps en-GB, as the queue always has. */
const dateTag = (locale: AppLocale): string => (locale === "en" ? "en-GB" : intlTag(locale));

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
export function signedMoney(m: MoneyLike, locale: AppLocale = "en"): string {
  const body = moneyText(Math.abs(m.amount_minor), m.currency, locale);
  if (m.amount_minor > 0) return `+${body}`;
  if (m.amount_minor < 0) return `−${body}`;
  return body;
}

/**
 * An estimate's end in whole major units, in the currency's own step: printed
 * to the cent it would claim more than it knows. Half a unit rounds away from
 * zero on both sides, and what rounds to nothing is a plain zero.
 */
export function wholeMoney(m: MoneyLike): MoneyLike {
  const unit = 10 ** minorUnitExponent(m.currency);
  const major = Math.round(Math.abs(m.amount_minor) / unit) * unit;
  return { ...m, amount_minor: major === 0 ? 0 : m.amount_minor < 0 ? -major : major };
}

/**
 * The expected effect as every screen words it (Home, the review sheet, the
 * conversation, the queue): "+€136 to +€1,213", each end in whole units, the
 * word between them the reader's language's own (lib/i18n/range.ts; no dash,
 * the owner 2026-11-18). One function, so one proposal is never worded two ways.
 */
export function rangeWords(
  range: { low: MoneyLike; high: MoneyLike },
  locale: AppLocale = "en",
): string {
  return rangeOf(
    signedMoney(wholeMoney(range.low), locale),
    signedMoney(wholeMoney(range.high), locale),
    locale,
  );
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
export function reversibilityLabel(
  rev: ReversibilityLike | null | undefined,
  /**
   * P3-54: the proposal's own detail says it creates what can't be removed
   * (detail.irreversible — an ad's campaign, ad set, creative and ad). Its
   * "hard" level is the engine's irreversibility label, so it reads IRREVERSIBLE.
   */
  detail?: unknown,
  tr: Tr = EN(),
): {
  reversible: boolean;
  word: string;
  note: string;
} {
  const level = rev?.level ?? null;
  const note = rev?.if_you_change_your_mind?.trim() ?? "";
  const declared = asDetail(detail)?.irreversible === true;
  if (level !== null && LEVELS.has(level) && !declared) {
    return {
      reversible: true,
      word: tr("rev.reversible", { level }),
      note,
    };
  }
  return {
    reversible: false,
    word: tr("rev.irreversible"),
    note: note || tr("rev.noUndo"),
  };
}

/* ── dates and the stamp ── */

/** "Monday 19 October" — the weekday is part of a deadline. */
export function dayWord(iso: string, timeZone?: string, locale: AppLocale = "en"): string {
  return new Date(iso).toLocaleDateString(dateTag(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(timeZone ? { timeZone } : {}),
  });
}

/** "14:02" in 24-hour time. */
export function clockWord(iso: string, timeZone?: string, locale: AppLocale = "en"): string {
  return new Date(iso).toLocaleTimeString(dateTag(locale), {
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

/** "APPROVED 14:02 · ref 3f2a9c1b" — the recorded time unless labelled otherwise. */
export function stampText(
  id: string,
  stamp: Stamp,
  timeZone?: string,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string {
  const clock = clockWord(stamp.at, timeZone, locale);
  const when = stamp.clientTime ? tr("stamp.deviceClock", { clock }) : clock;
  return tr(`stamp.${stamp.decision}`, { when, ref: shortRef(id) });
}

/* ── decline reasons ── */

export const REASON_CHIPS = ["WRONG DATA", "WRONG TIMING", "TOO RISKY", "NOT MY STRATEGY"] as const;
export type ReasonChip = (typeof REASON_CHIPS)[number];

/** A chip's catalogue key: "WRONG DATA" → "wrongData". */
const chipKey = (chip: ReasonChip): string =>
  chip
    .toLowerCase()
    .split(" ")
    .map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join("");

/** A chip as the button prints it, in the reader's language: "WRONG DATA". */
export const chipLabel = (chip: ReasonChip, tr: Tr = EN()): string => tr(`chip.${chipKey(chip)}`);

/** "WRONG DATA" → "Wrong data" — the words that land in the record, in the reader's language. */
export function chipPhrase(chip: ReasonChip, tr: Tr = EN()): string {
  return tr(`chipPhrase.${chipKey(chip)}`);
}

/**
 * Put a chip's phrase at the front of the reason, replacing any chip
 * phrase already there and keeping whatever the owner typed after it.
 * "" + WRONG DATA → "Wrong data"; "Wrong data: the stock is off" +
 * TOO RISKY → "Too risky: the stock is off". A reason written when the
 * two were joined by a long dash is still read.
 */
const CHIP_JOINS = [": ", " — "] as const;
export function applyReasonChip(current: string, chip: ReasonChip, tr: Tr = EN()): string {
  let rest = current.trim();
  for (const c of REASON_CHIPS) {
    const p = chipPhrase(c, tr);
    if (rest === p) {
      rest = "";
      break;
    }
    const join = CHIP_JOINS.find((j) => rest.startsWith(`${p}${j}`));
    if (join) {
      rest = rest.slice(p.length + join.length).trim();
      break;
    }
  }
  const phrase = chipPhrase(chip, tr);
  return rest === "" ? phrase : `${phrase}: ${rest}`;
}

/** Which chip, if any, currently leads the reason. */
export function activeChip(current: string, tr: Tr = EN()): ReasonChip | null {
  const t = current.trim();
  for (const c of REASON_CHIPS) {
    const p = chipPhrase(c, tr);
    if (t === p || CHIP_JOINS.some((j) => t.startsWith(`${p}${j}`))) return c;
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

function adName(d: Detail, w: QueueWords): string {
  const ad = asDetail(d.ad);
  return str(ad?.name) ?? str(d.campaign_name) ?? str(d.item_title) ?? w.tr("change.theAd");
}

/** The before → after of an ad: nothing → created paused; paused → live. Null for anything else. */
function adLines(d: Detail, w: QueueWords): ChangeLine[] | null {
  const { tr, locale } = w;
  const change = str(d.change);
  if (change !== "run_ad" && change !== "go_live") return null;
  const budget = adBudget(d);
  const spend = budget
    ? tr("change.spendUpTo", {
        daily: moneyText(budget.daily_minor, budget.currency, locale),
        days: budget.run_days,
      })
    : tr("change.spendsBudget");
  if (change === "run_ad") {
    const creates = Array.isArray(d.creates)
      ? d.creates.filter((c): c is string => typeof c === "string")
      : [];
    const parts = creates.map((c) => {
      const key = CREATES[c];
      return locale !== "en" && key ? tr(`creates.${key}`) : c;
    });
    return [
      {
        line: tr("change.adLine", { name: adName(d, w) }),
        sub:
          creates.length > 0
            ? tr("change.creates", {
                parts: parts.join(locale === "zh-Hans" ? "、" : ", "),
              })
            : null,
        before: tr("change.noAd"),
        after: tr("change.createdPaused"),
      },
    ];
  }
  return [
    {
      line: tr("change.adLine", { name: adName(d, w) }),
      sub: tr("change.goLiveSub"),
      before: tr("change.paused"),
      after: tr("change.live", { spend }),
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
export function adFacts(
  action: ActionLike,
  w: QueueWords = QW(),
): { facts: AdFact[]; note: string | null } | null {
  const { tr, locale } = w;
  const d = asDetail(action.detail);
  if (!d) return null;
  const change = str(d.change);
  if (change !== "run_ad" && change !== "go_live") return null;
  const facts: AdFact[] = [];
  const budget = adBudget(d);
  if (budget) {
    facts.push({
      label: tr("fact.budget"),
      value: tr("fact.budgetValue", {
        daily: moneyText(budget.daily_minor, budget.currency, locale),
        total: moneyText(budget.total_minor, budget.currency, locale),
      }),
    });
    facts.push({
      label: tr("fact.duration"),
      value: tr("fact.durationValue", { days: budget.run_days }),
    });
  }
  // The audience, interests, placements, goal and notes are the proposal's
  // own words for Meta (content, rule 4): they print as written.
  const audience = asDetail(d.audience);
  if (audience) {
    const where = str(audience.location);
    const age = str(audience.age);
    if (where || age)
      facts.push({
        label: tr("fact.audience"),
        value: [where, age && tr("fact.aged", { age })].filter(Boolean).join(" · "),
      });
    const interests = str(audience.interests);
    if (interests) facts.push({ label: tr("fact.interests"), value: interests });
    const placements = str(audience.placements);
    if (placements) facts.push({ label: tr("fact.placements"), value: placements });
  }
  const goal = str(d.goal);
  if (goal) facts.push({ label: tr("fact.goal"), value: goal });
  const special = Array.isArray(d.special_ad_categories)
    ? d.special_ad_categories.filter((c): c is string => typeof c === "string")
    : [];
  if (special.length > 0) {
    facts.push({
      label: tr("fact.special"),
      value: tr("fact.specialValue", { categories: special.join(", ") }),
    });
  }
  const notes = Array.isArray(d.notes)
    ? d.notes.filter((n): n is string => typeof n === "string")
    : [];
  for (const n of notes) facts.push({ label: tr("fact.note"), value: n });
  const pausedNote = str(d.paused_note);
  return {
    facts,
    note:
      change === "run_ad"
        ? pausedNote === null || pausedNote === CREATES_PAUSED_NOTE
          ? tr("fact.createsPaused")
          : pausedNote
        : tr("fact.goLiveNote"),
  };
}

/** The effect's span: "a month", or an ad's own run ("over 7 days"). */
export function effectSpan(action: ActionLike, w: QueueWords = QW()): string {
  const d = asDetail(action.detail);
  const budget = d ? adBudget(d) : null;
  return budget ? w.tr("span.over", { days: budget.run_days }) : w.tr("span.month");
}

/** "fernhill-ceramics.example/products/mug" — a page as the owner would name it. */
function pageOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * The "what changes — before → after" lines, read from what the
 * proposal's own detail states. Null when it states no before and after:
 * the sheet then prints the summary alone rather than invent a "before".
 *
 *   - any detail with `before` / `after` (changeOf)
 *   - a site wording change (detail.find / replace): the page's text, in full
 *   - an ad change (detail.change "pause" | "raise_budget" with the
 *     measured spend): the campaign's average daily spend over the
 *     measured days, before and after
 *   - a customer email (detail.contact_ids): who receives it, and what
 *   - a publish (detail.platform + publish_at): not posted → posted then
 */
export function changeLines(
  action: ActionLike,
  timeZone?: string,
  w: QueueWords = QW(),
): ChangeLine[] | null {
  const { tr, locale } = w;
  const d = asDetail(action.detail);
  if (!d) return null;

  // The stated before and after are the proposal's own words (content): as written.
  const stated = changeOf(d);
  if (stated) return [{ line: tr("change.stated"), sub: null, ...stated }];

  // A site wording change: the page's text as it is, and as it would be,
  // in full — the title only has room for a clipped version.
  const find = str(d.find);
  const replace = str(d.replace);
  if (find && replace)
    return [{ line: tr("change.stated"), sub: pageOf(d.url), before: find, after: replace }];

  const ad = adLines(d, w);
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
    const over = tr("change.averageOver", { days });
    const perDay = tr("change.perDay", { amount: moneyText(daily, currency, locale) });
    if (change === "pause") {
      return [
        {
          line: tr("change.campaignLine", { name }),
          sub: over,
          before: perDay,
          after: tr("change.pausedNothing"),
        },
      ];
    }
    const share = typeof d.share === "number" && Number.isFinite(d.share) ? d.share : null;
    if (share !== null) {
      return [
        {
          line: tr("change.campaignLine", { name }),
          sub: over,
          before: perDay,
          after: tr("change.raisedTo", {
            amount: moneyText(Math.round(daily * (1 + share)), currency, locale),
            pct: num(share * 100, 0, locale),
          }),
        },
      ];
    }
  }

  if (Array.isArray(d.contact_ids)) {
    const n = d.contact_ids.length;
    const lines: ChangeLine[] = [
      {
        line: tr("change.audience"),
        sub: str(d.label),
        before: tr("change.nobody"),
        after: tr("change.people", { count: n, n: num(n, 0, locale) }),
      },
    ];
    const what = str(d.what);
    if (what) lines.push({ line: tr("change.email"), sub: null, before: "-", after: what });
    return lines;
  }

  const platform = str(d.platform);
  const at = str(d.publish_at);
  if (platform && at && !Number.isNaN(Date.parse(at))) {
    return [
      {
        line: tr("change.postOn", { platform }),
        sub: str(d.target),
        before: tr("change.notPosted"),
        after: tr("change.posted", {
          day: dayWord(at, timeZone, locale),
          clock: clockWord(at, timeZone, locale),
        }),
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
export function consequence(action: ActionLike, tr: Tr = EN(), locale: AppLocale = "en"): string {
  const d = asDetail(action.detail);
  if (!d) return tr("act.approve");
  const change = str(d.change);
  // P3-54: what approving an ad asks for — creating it paused, or putting it live.
  if (change === "run_ad") return tr("act.createAd");
  if (change === "go_live") return tr("act.goLive");
  const name = str(d.campaign_name);
  if (change === "pause" && name) return tr("act.pause", { name });
  if (change === "raise_budget" && name && typeof d.share === "number") {
    return tr("act.raise", { name, pct: num(d.share * 100, 0, locale) });
  }
  if (Array.isArray(d.contact_ids) && d.contact_ids.length > 0) {
    return tr("act.send", { count: d.contact_ids.length });
  }
  const platform = str(d.platform);
  if (platform && str(d.publish_at)) return tr("act.publish", { platform });
  return tr("act.approve");
}

const ORIGINS = new Set(["anomaly", "ads", "publish", "alert_review", "utterance", "crm", "hours"]);

/** Where a proposal came from, in words, from its originating_finding ref. */
export function originWord(ref: string | null | undefined, tr: Tr = EN()): string | null {
  if (!ref) return null;
  const rec = /^report:[^:]+:rec:(\d+)$/.exec(ref);
  if (rec) return tr("origin.report", { n: Number(rec[1]) + 1 });
  const prefix = ref.split(":")[0] ?? "";
  return ORIGINS.has(prefix) ? tr(`origin.${prefix}`) : ref;
}

/** The list's short reversibility: "easy to undo" … "irreversible". */
export function shortReversibility(
  rev: ReversibilityLike | null | undefined,
  tr: Tr = EN(),
): string {
  const level = rev?.level ?? null;
  return level !== null && LEVELS.has(level)
    ? tr("rev.short", { level })
    : tr("rev.shortIrreversible");
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
  w: QueueWords = QW(),
  /** The "sheet" catalogue, for the source words (L-3a); English by default. */
  st?: Tr,
): EvidenceLine[] {
  return assumptions.map((a) => {
    const key = str(a.source_field);
    const leansHard = a.sensitivity === "high";
    if (!key) {
      const measured = str(a.measured);
      if (measured)
        return { statement: a.statement, source: measured, basis: "DERIVED", leansHard };
      return {
        statement: a.statement,
        source: w.tr("evidence.noSource"),
        basis: "ASSUMED",
        leansHard,
      };
    }
    const fact = facts[key];
    const basis = basisOfKey(key, facts);
    const source = fact ? `${sourceLabel(fact.source_kind, st)} · ${key}` : key;
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
export function durationWord(ms: number, w: QueueWords = QW()): string {
  const { tr } = w;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return tr("duration.s", { s: String(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return tr("duration.ms", { m: String(m), ss: String(s % 60).padStart(2, "0") });
  const h = Math.floor(m / 60);
  if (h < 24) return tr("duration.hm", { h: String(h), mm: String(m % 60).padStart(2, "0") });
  return tr("duration.dh", { d: String(Math.floor(h / 24)), h: String(h % 24) });
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
  tr?: Tr;
  locale?: AppLocale;
  /** L-4a: the "queueWords" translator, for the sending sentence. */
  qw?: QueueWords;
}): string {
  const tr = args.tr ?? EN();
  const locale = args.locale ?? "en";
  const parts: string[] = [];
  if (args.runAt) {
    parts.push(
      tr("note.queued", {
        day: dayWord(args.runAt, args.timeZone, locale),
        clock: clockWord(args.runAt, args.timeZone, locale),
      }),
    );
  } else {
    parts.push(tr("note.noTime"));
  }
  // The proposal's own statement of what approval sends: its writer's words,
  // stored as written and read back in the reader's language (L-4a).
  const sending = str(args.sending);
  if (sending) parts.push(args.qw ? sendingWords(sending, args.qw) : sending);
  return parts.join(" ");
}

/**
 * Review 2026-10-23 (Session D #1): an approval that went stale before it
 * could run is expired with the decision kept — "you approved this", never
 * "ran out of time undecided". Null for an ordinary, undecided expiry.
 */
export function lapsedSentence(
  p: {
    status: string;
    decided_at: string | null;
    execution_result?: unknown;
  },
  tr: Tr = EN(),
): string | null {
  if (p.status !== "expired" || !p.decided_at) return null;
  const r = p.execution_result as { lapsed?: unknown; sentence?: unknown } | null | undefined;
  // The engine's own sentence is stored as it was written (rule 4); it follows ours.
  const why = r?.lapsed === true && typeof r.sentence === "string" ? ` ${r.sentence}` : "";
  return `${tr("lapsed")}${why}`;
}
