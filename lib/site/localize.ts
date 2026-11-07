// The website screen's server-built sentences in the reader's language —
// L-4c of TASKS-LANGUAGES.md. Presentation only (rules 3 and 4): a stored
// proposal, check or audit keeps its English row exactly as written; what
// is sent to the screen is said again from the same structure with the
// request's translator (lib/i18n/request-tr.ts).
//
// The rule for every stored sentence: SYB's own English for the stored
// structure is built again, and only when it reproduces the stored text
// byte for byte is the reader's language put in its place. Anything else —
// an older wording, another system's error, the site's own text, the
// owner's words — is shown as stored. English readers get the rows as
// they are, untouched.

import { CHECKS, checkLabel } from "../blindspots/checks";
import { dayMonthYear } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import type { EuroFigure, SiteFinding } from "./audit/findings";
import { siteFindings, speedAssumed, speedFormula } from "./audit/findings";
import type { PageSpeedResult } from "./audit/pagespeed";
import type { SiteAuditView } from "./audit/view";
import type { BrokenLink, PathStep, PurchasePath, WalkResult } from "./audit/walk";
import type { SiteChangeDetail, SiteChangeWords } from "./changes";
import { SiteChangeError, siteChangeWords } from "./changes";
import { SiteFetchError } from "./fetch";
import type { Platform } from "./platform";
import { platformBrand } from "./platform";
import { parseStored, sayStored, siteEnglish } from "./say";

const EN = siteEnglish();

/* ── the checks tab ── */

/** A customer check's label: the catalogue's by code, the spec's own English for any other. */
export function checkWords(code: string, tr: Tr, locale: AppLocale): string {
  if (locale === "en" || !(code in CHECKS.checks)) return checkLabel(code);
  return EN(`check.${code}`) === checkLabel(code) ? tr(`check.${code}`) : checkLabel(code);
}

/* ── refusals ── */

/** A /api/site refusal in the reader's language; a message from elsewhere as it came. */
export function siteErrorWords(error: Error, tr: Tr, locale: AppLocale): string {
  if (locale === "en") return error.message;
  if (error instanceof SiteChangeError && error.words) {
    return tr(error.words.key, error.words.values);
  }
  if (error instanceof SiteFetchError) return sayStored(error.message, tr, locale);
  return error.message;
}

/* ── a site change's proposal ── */

type Row = Record<string, unknown>;

function asRow(v: unknown): Row | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Row) : null;
}

/** The words the screen shows for a platform: its brand, and "custom" said in the language. */
function platformWord(platform: Platform, tr: Tr): string {
  return platform === "custom" ? tr("platform.custom") : platformBrand(platform);
}

/**
 * One stored site proposal as the screen shows it, in the reader's language.
 * Adds `platform_word` and `editable_word` to the detail for the screen's
 * header line; everything else keeps its shape.
 */
export function localizeSiteProposal<T extends Row>(row: T, tr: Tr, locale: AppLocale): T {
  const action = asRow(row["action"]);
  const detail = asRow(action?.["detail"]) as (SiteChangeDetail & Row) | null;
  if (!action || !detail || !detail.platform) return row;
  const words = {
    platform_word: platformWord(detail.platform.platform, tr),
    editable_word: tr(`platform.editable.${detail.platform.editable}`),
  };
  if (locale === "en") {
    return {
      ...row,
      action: {
        ...action,
        detail: {
          ...detail,
          platform_word: platformWord(detail.platform.platform, tr),
          editable_word: detail.platform.editable,
        },
      },
    };
  }
  let en: SiteChangeWords;
  let local: SiteChangeWords;
  try {
    const change = {
      url: detail.url,
      find: detail.find,
      replace: detail.replace,
      platform: detail.platform,
      baseline_ms: detail.health_baseline_ms,
    };
    en = siteChangeWords(change);
    local = siteChangeWords(change, tr, locale);
  } catch {
    return row;
  }
  const say = (stored: unknown, key: keyof SiteChangeWords): unknown =>
    typeof stored === "string" && stored === en[key] ? local[key] : stored;
  const steps =
    Array.isArray(detail.manual_instructions) &&
    JSON.stringify(detail.manual_instructions) === JSON.stringify(en.manual_instructions)
      ? local.manual_instructions
      : detail.manual_instructions;

  const scenario = asRow(row["scenario"]);
  const statement = (c: unknown, key: keyof SiteChangeWords) => {
    const r = asRow(c);
    return r ? { ...r, statement: say(r["statement"], key) } : c;
  };
  const localScenario = scenario
    ? {
        ...scenario,
        assumptions: Array.isArray(scenario["assumptions"])
          ? (scenario["assumptions"] as unknown[]).map((a) => {
              const r = asRow(a);
              if (!r) return a;
              const s = r["statement"];
              return {
                ...r,
                statement:
                  s === en.assumption_platform
                    ? local.assumption_platform
                    : s === en.assumption_baseline
                      ? local.assumption_baseline
                      : s,
              };
            })
          : scenario["assumptions"],
        base_case: statement(scenario["base_case"], "base_case"),
        downside_case: statement(scenario["downside_case"], "downside_case"),
        upside_case: statement(scenario["upside_case"], "upside_case"),
        breakeven_condition: say(scenario["breakeven_condition"], "breakeven_condition"),
      }
    : row["scenario"];
  const reversibility = asRow(row["reversibility"]);

  return {
    ...row,
    action: {
      ...action,
      summary: say(action["summary"], "summary"),
      detail: {
        ...detail,
        ...words,
        platform_line: say(detail.platform_line, "platform_line"),
        preview_note: say(detail.preview_note, "preview_note"),
        manual_instructions: steps,
        rationale: say(detail.rationale, "rationale"),
      },
    },
    scenario: localScenario,
    reversibility: reversibility
      ? {
          ...reversibility,
          if_you_change_your_mind: say(
            reversibility["if_you_change_your_mind"],
            "if_you_change_your_mind",
          ),
        }
      : row["reversibility"],
  };
}

/* ── the measured audit ── */

const EN_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** A finding's € line, or why it isn't there, in the reader's language. */
export function localizeEuro(euro: EuroFigure, tr: Tr, locale: AppLocale): EuroFigure {
  if (locale === "en") return euro;
  if (!euro.computed) return { ...euro, why: sayStored(euro.why, tr, locale) };
  const english = speedAssumed();
  const local = speedAssumed(tr, locale);
  const assumed = euro.assumed.map((a, i) => (a === english[i] ? (local[i] ?? a) : a));
  let { formula, window } = euro;
  const inputs = euro.inputs;
  if (inputs) {
    if (speedFormula(inputs, euro.currency) === formula) {
      formula = speedFormula(inputs, euro.currency, tr, locale);
    }
    if (inputs.as_of) {
      const key = `euro.window.${inputs.basis}`;
      const day = new Date(`${inputs.as_of.slice(0, 10)}T00:00:00Z`);
      if (EN(key, { day: EN_DAY.format(day) }) === window) {
        window = tr(key, { day: dayMonthYear(inputs.as_of, locale) });
      }
    }
  }
  return { ...euro, formula, window, assumed };
}

/** A path step's label: SYB's own words in the language; a link's text as the site wrote it. */
function stepWords(step: PathStep, tr: Tr): PathStep {
  if (step.kind === "page" && step.label === EN("walk.home")) {
    return { ...step, label: tr("walk.home") };
  }
  if (step.kind === "control" && step.label === EN("walk.addToCart")) {
    return { ...step, label: tr("walk.addToCart") };
  }
  if (step.kind === "entry") {
    if (step.label === EN("walk.checkout")) return { ...step, label: tr("walk.checkout") };
    const external = parseStored(step.label, ["walk.external"]);
    if (external) {
      const text = external.values["text"] ?? "";
      return {
        ...step,
        label: tr("walk.external", {
          text: text === EN("walk.book") ? tr("walk.book") : text,
          host: external.values["host"] ?? "",
        }),
      };
    }
  }
  return step;
}

function walkOf(view: SiteAuditView, path: PurchasePath, broken: BrokenLink[]): WalkResult {
  return {
    home: view.url,
    pages: view.pages.map((p) => ({
      url: p.url,
      role: p.role,
      clicks: p.clicks,
      from: null,
      label: p.label,
      status: p.status,
      error: p.error,
      price_first_screen: p.price_first_screen,
      forms: p.forms,
      add_to_cart: false,
      checkout_control: false,
    })),
    path,
    broken,
    refused: view.refused,
    reads: view.page_reads,
    platform: view.platform,
  };
}

const byId = (findings: SiteFinding[]) => new Map(findings.map((f) => [f.id, f]));

/**
 * A stored audit as /site shows it, in the reader's language: the findings
 * worded again from the stored measurements (and kept as stored where SYB's
 * English for them no longer matches), the path's steps and notes, the
 * broken links' reasons, PageSpeed's note and errors.
 */
export function localizeSiteAudit(view: SiteAuditView, tr: Tr, locale: AppLocale): SiteAuditView {
  if (locale === "en") return view;
  const say = (s: string) => sayStored(s, tr, locale);
  const path: PurchasePath = {
    ...view.path,
    steps: view.path.steps.map((s) => stepWords(s, tr)),
    notes: view.path.notes.map(say),
  };
  const broken = view.broken.map((b) => ({ ...b, reason: say(b.reason) }));
  const speed = view.pages
    .flatMap((p) => [p.mobile, p.desktop])
    .filter((r): r is PageSpeedResult => r !== null);
  let english = new Map<string, SiteFinding>();
  let local = new Map<string, SiteFinding>();
  try {
    const input = { speed, figures: null, measured_at: view.ran_at };
    english = byId(siteFindings({ ...input, walk: walkOf(view, view.path, view.broken) }));
    local = byId(siteFindings({ ...input, walk: walkOf(view, path, broken) }, tr, locale));
  } catch {
    // An audit stored in a shape this code can't read again keeps its English.
  }
  const findings = view.findings.map((f) => {
    const en = english.get(f.id);
    const loc = local.get(f.id);
    const pick = (stored: string, enText?: string, locText?: string) =>
      enText !== undefined && locText !== undefined && enText === stored ? locText : stored;
    return {
      ...f,
      title: { en: pick(f.title.en, en?.title.en, loc?.title.en) },
      detail: { en: pick(f.detail.en, en?.detail.en, loc?.detail.en) },
      threshold: pick(f.threshold, en?.threshold, loc?.threshold),
      euro: localizeEuro(f.euro, tr, locale),
    };
  });
  return {
    ...view,
    path,
    broken,
    findings,
    pages: view.pages.map((p) => ({
      ...p,
      error: p.error === null ? null : say(p.error),
      speed_error: p.speed_error === null ? null : say(p.speed_error),
    })),
    pagespeed: {
      ...view.pagespeed,
      note: view.pagespeed.note === null ? null : say(view.pagespeed.note),
    },
  };
}

/** The last failed run's reason in the reader's language. */
export function localizeFailure(
  failure: { at: string; reason: string } | null,
  tr: Tr,
  locale: AppLocale,
): { at: string; reason: string } | null {
  return failure ? { ...failure, reason: sayStored(failure.reason, tr, locale) } : null;
}
