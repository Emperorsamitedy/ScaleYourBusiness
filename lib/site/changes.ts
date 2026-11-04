// Site changes — Phase 3 Session F (P3-30/31/34/35).
//
// A site change is a PROPOSAL: find this text on this page, replace it
// with that, previewed as the real before and after page (the owner's
// browser renders both, live, at desktop and phone widths — not a
// stale screenshot), applied only through the engine after approval.
//
// Rule 18 lives HERE, at the generator (P3-34): a change touching a
// money surface cannot even be PROPOSED — checkout, cart, payment and
// billing paths are refused before anything is fetched, and a target
// that sits inside a checkout/payment form on the page is refused
// after. The credential scopes exclude those surfaces too; this is
// the second, earlier wall.
//
// Wix and Squarespace (P3-35): the same proposal, the same previews —
// and step-by-step instructions for the owner's own editor instead of
// an apply path, because promising an automatic change to a platform
// that can't take one would be a lie with a progress bar.
//
// L-4c: every sentence here is the "siteWords" catalogue's English
// (lib/site/say.ts). The proposal stores the English; lib/site/localize.ts
// says it again in the reader's language from the same structure
// (siteChangeWords), and never rewrites the row.

import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { LimitLlm } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import type { FetchedPage, PageFetcher } from "./fetch";
import { livePageFetcher } from "./fetch";
import type { PlatformVerdict } from "./platform";
import { detectPlatform, editabilityLine, markerWords } from "./platform";
import { plain, siteEnglish } from "./say";

const EN = siteEnglish();

/** A refusal's catalogue key and values, so a route can say it in the reader's language. */
export interface SiteWords {
  key: string;
  values?: Record<string, string | number>;
}

export class SiteChangeError extends Error {
  readonly status: number;
  /** Set when the message is one of the "siteWords" catalogue's sentences. */
  readonly words: SiteWords | null;
  constructor(message: string, status = 422, words: SiteWords | null = null) {
    super(message);
    this.name = "SiteChangeError";
    this.status = status;
    this.words = words;
  }
}

/** A refusal in the catalogue's English, carrying its key for the route to translate. */
export function siteRefusal(
  key: string,
  values?: Record<string, string | number>,
  status = 422,
): SiteChangeError {
  return new SiteChangeError(EN(key, values), status, { key, ...(values ? { values } : {}) });
}

/** The rule every money-surface refusal names. */
const MONEY_RULE = 18;

/** Rule 18 at the URL: pages that ARE money surfaces. */
const MONEY_PATHS =
  /\/(checkout|cart|basket|payment|payments|billing|pay|order|subscribe)([/?#]|$)/i;

/** Rule 18 at the target: markers that the matched text sits inside a
 * money surface on the page. Checked over the region around the match. */
const MONEY_CONTEXT = /(checkout|payment|card[-_ ]?number|billing|cvv|cvc|stripe|paypal)/i;
const CONTEXT_RADIUS = 400;

/** How large a page can be and still carry full live previews. */
const PREVIEW_CAP = 300_000;

export interface SitePreview {
  before_html: string;
  after_html: string;
}

export interface SiteChangeDetail {
  url: string;
  find: string;
  replace: string;
  platform: PlatformVerdict;
  platform_line: string;
  site_preview: SitePreview | null;
  preview_note: string | null;
  manual_instructions: string[] | null;
  /** The fetch wall-clock at proposal time — the P3-33 baseline. */
  health_baseline_ms: number;
  manual_limits: string[];
  rationale: string;
}

/** Deterministic editor walk-throughs — the honest path for platforms
 * with no API (site-audit §5: a much better answer than silently
 * having nothing for a third of the customers). */
export function buildManualInstructions(
  platform: PlatformVerdict["platform"],
  find: string,
  replace: string,
  url: string,
  tr: Tr = EN,
): string[] {
  const shared = [
    tr("change.manual.open", { url, editor: platform === "wix" ? "Wix" : "Squarespace" }),
    tr("change.manual.find", { find }),
    tr("change.manual.replace", { replace }),
    tr("change.manual.compare"),
    tr("change.manual.publish"),
  ];
  if (platform === "wix") shared.splice(1, 0, tr("change.manual.wix"));
  if (platform === "squarespace") shared.splice(1, 0, tr("change.manual.squarespace"));
  return shared;
}

/** What a site change's proposal says, built from its structure: the stored English, or a reader's language. */
export interface SiteChangeWords {
  summary: string;
  platform_line: string;
  preview_note: string;
  manual_instructions: string[] | null;
  rationale: string;
  assumption_platform: string;
  assumption_baseline: string;
  base_case: string;
  downside_case: string;
  upside_case: string;
  breakeven_condition: string;
  if_you_change_your_mind: string;
}

const clip = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

/** Pure: every sentence of one site change, from what it is. English by default. */
export function siteChangeWords(
  change: {
    url: string;
    find: string;
    replace: string;
    platform: PlatformVerdict;
    baseline_ms: number;
  },
  tr: Tr = EN,
  locale: AppLocale = "en",
): SiteChangeWords {
  const { platform } = change;
  const manual = platform.editable === "manual";
  return {
    summary: tr("change.summary", {
      host: new URL(change.url).hostname,
      find: clip(change.find),
      replace: clip(change.replace),
    }),
    platform_line: editabilityLine(platform, tr),
    preview_note: tr("change.previewTooLarge"),
    manual_instructions: manual
      ? buildManualInstructions(platform.platform, change.find, change.replace, change.url, tr)
      : null,
    rationale: tr(manual ? "change.rationale.manual" : "change.rationale.engine"),
    assumption_platform: tr("change.assumption.platform", {
      platform: platform.platform,
      marker: markerWords(platform, tr),
    }),
    assumption_baseline: tr("change.assumption.baseline", {
      ms: plain(change.baseline_ms, locale),
    }),
    base_case: tr("change.case.base"),
    downside_case: tr("change.case.downside"),
    upside_case: tr("change.case.upside"),
    breakeven_condition: tr("change.case.breakeven"),
    if_you_change_your_mind: tr(manual ? "change.reverse.manual" : "change.reverse.engine"),
  };
}

export interface ProposeSiteChangeArgs {
  url: string;
  find: string;
  replace: string;
  fetcher?: PageFetcher;
  limitLlm?: LimitLlm;
  now?: Date;
}

/** Propose one site change. Drafts nothing, applies nothing. */
export async function proposeSiteChange(
  profileId: string,
  args: ProposeSiteChangeArgs,
): Promise<ProposalRow> {
  const find = args.find.trim();
  const replace = args.replace.trim();
  if (find === "") throw siteRefusal("error.findEmpty");
  if (replace === "") throw siteRefusal("error.replaceEmpty");
  if (find === replace) throw siteRefusal("error.nothing");

  // Rule 18, wall one: the URL itself — before any network at all.
  if (MONEY_PATHS.test(args.url)) {
    throw siteRefusal("error.moneyPath", { rule: MONEY_RULE }, 403);
  }

  const fetcher = args.fetcher ?? livePageFetcher;
  const page: FetchedPage = await fetcher(args.url);
  if (page.status >= 400) {
    throw siteRefusal("error.pageStatus", { status: String(page.status) });
  }

  const occurrences = page.html.split(find).length - 1;
  if (occurrences === 0) throw siteRefusal("error.notFound", { find });
  if (occurrences > 1) throw siteRefusal("error.notUnique", { find, count: occurrences });

  // Rule 18, wall two: the region AROUND the match.
  const at = page.html.indexOf(find);
  const context = page.html.slice(
    Math.max(0, at - CONTEXT_RADIUS),
    at + find.length + CONTEXT_RADIUS,
  );
  if (MONEY_CONTEXT.test(context)) {
    throw siteRefusal("error.moneyContext", { rule: MONEY_RULE }, 403);
  }

  const platform = detectPlatform(page.html, page.headers);
  // Literal, like the apply: "$'" in the text must never copy the rest of the page in.
  const afterHtml = page.html.replace(find, () => replace);
  const previewable = page.html.length <= PREVIEW_CAP;
  const words = siteChangeWords({
    url: page.url,
    find,
    replace,
    platform,
    baseline_ms: page.duration_ms,
  });

  const detail: SiteChangeDetail = {
    url: page.url,
    find,
    replace,
    platform,
    platform_line: words.platform_line,
    site_preview: previewable ? { before_html: page.html, after_html: afterHtml } : null,
    preview_note: previewable ? null : words.preview_note,
    manual_instructions: words.manual_instructions,
    health_baseline_ms: page.duration_ms,
    manual_limits: [],
    rationale: words.rationale,
  };

  const { limits } = await ensureHardLimits(profileId, args.limitLlm);
  const verdict = checkHardLimits(limits, "operations_change");
  detail.manual_limits = verdict.manual.map((l) => l.quote);

  const now = args.now ?? new Date();
  return createProposal({
    profile_id: profileId,
    module: "site",
    action: {
      kind: "operations_change",
      summary: words.summary,
      detail: detail as unknown as Record<string, unknown>,
    },
    scenario: {
      assumptions: [
        {
          statement: words.assumption_platform,
          value: null,
          source_field: null,
          sensitivity: "medium",
        },
        {
          statement: words.assumption_baseline,
          value: null,
          source_field: null,
          sensitivity: "low",
        },
      ],
      base_case: {
        case: "base",
        statement: words.base_case,
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement: words.downside_case,
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: words.upside_case,
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: words.breakeven_condition,
    } as never,
    reversibility: {
      level: "easy",
      if_you_change_your_mind: words.if_you_change_your_mind,
    },
    expires_at: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
}
