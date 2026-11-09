// The campaign simulator — feature 36. Before anything is spent or sent,
// the owner sees the likely range of each campaign option from the
// business's OWN numbers, side by side.
//
// Pure arithmetic, no model (CLAUDE.md cost rule: "never call an LLM for
// something deterministic code can do"). Every figure is a chain of the
// owner's measured or stated rates:
//
//   email    recipients after the consent gate → delivered → bought again
//            × what each of them spends, from the segment's own purchase
//            history and the readbacks of past campaigns (P4-14/15/17)
//   ads      spend → the campaign's measured return on ad spend, read per
//            rolling week over its recent series (P3-22a / P3-23b)
//   content  posts × reach per post → interactions → visits from social →
//            the site's conversion → orders × order value (P3-15..23)
//
// Each input carries its basis (OBSERVED / DERIVED / ESTIMATED / STATED /
// ASSUMED, components/report/basis.ts). An input the business doesn't
// have is MISSING, with what would fill it — never an industry number.
// The one kind of ASSUMED line here is the projection itself ("this send
// performs like your past ones"), labelled as mine, with its source.
//
// Ranges, never points (ux-spec §2, the number grammar): low and high are
// the measured spread — the interquartile range of past campaigns, days,
// weeks or posts — or the owner's own stated figures when nothing is
// measured. Money is integer minor units with its currency (rule 1),
// rounded once where a rate meets money, and formatted by
// components/sheet/num.ts. Nothing here reads the database: lib/simulate/
// inputs.ts gathers the raw figures, and this file runs on either side.

import type { Basis } from "../../components/report/basis";
import { BASES } from "../../components/report/basis";
import { moneyText, num } from "../../components/sheet/num";
import { MAX_CHANGE_SHARE, spendGuard } from "../ads/guard";
import { minorUnitExponent } from "../core/money";
import type { AppLocale } from "../i18n/locales";
import { intlTag } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import type { SimText } from "./words";
import { andList, englishSimText, int, isoDay, pointsPct, section, wholePct } from "./words";

/**
 * The pinned thresholds and windows — one place, boundary-tested
 * (model.test.ts). Several repeat a figure pinned elsewhere; the test
 * proves they still agree with the original, so they can't drift apart.
 */
export const SIM = {
  /** Every option is simulated over four weeks — what the queue calls "a month". */
  horizon_days: 28,
  /** The side by side compares this many options… */
  min_options: 2,
  /** …and no more than this. */
  max_options: 4,
  /** The measured spread: from the 25th to the 75th percentile. */
  quartile_low: 0.25,
  quartile_high: 0.75,

  /** Ads: the campaign's recent series. */
  ads_window_days: 28,
  /** Return on ad spend is read per rolling 7-day block: a single day is too lumpy. */
  ads_block_days: 7,
  /** No ad option without this many measured days (= ADS.min_measured_days, P3-22a). */
  ads_min_measured_days: 14,
  /** A raise or cut is bounded here (= MAX_CHANGE_SHARE, P3-22c)… */
  ads_max_change_share: MAX_CHANGE_SHARE,
  /** …and moves at least this much. */
  ads_min_change_share: 0.05,

  /** Email: a past campaign counts once this many recipients were measured (= EMAIL_READBACK.min_measured). */
  email_min_measured: 5,
  /** The wait before a campaign is read back, by kind (= EMAIL_READBACK.min_days_after). */
  email_wait_days: { winback: 14, vip: 28 },
  /** A segment's own order values are used once this many recipients carry one. */
  email_min_order_values: 5,

  /** Content: the previous posts the per-post spread is read from (= POST_READBACK.baseline_posts). */
  content_baseline_posts: 10,
  /** Fewer measured posts than this: the per-post figures are missing (= POST_READBACK.min_baseline_posts). */
  content_min_posts: 3,
  /** Every post is taken at this age (= POST_READBACK.judge_age_days). */
  content_age_days: 7,
  /** Google Analytics' default channel group for visits from unpaid social. */
  social_channel_ref: "Organic Social",

  /** The site's conversion and order value: the last 28 days… */
  site_window_days: 28,
  /** …with at least this many measured days. */
  site_min_days: 14,

  /** The cross-check reads the last this-many past proposals of the same kind. */
  cross_check_last: 3,
} as const;

/** The content option plans this many weeks: the horizon, in whole weeks. */
export const CONTENT_WEEKS = SIM.horizon_days / 7;

export class SimulateError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "SimulateError";
    this.status = status;
  }
}

/* ── the options ── */

export type EmailSegmentKey = "lapsed" | "vip";
export type AdChangeKind = "raise" | "lower" | "pause" | "new";

/** Which ad platform a campaign runs on (lib/ads/proposals AdPlatform). */
export type SimAdPlatform = "meta" | "google" | "tiktok";

const SIM_AD_PLATFORMS: readonly SimAdPlatform[] = ["meta", "google", "tiktok"];

/** A platform's name in a sentence — a brand, the same in every language. */
export const SIM_AD_PLATFORM_NAME: Readonly<Record<SimAdPlatform, string>> = {
  meta: "Meta",
  google: "Google Ads",
  tiktok: "TikTok Ads",
};

/**
 * An option on an existing campaign names its platform when it isn't Meta
 * (the same campaign id can exist on two platforms); absent = the first
 * measured campaign with that ref, Meta first.
 */
export type SimOption =
  | { kind: "email"; segment: EmailSegmentKey }
  | {
      kind: "ads";
      change: "raise" | "lower";
      campaign_ref: string;
      share: number;
      platform?: SimAdPlatform;
    }
  | { kind: "ads"; change: "pause"; campaign_ref: string; platform?: SimAdPlatform }
  | { kind: "ads"; change: "new"; daily_budget_minor: number | null; currency: string }
  | { kind: "content" };

export type SimKind = SimOption["kind"];

/** A stable id for an option: the same option always has the same key. */
export function optionKey(o: SimOption): string {
  switch (o.kind) {
    case "email":
      return `email:${o.segment}`;
    case "content":
      return "content";
    case "ads":
      if (o.change === "new") return `ads:new:${o.daily_budget_minor ?? "none"}:${o.currency}`;
      if (o.change === "pause") return `ads:${platformPart(o.platform)}${o.campaign_ref}:pause`;
      return `ads:${platformPart(o.platform)}${o.campaign_ref}:${o.change}:${Math.round(o.share * 100)}`;
  }
}

/** Meta's keys are as they always were; another platform's carry its name. */
const platformPart = (p: SimAdPlatform | undefined) =>
  p === undefined || p === "meta" ? "" : `${p}:`;

/** Pure: the measured campaign an option means — its platform's, or the first with that ref, Meta first. */
export function findCampaign(
  campaigns: readonly CampaignRaw[],
  ref: string,
  platform?: SimAdPlatform,
): CampaignRaw | null {
  const mine = campaigns.filter((c) => c.ref === ref);
  if (platform !== undefined) return mine.find((c) => (c.platform ?? "meta") === platform) ?? null;
  return mine.find((c) => (c.platform ?? "meta") === "meta") ?? mine[0] ?? null;
}

/** Pure: an option from untrusted JSON, or null. Shares are held to the pinned bounds. */
export function parseOption(raw: unknown): SimOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === "email") {
    return o.segment === "lapsed" || o.segment === "vip"
      ? { kind: "email", segment: o.segment }
      : null;
  }
  if (o.kind === "content") return { kind: "content" };
  if (o.kind !== "ads") return null;
  if (o.change === "new") {
    const budget = o.daily_budget_minor;
    if (typeof o.currency !== "string" || !/^[A-Z]{3}$/.test(o.currency)) return null;
    if (budget !== null && !(Number.isSafeInteger(budget) && (budget as number) > 0)) return null;
    return {
      kind: "ads",
      change: "new",
      daily_budget_minor: budget as number | null,
      currency: o.currency,
    };
  }
  if (typeof o.campaign_ref !== "string" || o.campaign_ref === "") return null;
  if (o.platform !== undefined && !SIM_AD_PLATFORMS.includes(o.platform as SimAdPlatform)) {
    return null;
  }
  const on =
    o.platform === undefined || o.platform === "meta"
      ? {}
      : { platform: o.platform as SimAdPlatform };
  if (o.change === "pause") {
    return { kind: "ads", change: "pause", campaign_ref: o.campaign_ref, ...on };
  }
  if (o.change !== "raise" && o.change !== "lower") return null;
  const share = o.share;
  if (typeof share !== "number" || !isShare(share)) return null;
  return { kind: "ads", change: o.change, campaign_ref: o.campaign_ref, share, ...on };
}

/** Pure: a budget change share inside the pinned bounds (inclusive both ends). */
export function isShare(share: number): boolean {
  return (
    Number.isFinite(share) &&
    share >= SIM.ads_min_change_share - 1e-9 &&
    share <= SIM.ads_max_change_share + 1e-9
  );
}

/* ── the raw inputs, as lib/simulate/inputs.ts reads them ── */

export interface MoneyRaw {
  amount_minor: number;
  currency: string;
}

export interface MarginRaw {
  /** The economics engine's blended margin, percentage points. */
  computed_pct: number | null;
  computed_formula: string | null;
  /** The owner's own answer (costs.gross_margin), percentage points. */
  stated_pct: number | null;
  stated_basis: Basis | null;
}

export interface AovRaw {
  /** Per measured day in the site window: revenue ÷ orders, minor units, reporting currency. */
  measured_daily_minor: number[];
  /** Monthly revenue ÷ monthly orders, from what the owner told me. */
  stated_minor: number | null;
  stated_basis: Basis | null;
}

export interface PastEmailCampaign {
  kind: "winback" | "vip";
  sent_on: string | null;
  sent: number;
  delivered: number;
  bounced: number;
  /** Unsubscribed or complained. */
  harmed: number;
  /** Recipients a later customer export measured. */
  measured: number;
  /** Of the measured: bought again after the email. */
  returned: number;
}

export interface EmailSegmentRaw {
  key: EmailSegmentKey;
  label: string;
  members: number;
  /** The consent gate's count (rule 19): who may be emailed. */
  emailable: number;
  /** Each emailable member's own average order (total spent ÷ orders), reporting currency. */
  order_values_minor: number[];
}

export interface CampaignRaw {
  /** Whose campaign, and whose attribution its value is; Meta when absent. */
  platform?: SimAdPlatform;
  ref: string;
  name: string;
  currency: string;
  /** Measured days (spend above zero) in the ads window. */
  days: { date: string; spend_minor: number; value_minor: number }[];
}

export interface PostRaw {
  /** Reach (Instagram) or views (Facebook) at the comparison age. */
  reach: number | null;
  interactions: number | null;
}

export interface SiteRaw {
  /** Measured days in the site window. */
  days: { sessions: number; orders: number }[];
  stated_sessions_monthly: number | null;
  stated_orders_monthly: number | null;
  stated_basis: Basis | null;
}

export interface CrossCheck {
  /** One sentence, first person, true whatever it says. */
  line: string;
  /** Past proposals compared with their predicted range. */
  checked: number;
  /** Of those, landed inside it. */
  inside: number;
}

export interface SimInputs {
  /** YYYY-MM-DD: windows end the day before. */
  as_of: string;
  /** The account's reporting currency. */
  currency: string;
  margin: MarginRaw;
  aov: AovRaw;
  email: {
    posture: "enabled" | "caution" | "disabled" | "unknown";
    contacts: number;
    segments: EmailSegmentRaw[];
    /** Newest first. */
    past: PastEmailCampaign[];
  };
  ads: { connected: boolean; campaigns: CampaignRaw[]; ceiling: MoneyRaw | null };
  content: {
    platform: "instagram" | "facebook" | null;
    publish_connected: boolean;
    /** The previous posts on that platform, newest first, at the comparison age. */
    posts: PostRaw[];
    /** Social channels the calendar plans onto. */
    social_channels: number;
    /** The calendar's posts per social channel per week (lib/content/plan.ts CADENCE). */
    per_week: number;
    analytics_connected: boolean;
    /** Visits from unpaid social over the site window. */
    social_sessions: number | null;
    /** Interactions on the posts published in the same window. */
    window_interactions: number | null;
  };
  site: SiteRaw;
  cross_check: Record<SimKind, CrossCheck>;
}

/* ── the results ── */

export interface Range {
  low: number;
  high: number;
}

export type Unit = "money" | "count" | "rate" | "ratio";

/** One link of a chain: a value with where it came from, or a gap with what fills it. */
export interface SimInput {
  key: string;
  label: string;
  /** The label as it reads inside a sentence ("your margin: …"), in the same words as `label`. */
  label_inline: string;
  /** Null: missing. */
  range: Range | null;
  unit: Unit;
  basis: Basis | null;
  /** Where it came from, in words. */
  source: string;
  /** What would fill it, when missing. */
  needs: string | null;
}

export const MEASURES = ["cost", "reached", "orders", "revenue", "profit", "worst"] as const;
export type MeasureKey = (typeof MEASURES)[number];

export const MEASURE_LABEL: Record<MeasureKey, string> = {
  cost: "What it costs",
  reached: "People it reaches",
  orders: "Orders",
  revenue: "Expected revenue",
  profit: "Expected profit",
  worst: "Worst case",
};

export const MEASURE_UNIT: Record<MeasureKey, "money" | "count"> = {
  cost: "money",
  reached: "count",
  orders: "count",
  revenue: "money",
  profit: "money",
  worst: "money",
};

export type Cell =
  | {
      status: "range";
      range: Range;
      /** The bases of the inputs it rests on, in the fixed class order. */
      bases: Basis[];
      /** The arithmetic, with the real numbers in it. */
      formula: string;
      /** A figure the option sets rather than forecasts (a budget, no spend). */
      exact: boolean;
    }
  | { status: "missing"; needs: string[] }
  | { status: "none"; why: string };

export interface OptionResult {
  key: string;
  option: SimOption;
  kind: SimKind;
  title: string;
  what: string;
  currency: string;
  inputs: SimInput[];
  /** The projection's own assumption, labelled ASSUMED with its source. */
  assumptions: { statement: string; source: string }[];
  measures: Record<MeasureKey, Cell>;
  worst_words: string;
  /** The rate the cross-check compares with what happened. */
  key_rate: { name: KeyRateName; label: string; range: Range } | null;
  cross_check: CrossCheck;
  /** An ad guard's refusal, naming the number it hit (P3-22c). */
  guard: string | null;
  proposable: { ok: true } | { ok: false; why: string };
}

export type KeyRateName = "bought_again_rate" | "roas" | "reach_per_post";

/* ── range arithmetic ── */

/** Pure: an ordered range from two ends in any order. */
export function range(a: number, b: number): Range {
  return a <= b ? { low: a, high: b } : { low: b, high: a };
}

const point = (v: number): Range => ({ low: v, high: v });

/** Pure: interval product — every sign handled, the result ordered. */
export function mul(a: Range, b: Range): Range {
  const p = [a.low * b.low, a.low * b.high, a.high * b.low, a.high * b.high];
  return { low: Math.min(...p), high: Math.max(...p) };
}

/** Pure: a range shifted by a fixed amount. */
function minus(a: Range, k: number): Range {
  return { low: a.low - k, high: a.high - k };
}

/** Money ends rounded once, to integer minor units (rule 1). */
export function roundRange(a: Range): Range {
  return range(Math.round(a.low), Math.round(a.high));
}

/** Pure: the value at a percentile, linearly interpolated between ranks. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new SimulateError("no values to take a percentile of", 500);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Pure: the measured spread — 25th to 75th percentile — or null with no values. */
export function spread(values: readonly number[]): Range | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  return {
    low: percentile(sorted, SIM.quartile_low),
    high: percentile(sorted, SIM.quartile_high),
  };
}

/* ── formatting, by the number grammar ── */

/**
 * Money in whole major units, every figure alike — one column, one decimal
 * count (ux-spec §2). The amounts stay integer minor units underneath; only
 * the print rounds.
 */
// L-3b: the screen's figures take the reader's language (English by
// default, exactly as before); L-4b: so do the arithmetic lines built here.
const money = (minor: number, currency: string, locale: AppLocale = "en"): string => {
  const whole = Math.round(Math.abs(minor) / 10 ** minorUnitExponent(currency));
  const body = moneyText(whole * 10 ** minorUnitExponent(currency), currency, locale);
  return minor < 0 && whole !== 0 ? `−${body}` : body;
};
/**
 * Money as it is, cents and all, for an input inside an arithmetic line:
 * a line whose inputs are rounded doesn't multiply out to its result
 * ("€19 a day × +20% × 28 days" for a measured €18.50 is €106, not €104).
 */
const exactMoney = (minor: number, currency: string, locale: AppLocale = "en"): string =>
  minor < 0 ? `−${moneyText(-minor, currency, locale)}` : moneyText(minor, currency, locale);
/** A term after a minus sign: a negative one in brackets, never "− −€104". */
const subtrahend = (minor: number, currency: string, locale: AppLocale = "en"): string =>
  minor < 0 ? `(${exactMoney(minor, currency, locale)})` : exactMoney(minor, currency, locale);
const pct = (x: number, locale: AppLocale = "en"): string =>
  locale === "en"
    ? `${num(x * 100, 1)}%`
    : new Intl.NumberFormat(intlTag(locale), {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }).format(x);
const twoDp = (x: number, locale: AppLocale = "en"): string => num(x, 2, locale);
const count = (x: number, locale: AppLocale = "en"): string =>
  Number.isInteger(x) ? num(x, 0, locale) : num(x, 1, locale);

/** "a – b" for a cell; a single figure in an arithmetic line when both ends agree. */
function rangeText(
  r: Range,
  unit: Unit,
  currency: string,
  collapse = false,
  locale: AppLocale = "en",
): string {
  const f =
    unit === "money"
      ? (v: number) => money(v, currency, locale)
      : unit === "rate"
        ? (v: number) => pct(v, locale)
        : unit === "ratio"
          ? (v: number) => twoDp(v, locale)
          : (v: number) => count(v, locale);
  return collapse && f(r.low) === f(r.high) ? f(r.low) : `${f(r.low)} – ${f(r.high)}`;
}

/** An input or intermediate figure inside an arithmetic line. */
const term = (r: Range, unit: Unit, currency: string, locale: AppLocale = "en") =>
  rangeText(r, unit, currency, true, locale);

/** Pure: a value the screen prints, by its unit, in the reader's language. */
export function valueText(
  r: Range,
  unit: Unit,
  currency: string,
  exact = false,
  locale: AppLocale = "en",
): string {
  if (exact && r.low === r.high) {
    return unit === "money"
      ? money(r.low, currency, locale)
      : rangeText(r, unit, currency, false, locale).split(" – ")[0]!;
  }
  return rangeText(r, unit, currency, false, locale);
}

/** Pure: the bases, deduped, in the fixed class order. */
export function orderBases(bases: readonly (Basis | null)[]): Basis[] {
  return BASES.filter((b) => bases.includes(b));
}

/* ── the words ── */

// L-4b (TASKS-LANGUAGES.md): every sentence below — labels, sources,
// needs, formulas, titles, the worst case, the guard, the notes — is a
// message in "simulateWords.model", with every figure formatted in the
// reader's locale and passed in. English (the default) is exactly what
// this file printed before. A proposal's stored scenario is built with the
// English default (lib/simulate/propose.ts), never with a reader's words.

/** The words one option is built with: the "model" section and the locale. */
interface W {
  t: Tr;
  L: AppLocale;
}

const wordsOf = (w: SimText): W => ({ t: section(w, "model"), L: w.locale });

/** An input's label, and the same label as it reads inside a sentence. */
function labelled(t: Tr, key: string, values?: Record<string, string | number>) {
  return {
    label: t(`label.${key}`, values),
    label_inline: t(`inline.${key}`, values),
  };
}

/* ── the shared inputs: margin and order value ── */

/** Pure: the margin as a fraction, a range when the computed and stated figures differ. */
export function marginInput(m: MarginRaw, w: SimText = englishSimText()): SimInput {
  const { t, L } = wordsOf(w);
  const base = { key: "margin", ...labelled(t, "margin"), unit: "rate" as const };
  const c = m.computed_pct;
  const s = m.stated_pct;
  if (c !== null && s !== null) {
    return {
      ...base,
      range: range(c / 100, s / 100),
      basis: "DERIVED",
      source: t("margin.both", { computed: pointsPct(c, L), stated: pointsPct(s, L) }),
      needs: null,
    };
  }
  if (c !== null) {
    return {
      ...base,
      range: point(c / 100),
      basis: "DERIVED",
      source: t("margin.computed", {
        formula: m.computed_formula ?? t("margin.formulaDefault"),
      }),
      needs: null,
    };
  }
  if (s !== null) {
    return {
      ...base,
      range: point(s / 100),
      basis: m.stated_basis ?? "STATED",
      source: t("margin.stated"),
      needs: null,
    };
  }
  return { ...base, range: null, basis: null, source: t("notKnown"), needs: t("margin.needs") };
}

/** Pure: what an order is worth — measured days first, then the owner's own monthly figures. */
export function orderValueInput(
  aov: AovRaw,
  label: "aov" | "aovEach" = "aov",
  w: SimText = englishSimText(),
): SimInput {
  const { t, L } = wordsOf(w);
  const base = { key: "aov", ...labelled(t, label), unit: "money" as const };
  if (aov.measured_daily_minor.length >= SIM.site_min_days) {
    return {
      ...base,
      range: spread(aov.measured_daily_minor),
      basis: "OBSERVED",
      source: t("aov.measured", {
        count: aov.measured_daily_minor.length,
        window: int(SIM.site_window_days, L),
      }),
      needs: null,
    };
  }
  if (aov.stated_minor !== null) {
    return {
      ...base,
      range: point(aov.stated_minor),
      basis: "DERIVED",
      source: t("aov.stated"),
      needs: null,
    };
  }
  return {
    ...base,
    range: null,
    basis: null,
    source: t("notKnown"),
    needs: t("aov.needs"),
  };
}

/* ── the chain evaluator ── */

type Got = { ok: true; vals: Range[]; bases: Basis[] } | { ok: false; needs: string[] };

function need(inputs: readonly SimInput[], keys: readonly string[], { t }: W): Got {
  const found = keys.map((k) => inputs.find((i) => i.key === k));
  const missing = found.filter((i) => !i || i.range === null);
  if (missing.length > 0) {
    return {
      ok: false,
      needs: [
        ...new Set(
          missing.map((i) =>
            i ? t("needLine", { label: i.label_inline, needs: i.needs ?? t("notKnown") }) : "?",
          ),
        ),
      ],
    };
  }
  return {
    ok: true,
    vals: found.map((i) => i!.range!),
    bases: orderBases(found.map((i) => i!.basis)),
  };
}

const missingCell = (g: Extract<Got, { ok: false }>): Cell => ({
  status: "missing",
  needs: g.needs,
});

function cell(r: Range, bases: Basis[], formula: string, exact = false): Cell {
  return { status: "range", range: r, bases, formula, exact };
}

/* ── the email model ── */

const CAMPAIGN_KIND: Record<EmailSegmentKey, PastEmailCampaign["kind"]> = {
  lapsed: "winback",
  vip: "vip",
};

/** An email option's title, by its segment. */
const segmentTitle = (segment: EmailSegmentKey, { t }: W) => t("email.title", { segment });

/**
 * Pure: the bought-again rate a send is likely to see — the spread of the
 * past campaigns of the same kind, or with exactly one, its own result one
 * person either way (the smallest honest spread a single count has).
 */
export function boughtAgainRate(past: readonly PastEmailCampaign[]): Range | null {
  const measured = past.filter((c) => c.measured >= SIM.email_min_measured);
  if (measured.length === 0) return null;
  if (measured.length === 1) {
    const c = measured[0]!;
    return range(
      Math.max(0, c.returned - 1) / c.measured,
      Math.min(c.measured, c.returned + 1) / c.measured,
    );
  }
  return spread(measured.map((c) => c.returned / c.measured));
}

function simulateEmail(
  o: Extract<SimOption, { kind: "email" }>,
  x: SimInputs,
  w: SimText,
): OptionResult {
  const words = wordsOf(w);
  const { t, L } = words;
  const cur = x.currency;
  const seg = x.email.segments.find((s) => s.key === o.segment) ?? null;
  const campaignKind = CAMPAIGN_KIND[o.segment];
  const sameKind = x.email.past.filter((c) => c.kind === campaignKind);
  const reported = x.email.past.filter((c) => c.sent > 0 && c.delivered + c.bounced > 0);
  const recipients = seg?.emailable ?? 0;

  const inputs: SimInput[] = [];
  inputs.push({
    key: "recipients",
    ...labelled(t, "recipients"),
    range: seg ? point(recipients) : null,
    unit: "count",
    basis: seg ? "OBSERVED" : null,
    source: seg
      ? t("email.recipientsSource", {
          count: seg.members,
          emailable: num(recipients, 0, L),
        })
      : t("email.noList"),
    needs: seg ? null : t("email.listNeeds"),
  });
  const delivery = spread(reported.map((c) => c.delivered / c.sent));
  inputs.push({
    key: "delivery",
    ...labelled(t, "delivery"),
    range: delivery,
    unit: "rate",
    basis: delivery ? "OBSERVED" : null,
    source: delivery
      ? t("email.deliverySource", { count: reported.length })
      : t("email.noDelivery"),
    needs: delivery ? null : t("email.deliveryNeeds"),
  });
  const rate = boughtAgainRate(sameKind);
  const measuredKind = sameKind.filter((c) => c.measured >= SIM.email_min_measured);
  const one = measuredKind[0];
  inputs.push({
    key: "bought_again",
    ...labelled(t, "boughtAgain"),
    range: rate,
    unit: "rate",
    basis: rate ? "OBSERVED" : null,
    source:
      measuredKind.length === 1 && one
        ? t("email.boughtAgainOne", {
            kind: campaignKind,
            day: one.sent_on === null ? t("email.before") : isoDay(one.sent_on, L),
            returned: int(one.returned, L),
            measured: int(one.measured, L),
          })
        : measuredKind.length > 1
          ? t("email.boughtAgainMany", { kind: campaignKind, count: measuredKind.length })
          : t("email.boughtAgainNone", { kind: campaignKind }),
    needs: rate
      ? null
      : t("email.boughtAgainNeeds", {
          kind: campaignKind,
          count: SIM.email_wait_days[campaignKind],
        }),
  });
  const values = seg?.order_values_minor ?? [];
  inputs.push(
    values.length >= SIM.email_min_order_values
      ? {
          key: "aov",
          ...labelled(t, "aovEach"),
          range: spread(values),
          unit: "money",
          basis: "OBSERVED",
          source: t("email.spendsSource", { count: values.length }),
          needs: null,
        }
      : orderValueInput(x.aov, "aovEach", w),
  );
  inputs.push(marginInput(x.margin, w));

  const worstHarm = reported.length
    ? Math.max(...x.email.past.filter((c) => c.sent > 0).map((c) => c.harmed / c.sent))
    : null;

  const nobody = t("email.worstFormula");
  const measures = emptyMeasures(words);
  measures.cost = cell(point(0), [], t("email.costFormula"), true);
  const reached = need(inputs, ["recipients", "delivery"], words);
  measures.reached = reached.ok
    ? cell(
        roundRange(mul(reached.vals[0]!, reached.vals[1]!)),
        reached.bases,
        t("email.reachedFormula", {
          recipients: count(recipients, L),
          rate: term(reached.vals[1]!, "rate", cur, L),
        }),
      )
    : missingCell(reached);
  const orders = need(inputs, ["recipients", "bought_again"], words);
  let orderRange: Range | null = null;
  if (orders.ok) {
    orderRange = roundRange(mul(orders.vals[0]!, orders.vals[1]!));
    measures.orders = cell(
      orderRange,
      orders.bases,
      t("email.ordersFormula", {
        recipients: count(recipients, L),
        rate: term(orders.vals[1]!, "rate", cur, L),
      }),
    );
  } else measures.orders = missingCell(orders);
  const rev = need(inputs, ["recipients", "bought_again", "aov"], words);
  let revenue: Range | null = null;
  if (rev.ok && orderRange) {
    revenue = roundRange(mul(orderRange, rev.vals[2]!));
    measures.revenue = cell(
      revenue,
      rev.bases,
      t("revenueFormula", {
        orders: term(orderRange, "count", cur, L),
        value: term(rev.vals[2]!, "money", cur, L),
      }),
    );
  } else if (!rev.ok) measures.revenue = missingCell(rev);
  const prof = need(inputs, ["recipients", "bought_again", "aov", "margin"], words);
  if (prof.ok && revenue) {
    const p = roundRange(mul(revenue, prof.vals[3]!));
    measures.profit = cell(
      p,
      prof.bases,
      t("profitFormula", {
        revenue: term(revenue, "money", cur, L),
        margin: term(prof.vals[3]!, "rate", cur, L),
        spend: money(0, cur, L),
      }),
    );
    measures.worst = cell(point(0), [], nobody);
  } else if (!prof.ok) {
    measures.profit = missingCell(prof);
    measures.worst = cell(point(0), [], nobody);
  }

  const zero = money(0, cur, L);
  const worstWords = t("email.worstWords", { zero });
  const harmWords =
    worstHarm !== null && worstHarm > 0
      ? t("email.harmWords", {
          rate: pct(worstHarm, L),
          count: Math.round(recipients * worstHarm),
        })
      : null;
  return {
    key: optionKey(o),
    option: o,
    kind: "email",
    title: segmentTitle(o.segment, words),
    what: seg
      ? t("email.what", { segment: o.segment, emailable: num(recipients, 0, L) })
      : t("email.whatNoList"),
    currency: cur,
    inputs,
    assumptions: [
      {
        statement: t("email.assumption", { kind: campaignKind }),
        source: t("email.assumptionSource"),
      },
    ],
    measures,
    worst_words: harmWords ? `${worstWords} ${harmWords}` : worstWords,
    key_rate: rate ? { name: "bought_again_rate", label: t("email.keyRate"), range: rate } : null,
    cross_check: x.cross_check.email,
    guard: null,
    proposable:
      x.email.posture === "disabled"
        ? { ok: false, why: t("email.noConsent") }
        : recipients === 0
          ? { ok: false, why: seg ? t("email.nobodyEmailable") : t("email.importFirst") }
          : { ok: true },
  };
}

/* ── the ads model ── */

const shiftDay = (day: string, by: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

/** Pure: the ads window, ending yesterday (today is never whole). */
export function adsWindow(asOf: string): { from: string; to: string } {
  const to = shiftDay(asOf, -1);
  return { from: shiftDay(to, -(SIM.ads_window_days - 1)), to };
}

/**
 * Pure: return on ad spend for every rolling 7-day block that lies wholly
 * inside the window and spent something — the measured spread of a week.
 */
export function weeklyRoas(days: CampaignRaw["days"], asOf: string): number[] {
  const { from, to } = adsWindow(asOf);
  const byDate = new Map(
    days.filter((d) => d.date >= from && d.date <= to).map((d) => [d.date, d]),
  );
  const out: number[] = [];
  for (
    let start = from;
    shiftDay(start, SIM.ads_block_days - 1) <= to;
    start = shiftDay(start, 1)
  ) {
    let spend = 0;
    let value = 0;
    for (let i = 0; i < SIM.ads_block_days; i++) {
      const d = byDate.get(shiftDay(start, i));
      if (d) {
        spend += d.spend_minor;
        value += d.value_minor;
      }
    }
    if (spend > 0) out.push(value / spend);
  }
  return out;
}

/** Pure: the campaign's measured days in the window and its average day. */
export function campaignWindow(c: CampaignRaw, asOf: string) {
  const { from, to } = adsWindow(asOf);
  const days = c.days.filter((d) => d.date >= from && d.date <= to && d.spend_minor > 0);
  const spend = days.reduce((s, d) => s + d.spend_minor, 0);
  const value = days.reduce((s, d) => s + d.value_minor, 0);
  return {
    measured_days: days.length,
    spend_minor: spend,
    value_minor: value,
    daily_minor: days.length > 0 ? Math.round(spend / days.length) : 0,
  };
}

/** Pure: the account's average day in one currency — the ceiling's left-hand side (as lib/ads). */
export function accountDaily(campaigns: readonly CampaignRaw[], asOf: string, currency: string) {
  return campaigns
    .filter((c) => c.currency.toUpperCase() === currency.toUpperCase())
    .reduce((s, c) => s + campaignWindow(c, asOf).daily_minor, 0);
}

function simulateAds(
  o: Extract<SimOption, { kind: "ads" }>,
  x: SimInputs,
  w: SimText,
): OptionResult {
  const words = wordsOf(w);
  const { t, L } = words;
  const H = SIM.horizon_days;
  const days = int(H, L);
  const inputs: SimInput[] = [];
  const isNew = o.change === "new";
  const campaign = isNew ? null : findCampaign(x.ads.campaigns, o.campaign_ref, o.platform);
  // Meta's own words for a Meta campaign (and a new one: SYB creates them on
  // Meta); another platform's campaign is said with that platform's name.
  const other =
    campaign && (campaign.platform ?? "meta") !== "meta"
      ? SIM_AD_PLATFORM_NAME[campaign.platform as SimAdPlatform]
      : null;
  const said = (metaKey: string, vars: Record<string, string | number> = {}) =>
    other === null
      ? t(`ads.${metaKey}`, vars)
      : t(`ads.${metaKey}On`, { ...vars, platform: other });
  const cur = isNew ? o.currency : (campaign?.currency ?? x.currency);
  const name = campaign?.name ?? t("ads.thisCampaign");
  const win = campaign ? campaignWindow(campaign, x.as_of) : null;
  const enoughDays = (win?.measured_days ?? 0) >= SIM.ads_min_measured_days;
  const minDays = int(SIM.ads_min_measured_days, L);
  const metaNeeds = t("ads.metaNeeds");

  // 1. Spend over the horizon, signed: a pause or a cut is money not spent.
  let spend: number | null = null;
  let spendSource = "";
  if (isNew) {
    spend = o.daily_budget_minor === null ? null : o.daily_budget_minor * H;
    inputs.push({
      key: "daily",
      ...labelled(t, "dailyNew"),
      range: o.daily_budget_minor === null ? null : point(o.daily_budget_minor),
      unit: "money",
      basis: o.daily_budget_minor === null ? null : "STATED",
      source: t("ads.typedSource"),
      needs: o.daily_budget_minor === null ? t("ads.typedNeeds") : null,
    });
    spendSource = t("ads.newSpendFormula", {
      daily: o.daily_budget_minor === null ? "?" : exactMoney(o.daily_budget_minor, cur, L),
      days,
    });
  } else {
    inputs.push({
      key: "daily",
      ...labelled(t, "dailyNow"),
      range: win && win.measured_days > 0 ? point(win.daily_minor) : null,
      unit: "money",
      basis: win && win.measured_days > 0 ? "OBSERVED" : null,
      source:
        win && win.measured_days > 0
          ? said("dailySource", {
              spend: money(win.spend_minor, cur, L),
              count: win.measured_days,
              window: int(SIM.ads_window_days, L),
            })
          : t("ads.noSpend"),
      needs:
        win && win.measured_days > 0 ? null : x.ads.connected ? t("ads.dailyNeeds") : metaNeeds,
    });
    if (win && win.measured_days > 0) {
      const d = win.daily_minor;
      if (o.change === "pause") {
        spend = -d * H;
        spendSource = t("ads.pauseFormula", { daily: exactMoney(d, cur, L), days });
      } else {
        const delta = Math.round(d * o.share) * (o.change === "raise" ? 1 : -1);
        spend = delta * H;
        spendSource = t("ads.changeFormula", {
          daily: exactMoney(d, cur, L),
          change: `${o.change === "raise" ? "+" : "−"}${wholePct(Math.round(o.share * 100), L)}`,
          days,
        });
      }
    }
  }

  // 2. Return on ad spend, per rolling week.
  const pooled = isNew;
  const blocks = pooled
    ? x.ads.campaigns
        // A new campaign is made on Meta: judged on Meta's own campaigns.
        .filter((c) => (c.platform ?? "meta") === "meta")
        .filter((c) => c.currency.toUpperCase() === cur.toUpperCase())
        .filter((c) => campaignWindow(c, x.as_of).measured_days >= SIM.ads_min_measured_days)
        .flatMap((c) => weeklyRoas(c.days, x.as_of))
    : campaign && enoughDays
      ? weeklyRoas(campaign.days, x.as_of)
      : [];
  const roas = spread(blocks);
  const which = pooled ? "pooled" : "one";
  inputs.push({
    key: "roas",
    ...labelled(t, "roas"),
    range: roas,
    unit: "ratio",
    basis: roas ? "OBSERVED" : null,
    source: roas
      ? said("roasSource", {
          which,
          block: int(SIM.ads_block_days, L),
          window: int(SIM.ads_window_days, L),
          count: blocks.length,
        })
      : pooled
        ? t("ads.roasNonePooled", { days: minDays, currency: cur })
        : t("ads.roasNone", { count: win?.measured_days ?? 0, need: minDays }),
    needs: roas ? null : x.ads.connected ? t("ads.roasNeeds", { which, days: minDays }) : metaNeeds,
  });
  inputs.push(marginInput(x.margin, w));

  const measures = emptyMeasures(words);
  measures.reached = { status: "none", why: said("reachNotRead") };
  measures.orders = { status: "none", why: said("ordersNotRead") };
  if (spend !== null) {
    measures.cost = cell(point(spend), orderBases([inputs[0]!.basis]), spendSource, true);
  } else {
    measures.cost = missingCell(need(inputs, ["daily"], words) as Extract<Got, { ok: false }>);
  }
  const rv = need(inputs, ["daily", "roas"], words);
  let revenue: Range | null = null;
  if (rv.ok && spend !== null) {
    revenue = roundRange(mul(point(spend), rv.vals[1]!));
    measures.revenue = cell(
      revenue,
      rv.bases,
      said("revenueFormula", {
        spend: exactMoney(spend, cur, L),
        roas: term(rv.vals[1]!, "ratio", cur, L),
      }),
    );
  } else if (!rv.ok) measures.revenue = missingCell(rv);
  const pr = need(inputs, ["daily", "roas", "margin"], words);
  let worstWords = "";
  if (pr.ok && spend !== null && revenue) {
    const m = pr.vals[2]!;
    const profit = roundRange(minus(mul(revenue, m), spend));
    measures.profit = cell(
      profit,
      pr.bases,
      t("profitFormula", {
        revenue: term(revenue, "money", cur, L),
        margin: term(m, "rate", cur, L),
        spend: subtrahend(spend, cur, L),
      }),
    );
    // The worst measured week: the weakest one for new spend, the strongest one for spend stopped.
    const worstRoas = spend >= 0 ? Math.min(...blocks) : Math.max(...blocks);
    const worstMargin = spend >= 0 ? m.low : m.high;
    const worst = Math.round(spend * worstRoas * worstMargin - spend);
    measures.worst = cell(
      point(worst),
      pr.bases,
      t("ads.worstFormula", {
        // Bracketed when negative: it is both a factor and the term taken away.
        spend: subtrahend(spend, cur, L),
        roas: twoDp(worstRoas, L),
        margin: pct(worstMargin, L),
      }),
    );
    worstWords = t(spend >= 0 ? "ads.worstWeakest" : "ads.worstBest", {
      roas: twoDp(worstRoas, L),
      amount: money(worst, cur, L),
      days,
    });
  } else if (!pr.ok) {
    measures.profit = missingCell(pr);
    measures.worst = missingCell(pr);
  }
  if (!worstWords) {
    worstWords =
      spend !== null && spend > 0
        ? t("ads.worstUnsized", { amount: money(spend, cur, L) })
        : t("worstUnknown");
  }

  // 3. The spend guard (P3-22c), on the same arithmetic the generator runs.
  let guard: string | null = null;
  const ceiling = x.ads.ceiling;
  if (o.change === "raise" || o.change === "lower") {
    if (win && win.daily_minor > 0) {
      // lib/ads/guard's refusal, as that module words it.
      guard = spendGuard({
        current_daily_minor: win.daily_minor,
        proposed_daily_minor:
          win.daily_minor + Math.round(win.daily_minor * o.share) * (o.change === "raise" ? 1 : -1),
        currency: cur,
        account_daily_minor: accountDaily(x.ads.campaigns, x.as_of, cur),
        monthly_ceiling: ceiling,
      });
    }
  } else if (isNew && ceiling && o.daily_budget_minor !== null) {
    if (ceiling.currency.toUpperCase() !== cur.toUpperCase()) {
      guard = t("ads.guardCurrency", { ceiling: ceiling.currency, currency: cur });
    } else {
      const projected = (accountDaily(x.ads.campaigns, x.as_of, cur) + o.daily_budget_minor) * 30;
      if (projected > ceiling.amount_minor) {
        guard = t("ads.guardCeiling", {
          projected: money(projected, cur, L),
          ceiling: money(ceiling.amount_minor, cur, L),
        });
      }
    }
  }

  const title = isNew
    ? o.daily_budget_minor === null
      ? t("ads.titleNewOpen")
      : t("ads.titleNew", { amount: money(o.daily_budget_minor, cur, L) })
    : o.change === "pause"
      ? t("ads.titlePause", { name })
      : t(o.change === "raise" ? "ads.titleRaise" : "ads.titleCut", {
          name,
          share: wholePct(Math.round(o.share * 100), L),
        });
  const what = isNew
    ? t("ads.whatNew")
    : o.change === "pause"
      ? said("whatPause")
      : t(o.change === "raise" ? "ads.whatRaise" : "ads.whatCut");
  let proposable: OptionResult["proposable"] = { ok: true };
  if (isNew) {
    proposable = { ok: false, why: t("ads.newNotProposable", { task: "P3-54" }) };
  } else if (!campaign || !enoughDays) {
    proposable = { ok: false, why: t("ads.tooFewDays", { days: minDays }) };
  } else if (guard) {
    proposable = { ok: false, why: t("ads.guarded", { guard }) };
  }
  return {
    key: optionKey(o),
    option: o,
    kind: "ads",
    title,
    what,
    currency: cur,
    inputs,
    assumptions: [
      {
        statement: t(
          o.change === "pause" || o.change === "lower" ? "ads.assumeStop" : "ads.assumeExtra",
        ),
        source: said("assumptionSource"),
      },
    ],
    measures,
    worst_words: worstWords,
    key_rate: roas ? { name: "roas", label: t("ads.keyRate"), range: roas } : null,
    cross_check: x.cross_check.ads,
    guard,
    proposable,
  };
}

/* ── the content model ── */

function simulateContent(
  o: Extract<SimOption, { kind: "content" }>,
  x: SimInputs,
  w: SimText,
): OptionResult {
  const words = wordsOf(w);
  const { t, L } = words;
  const cur = x.currency;
  const c = x.content;
  const posts = c.social_channels * c.per_week * CONTENT_WEEKS;
  const platform = c.platform === "facebook" ? "Facebook" : "Instagram";
  const audience = c.platform === "facebook" ? "views" : "reach";
  const recent = c.posts.slice(0, SIM.content_baseline_posts);
  const reachVals = recent.map((p) => p.reach).filter((v): v is number => v !== null);
  const interVals = recent.map((p) => p.interactions).filter((v): v is number => v !== null);
  const postNeeds = c.publish_connected
    ? t("content.postNeeds", { count: SIM.content_min_posts })
    : t("content.postNeedsConnect");
  const age = int(SIM.content_age_days, L);

  const inputs: SimInput[] = [];
  inputs.push({
    key: "posts",
    ...labelled(t, "posts"),
    range: posts > 0 ? point(posts) : null,
    unit: "count",
    basis: posts > 0 ? "DERIVED" : null,
    source:
      posts > 0
        ? t("content.postsSource", {
            count: c.social_channels,
            perWeek: int(c.per_week, L),
            weeks: int(CONTENT_WEEKS, L),
          })
        : t("content.noChannel"),
    needs: posts > 0 ? null : t("content.channelNeeds"),
  });
  const reach = reachVals.length >= SIM.content_min_posts ? spread(reachVals) : null;
  inputs.push({
    key: "reach",
    ...labelled(t, "reach", { audience }),
    range: reach,
    unit: "count",
    basis: reach ? "OBSERVED" : null,
    source: reach
      ? t("content.reachSource", { platform, age, count: reachVals.length })
      : t("content.measured", { count: reachVals.length }),
    needs: reach ? null : postNeeds,
  });
  const inter = interVals.length >= SIM.content_min_posts ? spread(interVals) : null;
  inputs.push({
    key: "interactions",
    ...labelled(t, "interactions"),
    range: inter,
    unit: "count",
    basis: inter ? "OBSERVED" : null,
    source: inter
      ? t("content.interactionsSource", { platform, age, count: interVals.length })
      : t("content.measured", { count: interVals.length }),
    needs: inter ? null : postNeeds,
  });
  const spi =
    c.social_sessions !== null && c.window_interactions !== null && c.window_interactions > 0
      ? c.social_sessions / c.window_interactions
      : null;
  inputs.push({
    key: "spi",
    ...labelled(t, "spi"),
    range: spi === null ? null : point(spi),
    unit: "ratio",
    basis: spi === null ? null : "OBSERVED",
    source:
      spi === null
        ? t("content.spiNone")
        : t("content.spiSource", {
            visits: count(c.social_sessions ?? 0, L),
            channel: SIM.social_channel_ref,
            interactions: count(c.window_interactions ?? 0, L),
            days: int(SIM.site_window_days, L),
          }),
    needs:
      spi !== null
        ? null
        : c.analytics_connected
          ? t("content.spiNeeds")
          : t("content.spiNeedsConnect"),
  });
  const convDays = x.site.days.filter((d) => d.sessions > 0).map((d) => d.orders / d.sessions);
  const conversion = { key: "conversion", ...labelled(t, "conversion") };
  let conv: SimInput;
  if (convDays.length >= SIM.site_min_days) {
    conv = {
      ...conversion,
      range: spread(convDays),
      unit: "rate",
      basis: "OBSERVED",
      source: t("content.conversionSource", {
        count: convDays.length,
        window: int(SIM.site_window_days, L),
      }),
      needs: null,
    };
  } else if (
    x.site.stated_orders_monthly !== null &&
    x.site.stated_sessions_monthly !== null &&
    x.site.stated_sessions_monthly > 0
  ) {
    conv = {
      ...conversion,
      range: point(x.site.stated_orders_monthly / x.site.stated_sessions_monthly),
      unit: "rate",
      basis: "DERIVED",
      source: t("content.conversionStated"),
      needs: null,
    };
  } else {
    conv = {
      ...conversion,
      range: null,
      unit: "rate",
      basis: null,
      source: t("notKnown"),
      needs: t("content.conversionNeeds"),
    };
  }
  inputs.push(conv);
  inputs.push(orderValueInput(x.aov, "aov", w));
  inputs.push(marginInput(x.margin, w));

  const nobody = t("content.worstFormula");
  const measures = emptyMeasures(words);
  measures.cost = cell(point(0), [], t("content.costFormula"), true);
  const rc = need(inputs, ["posts", "reach"], words);
  measures.reached = rc.ok
    ? cell(
        roundRange(mul(rc.vals[0]!, rc.vals[1]!)),
        rc.bases,
        t("content.reachedFormula", {
          posts: count(posts, L),
          reach: term(rc.vals[1]!, "count", cur, L),
          audience,
        }),
      )
    : missingCell(rc);
  const od = need(inputs, ["posts", "interactions", "spi", "conversion"], words);
  let orderRange: Range | null = null;
  if (od.ok) {
    const interactions = mul(od.vals[0]!, od.vals[1]!);
    const visits = mul(interactions, od.vals[2]!);
    orderRange = roundRange(mul(visits, od.vals[3]!));
    measures.orders = cell(
      orderRange,
      od.bases,
      t("content.ordersFormula", {
        posts: count(posts, L),
        interactions: term(od.vals[1]!, "count", cur, L),
        visits: twoDp(od.vals[2]!.low, L),
        rate: term(od.vals[3]!, "rate", cur, L),
      }),
    );
  } else measures.orders = missingCell(od);
  const rv = need(inputs, ["posts", "interactions", "spi", "conversion", "aov"], words);
  let revenue: Range | null = null;
  if (rv.ok && orderRange) {
    revenue = roundRange(mul(orderRange, rv.vals[4]!));
    measures.revenue = cell(
      revenue,
      rv.bases,
      t("revenueFormula", {
        orders: term(orderRange, "count", cur, L),
        value: term(rv.vals[4]!, "money", cur, L),
      }),
    );
  } else if (!rv.ok) measures.revenue = missingCell(rv);
  const pr = need(inputs, ["posts", "interactions", "spi", "conversion", "aov", "margin"], words);
  if (pr.ok && revenue) {
    measures.profit = cell(
      roundRange(mul(revenue, pr.vals[5]!)),
      pr.bases,
      t("profitFormula", {
        revenue: term(revenue, "money", cur, L),
        margin: term(pr.vals[5]!, "rate", cur, L),
        spend: money(0, cur, L),
      }),
    );
    measures.worst = cell(point(0), [], nobody);
  } else {
    if (!pr.ok) measures.profit = missingCell(pr);
    measures.worst = cell(point(0), [], nobody);
  }
  const weakest = reachVals.length ? Math.min(...reachVals) : null;
  const zero = money(0, cur, L);
  return {
    key: optionKey(o),
    option: o,
    kind: "content",
    title: t("content.title", { weeks: int(CONTENT_WEEKS, L) }),
    what: posts > 0 ? t("content.what", { count: posts }) : t("content.whatNone"),
    currency: cur,
    inputs,
    assumptions: [
      {
        statement: t("content.assumption", {
          platform,
          channels: c.social_channels > 1 ? "many" : "one",
        }),
        source: t("content.assumptionSource"),
      },
    ],
    measures,
    worst_words:
      weakest !== null
        ? t("content.worstWeakest", { weakest: count(weakest, L), zero })
        : t("content.worstNone", { zero }),
    key_rate: reach
      ? { name: "reach_per_post", label: t("content.keyRate", { audience }), range: reach }
      : null,
    cross_check: x.cross_check.content,
    guard: null,
    proposable: c.social_channels > 0 ? { ok: true } : { ok: false, why: t("content.addChannel") },
  };
}

function emptyMeasures({ t }: W): Record<MeasureKey, Cell> {
  const none: Cell = { status: "none", why: t("notWorkedOut") };
  return { cost: none, reached: none, orders: none, revenue: none, profit: none, worst: none };
}

/* ── one option, and the side by side ── */

/** Pure: one option's chain, measures and worst case, in `w`'s words (English by default). */
export function simulateOption(
  o: SimOption,
  x: SimInputs,
  w: SimText = englishSimText(),
): OptionResult {
  const r =
    o.kind === "email"
      ? simulateEmail(o, x, w)
      : o.kind === "ads"
        ? simulateAds(o, x, w)
        : simulateContent(o, x, w);
  // The worst case is one scenario, not a spread: it prints as one figure.
  if (r.measures.worst.status === "range") r.measures.worst.exact = true;
  return r;
}

export interface ComparisonRow {
  measure: MeasureKey;
  label: string;
  unit: "money" | "count";
  /** One cell per option, in the options' order. */
  cells: Cell[];
  /** Set when money cells are in more than one currency: never converted (rule 1). */
  note: string | null;
}

export interface Comparison {
  options: OptionResult[];
  rows: ComparisonRow[];
}

/**
 * Pure: 2–4 options as comparable rows — the same measures, in the same
 * units, in the same order, with the arithmetic on every cell.
 */
export function compareOptions(
  options: readonly SimOption[],
  x: SimInputs,
  w: SimText = englishSimText(),
): Comparison {
  if (options.length < SIM.min_options || options.length > SIM.max_options) {
    throw new SimulateError(
      `pick between ${SIM.min_options} and ${SIM.max_options} options to compare — ${options.length} given`,
    );
  }
  const keys = options.map(optionKey);
  if (new Set(keys).size !== keys.length) {
    throw new SimulateError("the same option twice can't be compared with itself");
  }
  const results = options.map((o) => simulateOption(o, x, w));
  const currencies = new Set(results.map((r) => r.currency.toUpperCase()));
  const note = section(w, "model")("currencies", {
    currencies: andList([...currencies], w.locale),
  });
  const rows = MEASURES.map((m) => ({
    measure: m,
    label: MEASURE_LABEL[m],
    unit: MEASURE_UNIT[m],
    cells: results.map((r) => r.measures[m]),
    note: MEASURE_UNIT[m] === "money" && currencies.size > 1 ? note : null,
  }));
  return { options: results, rows };
}

/* ── the catalog: what can be picked ── */

export interface CatalogCampaign {
  ref: string;
  name: string;
  currency: string;
  measured_days: number;
  daily_minor: number;
}

export interface Catalog {
  currency: string;
  email: { key: EmailSegmentKey; title: string; emailable: number }[];
  campaigns: CatalogCampaign[];
  ads_connected: boolean;
  content: { posts: number };
}

/** Pure: every option the owner can pick, measured or not. */
export function catalogOf(x: SimInputs, w: SimText = englishSimText()): Catalog {
  const words = wordsOf(w);
  return {
    currency: x.currency,
    email: (["lapsed", "vip"] as const).map((key) => ({
      key,
      title: segmentTitle(key, words),
      emailable: x.email.segments.find((s) => s.key === key)?.emailable ?? 0,
    })),
    campaigns: x.ads.campaigns.map((c) => {
      const win = campaignWindow(c, x.as_of);
      return {
        ref: c.ref,
        name: c.name,
        currency: c.currency,
        measured_days: win.measured_days,
        daily_minor: win.daily_minor,
      };
    }),
    ads_connected: x.ads.connected,
    content: { posts: x.content.social_channels * x.content.per_week * CONTENT_WEEKS },
  };
}
