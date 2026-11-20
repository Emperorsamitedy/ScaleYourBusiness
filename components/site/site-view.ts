// The /site screen's words, pure — L-3c (TASKS-LANGUAGES.md). The
// screen's own words are the "site" catalogue through an optional
// translator, English by default from messages/en.json, so English says
// exactly what it always said; dates and figures in the reader's locale,
// money in the business's own currency, never converted. A finding's
// title, detail, threshold and formula are what lib/site/audit built
// (L-4), shown as they are.

import type { EuroFigure, SiteFinding } from "../../lib/site/audit/findings";
import type { PageSpeedResult } from "../../lib/site/audit/pagespeed";
import { NEVER_LINES } from "../../lib/site/audit/view";
import { dayMonth, intlMoney, intlNumber } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

const EN = (): Tr => englishTr("site");

/** "26 Oct" — English as the screen always printed it; another language its own way (UTC). */
export function dayWord(iso: string, locale: AppLocale = "en"): string {
  if (locale !== "en") {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return dayMonth(d.toISOString().slice(0, 10), locale);
  }
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "shop.example/products/mug" — the address as a reader would say it. */
export function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

/** A page's path, or "home page". */
export function pagePath(url: string, tr: Tr = EN()): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? tr("homePage") : u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** A figure at fixed decimals: English exactly as before (toFixed), another language grouped its own way. */
function fig(n: number, decimals: number, locale: AppLocale): string {
  return locale === "en" ? n.toFixed(decimals) : intlNumber(n, decimals, locale);
}

/** A whole or as-measured figure: English's String(v), another language's own digits. */
function raw(n: number, locale: AppLocale): string {
  return locale === "en" ? String(n) : intlNumber(n, Number.isInteger(n) ? 0 : 1, locale);
}

/** What's at stake a month, in the finding's own currency, or why it wasn't computed (L-4). */
export function euroLine(e: EuroFigure, tr: Tr = EN(), locale: AppLocale = "en"): string {
  if (!e.computed) return e.why;
  const f = (m: number) =>
    locale === "en"
      ? new Intl.NumberFormat("en-IE", {
          style: "currency",
          currency: e.currency,
          maximumFractionDigits: 0,
        }).format(m / 100)
      : intlMoney(m / 100, e.currency.toUpperCase(), 0, locale);
  return tr("audit.euroRange", { low: f(e.low_minor), high: f(e.high_minor) });
}

/** The measured value of a finding, with its unit. */
export function measuredValue(f: SiteFinding, tr: Tr = EN(), locale: AppLocale = "en"): string {
  const v = f.evidence.value;
  if (v === undefined) return "-";
  switch (f.evidence.unit) {
    case "ms":
      return f.evidence.metric === "lcp_ms"
        ? tr("audit.unit.seconds", { value: fig(v / 1000, 1, locale) })
        : tr("audit.unit.ms", { value: raw(v, locale) });
    case "bytes":
      return tr("audit.unit.mb", { value: fig(v / 1_000_000, 1, locale) });
    case "clicks":
      return tr("audit.unit.clicks", { count: v });
    case "score":
      return fig(v, 2, locale);
    default:
      return f.code === "broken_link" ? tr("audit.unit.status", { code: String(v) }) : String(v);
  }
}

/** A page's weight, or a dash. */
export function weightText(
  bytes: number | null | undefined,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string {
  return bytes ? tr("audit.unit.mb", { value: fig(bytes / 1_000_000, 1, locale) }) : "-";
}

/** One page's phone or computer numbers, field first. */
export function speedCell(
  r: PageSpeedResult | null,
  tr: Tr = EN(),
  locale: AppLocale = "en",
): string {
  if (!r) return "-";
  const lcp = r.field?.lcp_ms?.p75 ?? r.lab.lcp_ms;
  const cls = r.field?.cls?.p75 ?? r.lab.cls;
  const inp = r.field?.inp_ms?.p75;
  const parts = [
    lcp !== null && lcp !== undefined
      ? tr("audit.speed.lcp", { value: fig(lcp / 1000, 1, locale) })
      : null,
    cls !== null && cls !== undefined
      ? tr("audit.speed.cls", { value: fig(cls, 2, locale) })
      : null,
    inp !== undefined
      ? tr("audit.speed.inp", { value: raw(Math.round(inp), locale) })
      : r.lab.tbt_ms !== null
        ? tr("audit.speed.tbt", { value: raw(Math.round(r.lab.tbt_ms), locale) })
        : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

/** Where a page's numbers come from. */
export function basisOf(r: PageSpeedResult | null, tr: Tr = EN()): string {
  if (!r) return tr("audit.from.notMeasured");
  if (!r.field) return tr("audit.from.labOnly");
  return r.field.origin_fallback ? tr("audit.from.fieldSite") : tr("audit.from.field");
}

const NEVER_KEYS = ["reads", "noLogin", "pagespeed"] as const;

/** One of rule 30's always-shown lines in the reader's language; any other line as the server sent it. */
export function neverLine(line: string, tr: Tr = EN()): string {
  const i = (NEVER_LINES as readonly string[]).indexOf(line);
  return i >= 0 ? tr(`audit.never.${NEVER_KEYS[i]}`) : line;
}

/** The never-lines' catalogue keys, in NEVER_LINES' order (for the words test). */
export const NEVER_LINE_KEYS = NEVER_KEYS;
