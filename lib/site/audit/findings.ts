// Site findings — Phase 5 Session C (P5-13), site-audit §2's SiteFinding.
//
// Pure. Every finding here is `kind: "measured"`: a number Google measured
// or a count SYB made by reading pages, held against a threshold stated in
// SITE_THRESHOLDS — never a judgement. The spec's "judged" layer (a vision
// model reasoning over screenshots) is out of scope for this session: no
// browser is run, no screenshot exists, and no model is called, so
// `evidence.screenshot` is null on every finding.
//
// THE € FIGURE (rule 25). Only the slow-mobile-load finding carries one,
// and only when the owner's OWN traffic and conversion exist — measured
// (orders and sessions from their connectors, at least MIN_MEASURED_DAYS
// of both) or stated (monthly sessions, orders and revenue). It is a range,
// it names its window and sources, and it names what it ASSUMES: the
// rule-of-thumb share of orders lost per extra second, which is a published
// pattern and never the owner's own number. With no traffic or conversion
// of their own it says "not computed" and what is missing.
//
// L-4c: every word here is the "siteWords" catalogue's English
// (lib/site/say.ts) — the stored finding is English, as before — and
// lib/site/localize.ts runs siteFindings again over the stored measurements
// with the reader's translator, so another language is said, not stored.

import { format, money, roundMinorTo, scaleMinor } from "../../core/money";
import type { DiagnosisFinding, Severity } from "../../diagnosis/findings";
import { intlNumber, presentMoney } from "../../i18n/format";
import type { AppLocale } from "../../i18n/locales";
import { rangeOf } from "../../i18n/range";
import { intlTag } from "../../i18n/locales";
import type { Tr } from "../../i18n/tr";
import { fixed, joinSentences, plain, siteEnglish } from "../say";
import { FIRST_SCREEN_CHARS } from "./links";
import type { PageSpeedResult, Strategy } from "./pagespeed";
import type { WalkResult } from "./walk";

const EN = siteEnglish();

export interface LocalizedText {
  en: string;
}

/** What a number rests on, in the order of strength. */
export type FindingBasis = "field" | "field_origin" | "lab" | "page_read";

export type EuroFigure =
  | {
      computed: true;
      low_minor: number;
      high_minor: number;
      currency: string;
      per: "month";
      formula: string;
      window: string;
      sources: string[];
      assumed: string[];
      /** Absent on audits stored before L-4c, whose formula stays in English. */
      inputs?: EuroInputs;
    }
  | { computed: false; why: string };

/** site-audit §2, as built: see the spec's "as built" note for the fields added. */
export interface SiteFinding {
  /** Deterministic: the same problem on the same page has the same id across audits. */
  id: string;
  code: SiteFindingCode;
  page_url: string;
  kind: "measured";
  severity: Severity;
  title: LocalizedText;
  detail: LocalizedText;
  evidence: {
    /** No browser is run in Tier 1 as built, so there is no screenshot. */
    screenshot: null;
    metric?: string;
    value?: number;
    unit?: "ms" | "score" | "bytes" | "count" | "clicks";
    basis: FindingBasis;
    strategy?: Strategy;
    /** "pagespeed_insights v5" or "page read". */
    source: string;
    measured_at: string;
  };
  /** The stated threshold it crossed, in words. */
  threshold: string;
  /** Clicks from home to the page it sits on. */
  step_in_journey: number;
  euro: EuroFigure;
}

export type SiteFindingCode =
  | "lcp_slow"
  | "cls_unstable"
  | "inp_slow"
  | "tbt_slow"
  | "page_heavy"
  | "tap_targets"
  | "contrast"
  | "path_long"
  | "path_missing"
  | "price_hidden"
  | "form_long"
  | "broken_link";

/** Every threshold the severities come from — stated, and tested at the boundaries. */
export const SITE_THRESHOLDS = {
  /** Google's Core Web Vitals: good ≤ 2.5 s, poor > 4 s (75th percentile). */
  lcp_ms: { good: 2500, poor: 4000 },
  /** Google's Core Web Vitals: good ≤ 0.1, poor > 0.25. */
  cls: { good: 0.1, poor: 0.25 },
  /** Google's Core Web Vitals: good ≤ 200 ms, poor > 500 ms. */
  inp_ms: { good: 200, poor: 500 },
  /** Lighthouse's mobile scoring for Total Blocking Time — the lab's stand-in for INP. */
  tbt_ms: { good: 200, poor: 600 },
  /** SYB's own: a page over 3 MB is heavy on a phone connection, over 6 MB very heavy. */
  page_bytes: { medium: 3_000_000, high: 6_000_000 },
  /** SYB's own: elements failing Google's contrast or tap-target check. */
  failures: { medium: 5 },
  /** SYB's own: clicks from home to the checkout entry (shop) or booking entry. */
  clicks: { shop: { ok: 4, medium: 6 }, booking: { ok: 2, medium: 4 } },
  /** SYB's own: fields a contact or booking form asks for. */
  form_fields: { medium: 6, high: 9 },
} as const;

export type Rating = "good" | "needs_improvement" | "poor";

/** Pure: Google's three bands for a vital. Boundaries inclusive on the good side, as Google's are. */
export function rate(value: number, band: { good: number; poor: number }): Rating {
  if (value <= band.good) return "good";
  if (value <= band.poor) return "needs_improvement";
  return "poor";
}

/** Pure: severity for a vital's rating on a strategy. Phones carry most small-business traffic. */
export function vitalSeverity(rating: Rating, strategy: Strategy): Severity | null {
  if (rating === "good") return null;
  if (strategy === "mobile") return rating === "poor" ? "high" : "medium";
  return rating === "poor" ? "medium" : "low";
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** "2.5 s", "4.0 MB", "350 ms" — English as the code always wrote them; another language its own digits. */
const seconds = (ms: number, tr: Tr, locale: AppLocale) =>
  tr("finding.unit.s", { value: fixed(ms / 1000, 1, locale) });
const mb = (bytes: number, tr: Tr, locale: AppLocale) =>
  tr("finding.unit.mb", { value: fixed(bytes / 1_000_000, 1, locale) });
const millis = (ms: number, tr: Tr, locale: AppLocale) =>
  tr("finding.unit.ms", { value: plain(ms, locale) });

/** "fernhill.example/products/mug" — the address as an owner would say it. */
export function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

const phone = (s: Strategy, tr: Tr) =>
  tr(s === "mobile" ? "finding.on.mobile" : "finding.on.desktop");

/* ── the € figure ── */

/** The owner's own site figures, monthly, and where they came from. */
export interface OwnerSiteFigures {
  sessions_per_month: number;
  orders_per_month: number;
  /** Average order value, minor units. */
  aov_minor: number;
  currency: string;
  basis: "measured" | "stated";
  /** "the 28 days to 2026-10-26 (26 days measured)" or "your stated monthly figures". */
  window: string;
  /** The day the figures are as of (YYYY-MM-DD), so the window can be said in another language (L-4c). */
  as_of?: string;
  sources: string[];
}

/** What the estimate ASSUMES, by name (rule 25): a published rule of thumb, not the owner's own. */
export const SPEED_RULE_OF_THUMB = {
  /** Share of orders lost per second of mobile load beyond the good line, low and high. */
  lost_per_second: { low: 0.01, high: 0.04 },
  /** Seconds counted at most: past that the rule of thumb says nothing. */
  max_seconds: 3,
} as const;

/** The figures a computed € line was worked from, kept so its words can be said again (L-4c). */
export interface EuroInputs {
  sessions_per_month: number;
  orders_per_month: number;
  aov_minor: number;
  /** Seconds over the good line that were counted. */
  over_s: number;
  basis: "measured" | "stated";
  as_of: string | null;
}

function percent(n: number, decimals: number, locale: AppLocale): string {
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n / 100);
}

/** "1–4%": the rule of thumb's range, as the code always wrote it in English. */
function lostRange(locale: AppLocale): string {
  const low = SPEED_RULE_OF_THUMB.lost_per_second.low * 100;
  const high = SPEED_RULE_OF_THUMB.lost_per_second.high * 100;
  return locale === "en"
    ? `${low.toFixed(0)} to ${high.toFixed(0)}%`
    : rangeOf(intlNumber(low, 0, locale), percent(high, 0, locale), locale);
}

/** Pure: how a computed € line was worked out, in words. */
export function speedFormula(
  inputs: EuroInputs,
  currency: string,
  tr: Tr = EN,
  locale: AppLocale = "en",
): string {
  const conversion = (inputs.orders_per_month / inputs.sessions_per_month) * 100;
  const visits = Math.round(inputs.sessions_per_month);
  const aov = money(inputs.aov_minor, currency);
  return tr("euro.formula", {
    visits: locale === "en" ? visits.toLocaleString("en") : intlNumber(visits, 0, locale),
    conversion: locale === "en" ? `${conversion.toFixed(1)}%` : percent(conversion, 1, locale),
    aov: locale === "en" ? format(aov) : presentMoney(aov, locale),
    range: lostRange(locale),
    over: seconds(inputs.over_s * 1000, tr, locale),
  });
}

/** Pure: what every computed € line assumes, by name. */
export function speedAssumed(tr: Tr = EN, locale: AppLocale = "en"): string[] {
  return [
    tr("euro.assumed.wait", {
      good: seconds(SITE_THRESHOLDS.lcp_ms.good, tr, locale),
      range: lostRange(locale),
    }),
    tr("euro.assumed.everyOrder"),
    tr("euro.assumed.max", { max: SPEED_RULE_OF_THUMB.max_seconds }),
  ];
}

/** Pure: the € at stake on a slow mobile load, or why it is not computed. */
export function speedEuro(
  lcpMs: number,
  figures: OwnerSiteFigures | { missing: string } | null,
): EuroFigure {
  if (figures === null || "missing" in figures) {
    return {
      computed: false,
      why: figures ? EN("euro.needsBecause", { missing: figures.missing }) : EN("euro.needs"),
    };
  }
  if (figures.sessions_per_month <= 0 || figures.orders_per_month <= 0 || figures.aov_minor <= 0) {
    return { computed: false, why: EN("euro.zero") };
  }
  const over = Math.min(
    (lcpMs - SITE_THRESHOLDS.lcp_ms.good) / 1000,
    SPEED_RULE_OF_THUMB.max_seconds,
  );
  if (over <= 0) return { computed: false, why: EN("euro.inside") };
  // sessions × (orders ÷ sessions) × AOV is orders × AOV: one exact product,
  // the order count taken at its written decimal (hard rule 1).
  const monthly = scaleMinor(figures.aov_minor, figures.orders_per_month);
  const round = (minor: number) => roundMinorTo(minor, 100);
  const lost = (rate: number) => scaleMinor(scaleMinor(monthly, rate), over);
  const inputs: EuroInputs = {
    sessions_per_month: figures.sessions_per_month,
    orders_per_month: figures.orders_per_month,
    aov_minor: figures.aov_minor,
    over_s: over,
    basis: figures.basis,
    as_of: figures.as_of ?? null,
  };
  return {
    computed: true,
    low_minor: round(lost(SPEED_RULE_OF_THUMB.lost_per_second.low)),
    high_minor: round(lost(SPEED_RULE_OF_THUMB.lost_per_second.high)),
    currency: figures.currency,
    per: "month",
    formula: speedFormula(inputs, figures.currency),
    window: figures.window,
    sources: figures.sources,
    assumed: speedAssumed(),
    inputs,
  };
}

const NOT_SPEED: EuroFigure = { computed: false, why: EN("euro.notSpeed") };

/* ── from the measurements to findings ── */

export interface AuditInput {
  walk: WalkResult;
  speed: PageSpeedResult[];
  figures: OwnerSiteFigures | { missing: string } | null;
  measured_at: string;
}

interface VitalPick {
  page_url: string;
  value: number;
  basis: FindingBasis;
  measured_at: string;
}

/** The value of a vital for one result: field where Google has it, else lab. */
function vitalOf(
  r: PageSpeedResult,
  metric: "lcp_ms" | "cls" | "inp_ms" | "tbt_ms",
): { value: number; basis: FindingBasis } | null {
  if (metric !== "tbt_ms") {
    const f = r.field?.[metric];
    if (f) return { value: f.p75, basis: r.field?.origin_fallback ? "field_origin" : "field" };
  }
  if (metric === "inp_ms") return null; // lab has no INP
  const lab = r.lab[metric];
  return lab === null ? null : { value: lab, basis: "lab" };
}

/** Google's field data: the last 28 days, at the 75th percentile. */
const FIELD = { days: 28, percentile: 75 } as const;

function basisWords(basis: FindingBasis, tr: Tr): string {
  return tr(`finding.basis.${basis}`, { days: FIELD.days, pct: FIELD.percentile });
}

function clicksTo(walk: WalkResult, url: string): number {
  return walk.pages.find((p) => p.url === url)?.clicks ?? 0;
}

/** The status from which a link of the owner's own counts as broken. */
const BROKEN_FROM = 400;

/**
 * Pure: every measured finding of one audit, severest first. Its words are
 * English (what is stored); lib/site/localize.ts runs it again with a
 * reader's translator over the stored measurements.
 */
export function siteFindings(
  input: AuditInput,
  tr: Tr = EN,
  locale: AppLocale = "en",
): SiteFinding[] {
  const out: SiteFinding[] = [];
  const { walk, speed } = input;
  const source = "pagespeed_insights v5";
  const withPage = (title: string, url: string) =>
    tr("finding.withPage", { title, page: bareUrl(url) });

  const vital = (
    code: SiteFindingCode,
    metric: "lcp_ms" | "cls" | "inp_ms" | "tbt_ms",
    band: { good: number; poor: number },
    strategy: Strategy,
  ) => {
    const picks: VitalPick[] = [];
    for (const r of speed.filter((s) => s.strategy === strategy)) {
      const v = vitalOf(r, metric);
      if (v)
        picks.push({
          page_url: r.page_url,
          value: v.value,
          basis: v.basis,
          measured_at: r.provenance.measured_at,
        });
    }
    if (metric === "tbt_ms") {
      // The stand-in only speaks for pages with no field INP.
      const withInp = new Set(
        speed.filter((s) => s.strategy === strategy && s.field?.inp_ms).map((s) => s.page_url),
      );
      for (let i = picks.length - 1; i >= 0; i--)
        if (withInp.has(picks[i]!.page_url)) picks.splice(i, 1);
    }
    const bad = picks
      .filter((p) => rate(p.value, band) !== "good")
      .sort((a, b) => b.value - a.value);
    const worst = bad[0];
    if (!worst) return;
    const rating = rate(worst.value, band);
    let severity = vitalSeverity(rating, strategy) as Severity;
    if (metric === "tbt_ms" && severity === "high") severity = "medium"; // a stand-in, never the headline
    const others = bad.length - 1;
    const unit = metric === "cls" ? "score" : "ms";
    const shown =
      metric === "cls"
        ? fixed(worst.value, 2, locale)
        : metric === "lcp_ms"
          ? seconds(worst.value, tr, locale)
          : millis(Math.round(worst.value), tr, locale);
    const name = { lcp_ms: "lcp", cls: "cls", inp_ms: "inp", tbt_ms: "tbt" }[metric];
    const on = phone(strategy, tr);
    const vitalLine = tr("finding.detail.vital", {
      what: tr(`finding.what.${name}`),
      basis: basisWords(worst.basis, tr),
    });
    out.push({
      id: `${code}:${strategy}:${worst.page_url}`,
      code,
      page_url: worst.page_url,
      kind: "measured",
      severity,
      title: { en: withPage(tr(`finding.title.${name}`, { shown, on }), worst.page_url) },
      detail: {
        en:
          others > 0
            ? joinSentences([vitalLine, tr("finding.detail.others", { count: others })], tr)
            : vitalLine,
      },
      evidence: {
        screenshot: null,
        metric,
        value: metric === "cls" ? Number(worst.value.toFixed(3)) : Math.round(worst.value),
        unit,
        basis: worst.basis,
        strategy,
        source,
        measured_at: worst.measured_at,
      },
      threshold:
        metric === "cls"
          ? tr("finding.threshold.google", {
              good: plain(band.good, locale),
              poor: plain(band.poor, locale),
            })
          : metric === "tbt_ms"
            ? tr("finding.threshold.lighthouse", {
                good: millis(band.good, tr, locale),
                poor: millis(band.poor, tr, locale),
              })
            : tr("finding.threshold.google", {
                good:
                  metric === "lcp_ms"
                    ? seconds(band.good, tr, locale)
                    : millis(band.good, tr, locale),
                poor:
                  metric === "lcp_ms"
                    ? seconds(band.poor, tr, locale)
                    : millis(band.poor, tr, locale),
              }),
      step_in_journey: clicksTo(walk, worst.page_url),
      euro:
        code === "lcp_slow" && strategy === "mobile"
          ? speedEuro(worst.value, input.figures)
          : NOT_SPEED,
    });
  };

  for (const strategy of ["mobile", "desktop"] as const) {
    vital("lcp_slow", "lcp_ms", SITE_THRESHOLDS.lcp_ms, strategy);
    vital("cls_unstable", "cls", SITE_THRESHOLDS.cls, strategy);
    vital("inp_slow", "inp_ms", SITE_THRESHOLDS.inp_ms, strategy);
    vital("tbt_slow", "tbt_ms", SITE_THRESHOLDS.tbt_ms, strategy);
  }

  // Page weight — the heaviest page, on a phone (the bytes are the same either way).
  const heavy = speed
    .filter(
      (r) =>
        r.strategy === "mobile" &&
        r.lab.page_bytes !== null &&
        r.lab.page_bytes > SITE_THRESHOLDS.page_bytes.medium,
    )
    .sort((a, b) => (b.lab.page_bytes ?? 0) - (a.lab.page_bytes ?? 0))[0];
  if (heavy && heavy.lab.page_bytes !== null) {
    const bytes = heavy.lab.page_bytes;
    out.push({
      id: `page_heavy:mobile:${heavy.page_url}`,
      code: "page_heavy",
      page_url: heavy.page_url,
      kind: "measured",
      severity: bytes > SITE_THRESHOLDS.page_bytes.high ? "high" : "medium",
      title: {
        en: withPage(tr("finding.title.heavy", { size: mb(bytes, tr, locale) }), heavy.page_url),
      },
      detail: { en: tr("finding.detail.heavy", { basis: basisWords("lab", tr) }) },
      evidence: {
        screenshot: null,
        metric: "page_bytes",
        value: Math.round(bytes),
        unit: "bytes",
        basis: "lab",
        strategy: "mobile",
        source,
        measured_at: heavy.provenance.measured_at,
      },
      threshold: tr("finding.threshold.heavy", {
        medium: mb(SITE_THRESHOLDS.page_bytes.medium, tr, locale),
        high: mb(SITE_THRESHOLDS.page_bytes.high, tr, locale),
      }),
      step_in_journey: clicksTo(walk, heavy.page_url),
      euro: NOT_SPEED,
    });
  }

  // Tap targets and contrast — the page with most failures, phone for taps.
  const failing = (code: "tap_targets" | "contrast", strategy: Strategy) => {
    const key = code === "tap_targets" ? "tap_target_failures" : "contrast_failures";
    const worst = speed
      .filter((r) => r.strategy === strategy && (r.lab[key] ?? 0) > 0)
      .sort((a, b) => (b.lab[key] ?? 0) - (a.lab[key] ?? 0))[0];
    const count = worst?.lab[key] ?? 0;
    if (!worst || count === 0) return;
    out.push({
      id: `${code}:${strategy}:${worst.page_url}`,
      code,
      page_url: worst.page_url,
      kind: "measured",
      severity: count >= SITE_THRESHOLDS.failures.medium ? "medium" : "low",
      title: {
        en: withPage(
          tr(code === "tap_targets" ? "finding.title.tap" : "finding.title.contrast", { count }),
          worst.page_url,
        ),
      },
      detail: {
        en:
          code === "tap_targets"
            ? tr("finding.detail.tap")
            : tr("finding.detail.contrast", { on: phone(strategy, tr) }),
      },
      evidence: {
        screenshot: null,
        metric: key,
        value: count,
        unit: "count",
        basis: "lab",
        strategy,
        source,
        measured_at: worst.provenance.measured_at,
      },
      threshold: tr("finding.threshold.failures", {
        medium: plain(SITE_THRESHOLDS.failures.medium, locale),
      }),
      step_in_journey: clicksTo(walk, worst.page_url),
      euro: NOT_SPEED,
    });
  };
  failing("tap_targets", "mobile");
  failing("contrast", "mobile");

  // The path to buying.
  const path = walk.path;
  const pageRead = "page read";
  if (path.kind === "shop" || path.kind === "booking") {
    const limits = SITE_THRESHOLDS.clicks[path.kind];
    const entry = path.kind === "shop" ? "checkout" : "booking";
    if (path.clicks === null) {
      // The "Counted by following…" lines are how the count was made, not why it failed.
      const counted = new Set([tr("walk.note.counted"), tr("walk.note.booking")]);
      const why = path.notes.filter((n) => !n.startsWith("Counted") && !counted.has(n));
      out.push({
        id: `path_missing:${walk.home}`,
        code: "path_missing",
        page_url: walk.home,
        kind: "measured",
        severity: "high",
        title: { en: tr("finding.title.pathMissing", { entry }) },
        detail: { en: joinSentences(why, tr) || tr("finding.detail.noEntry", { entry }) },
        evidence: {
          screenshot: null,
          basis: "page_read",
          source: pageRead,
          measured_at: input.measured_at,
        },
        threshold: tr("finding.threshold.entry", { entry }),
        step_in_journey: 0,
        euro: NOT_SPEED,
      });
    } else if (path.clicks > limits.ok) {
      out.push({
        id: `path_long:${walk.home}`,
        code: "path_long",
        page_url: walk.home,
        kind: "measured",
        severity: path.clicks > limits.medium ? "high" : "medium",
        title: { en: tr("finding.title.pathLong", { count: path.clicks, entry }) },
        detail: {
          en: tr("finding.detail.path", { steps: path.steps.map((s) => s.label).join(" → ") }),
        },
        evidence: {
          screenshot: null,
          metric: "clicks_to_entry",
          value: path.clicks,
          unit: "clicks",
          basis: "page_read",
          source: pageRead,
          measured_at: input.measured_at,
        },
        threshold: tr("finding.threshold.clicks", {
          ok: plain(limits.ok, locale),
          medium: limits.medium,
        }),
        step_in_journey: path.clicks,
        euro: NOT_SPEED,
      });
    }
  }

  // Price on the first screen of product and service pages.
  for (const page of walk.pages) {
    if (page.price_first_screen !== false) continue;
    out.push({
      id: `price_hidden:${page.url}`,
      code: "price_hidden",
      page_url: page.url,
      kind: "measured",
      severity: page.role === "product" ? "medium" : "low",
      title: { en: withPage(tr("finding.title.price", { label: page.label }), page.url) },
      detail: { en: tr("finding.detail.price") },
      evidence: {
        screenshot: null,
        metric: "price_first_screen",
        value: 0,
        unit: "count",
        basis: "page_read",
        source: pageRead,
        measured_at: input.measured_at,
      },
      threshold: tr("finding.threshold.price", { chars: FIRST_SCREEN_CHARS }),
      step_in_journey: page.clicks,
      euro: NOT_SPEED,
    });
  }

  // Form fields on contact and booking forms.
  for (const page of walk.pages) {
    const biggest = [...(page.forms ?? [])].sort((a, b) => b.fields - a.fields)[0];
    if (!biggest || biggest.fields < SITE_THRESHOLDS.form_fields.medium) continue;
    out.push({
      id: `form_long:${page.url}`,
      code: "form_long",
      page_url: page.url,
      kind: "measured",
      severity: biggest.fields >= SITE_THRESHOLDS.form_fields.high ? "high" : "medium",
      title: {
        en: withPage(
          tr("finding.title.form", { role: page.role, count: biggest.fields }),
          page.url,
        ),
      },
      detail: { en: tr("finding.detail.form", { required: biggest.required }) },
      evidence: {
        screenshot: null,
        metric: "form_fields",
        value: biggest.fields,
        unit: "count",
        basis: "page_read",
        source: pageRead,
        measured_at: input.measured_at,
      },
      threshold: tr("finding.threshold.form", {
        medium: plain(SITE_THRESHOLDS.form_fields.medium, locale),
        high: plain(SITE_THRESHOLDS.form_fields.high, locale),
      }),
      step_in_journey: page.clicks,
      euro: NOT_SPEED,
    });
  }

  // Broken links — one finding per broken address.
  for (const link of walk.broken) {
    out.push({
      id: `broken_link:${link.url}`,
      code: "broken_link",
      page_url: link.found_on,
      kind: "measured",
      severity: link.on_path ? "high" : "medium",
      title: {
        en: tr("finding.title.broken", {
          page: bareUrl(link.found_on),
          url: bareUrl(link.url),
          reason: link.reason,
        }),
      },
      detail: {
        en: tr(link.on_path ? "finding.detail.brokenOnPath" : "finding.detail.broken"),
      },
      evidence: {
        screenshot: null,
        metric: "status",
        ...(link.status !== null ? { value: link.status } : {}),
        unit: "count",
        basis: "page_read",
        source: pageRead,
        measured_at: input.measured_at,
      },
      threshold: tr("finding.threshold.broken", { status: String(BROKEN_FROM) }),
      step_in_journey: clicksTo(walk, link.found_on),
      euro: NOT_SPEED,
    });
  }

  return out.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.step_in_journey - b.step_in_journey,
  );
}

/** Pure: the € figure in words, or the reason it isn't there. */
export function euroWords(
  euro: EuroFigure,
  format: (minor: number, currency: string) => string,
): string {
  if (!euro.computed) return euro.why;
  return `about ${format(euro.low_minor, euro.currency)} to ${format(euro.high_minor, euro.currency)} a month at stake (${euro.window})`;
}

/* ── into the report ── */

/** The profile fact the audit writes, which report findings cite as evidence (P1-24). */
export const SITE_AUDIT_KEY = "presence.site_audit";

/** How many measured site findings the report carries, severest first. */
export const REPORT_SITE_FINDINGS = 4;

const CONFIDENCE: Readonly<Record<FindingBasis, number>> = {
  field: 0.9,
  field_origin: 0.8,
  lab: 0.75,
  page_read: 0.7,
};

/**
 * Pure: the measured site findings as diagnosis findings — medium and above,
 * at most REPORT_SITE_FINDINGS, each citing the audit fact. They are marked
 * measured so the report shows them apart from the diagnosis's judgement.
 */
export function toDiagnosisFindings(
  findings: readonly SiteFinding[],
  format: (minor: number, currency: string) => string,
): DiagnosisFinding[] {
  return findings
    .filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK.medium)
    .slice(0, REPORT_SITE_FINDINGS)
    .map((f) => ({
      area: "sales",
      title: f.title.en,
      detail: `${f.detail.en} Threshold: ${f.threshold}. € figure: ${euroWords(f.euro, format)}.`,
      evidence: [SITE_AUDIT_KEY],
      severity: f.severity,
      confidence: CONFIDENCE[f.evidence.basis],
      kind: "measured",
    }));
}

/** Pure: the one-line summary the audit fact carries — what the diagnosis model reads. */
export function auditSummary(findings: readonly SiteFinding[], pagesMeasured: number): string {
  if (findings.length === 0) {
    return `Site audit: ${pagesMeasured} page${pagesMeasured === 1 ? "" : "s"} measured, nothing outside the stated thresholds.`;
  }
  const head = findings
    .slice(0, 5)
    .map((f) => `${f.severity}: ${f.title.en}`)
    .join("; ");
  return `Site audit (measured): ${findings.length} finding${findings.length === 1 ? "" : "s"}: ${head}.`;
}
