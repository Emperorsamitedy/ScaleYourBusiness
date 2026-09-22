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

import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { LimitLlm } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";
import type { FetchedPage, PageFetcher } from "./fetch";
import { livePageFetcher } from "./fetch";
import type { PlatformVerdict } from "./platform";
import { detectPlatform, editabilityLine } from "./platform";

export class SiteChangeError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "SiteChangeError";
    this.status = status;
  }
}

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
): string[] {
  const shared = [
    `Open ${url} in your ${platform === "wix" ? "Wix" : "Squarespace"} editor.`,
    `Find the text: “${find}”`,
    `Replace it with: “${replace}”`,
    "Use the editor's preview to compare against the before/after shown here.",
    "Publish when it matches the after.",
  ];
  if (platform === "wix") {
    shared.splice(1, 0, "In the editor, click the text element itself — Wix edits in place.");
  }
  if (platform === "squarespace") {
    shared.splice(1, 0, "Edit the page section containing the text (hover → Edit).");
  }
  return shared;
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
  if (find === "") throw new SiteChangeError("say what text to find");
  if (replace === "") throw new SiteChangeError("say what it should become");
  if (find === replace) throw new SiteChangeError("that changes nothing");

  // Rule 18, wall one: the URL itself — before any network at all.
  if (MONEY_PATHS.test(args.url)) {
    throw new SiteChangeError(
      "that page is a money surface — checkout, cart, payment and billing pages are untouchable at any approval level (rule 18)",
      403,
    );
  }

  const fetcher = args.fetcher ?? livePageFetcher;
  const page: FetchedPage = await fetcher(args.url);
  if (page.status >= 400) {
    throw new SiteChangeError(`the page answered ${page.status} — nothing to change there`);
  }

  const occurrences = page.html.split(find).length - 1;
  if (occurrences === 0) {
    throw new SiteChangeError(
      `I can't find “${find}” on that page — copy it exactly as it appears`,
    );
  }
  if (occurrences > 1) {
    throw new SiteChangeError(
      `“${find}” appears ${occurrences} times on that page — include enough surrounding text to make it unique`,
    );
  }

  // Rule 18, wall two: the region AROUND the match.
  const at = page.html.indexOf(find);
  const context = page.html.slice(
    Math.max(0, at - CONTEXT_RADIUS),
    at + find.length + CONTEXT_RADIUS,
  );
  if (MONEY_CONTEXT.test(context)) {
    throw new SiteChangeError(
      "that text sits inside a checkout or payment area of the page — money surfaces are untouchable, so this cannot even be proposed (rule 18)",
      403,
    );
  }

  const platform = detectPlatform(page.html, page.headers);
  const afterHtml = page.html.replace(find, replace);
  const previewable = page.html.length <= PREVIEW_CAP;

  const detail: SiteChangeDetail = {
    url: page.url,
    find,
    replace,
    platform,
    platform_line: editabilityLine(platform),
    site_preview: previewable ? { before_html: page.html, after_html: afterHtml } : null,
    preview_note: previewable
      ? null
      : "the page is too large to carry a live preview — the diff above is exact, the render is not shown",
    manual_instructions:
      platform.editable === "manual"
        ? buildManualInstructions(platform.platform, find, replace, page.url)
        : null,
    health_baseline_ms: page.duration_ms,
    manual_limits: [],
    rationale:
      platform.editable === "manual"
        ? "Your platform can't be edited programmatically, so approving this gives you the exact rendered change and the steps — nothing is applied for you."
        : "Approving queues the change; applying goes through the engine with the page's previous state stored forever, one click from restored.",
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
      summary: `On ${new URL(page.url).hostname}: “${find.length > 60 ? `${find.slice(0, 57)}…` : find}” → “${replace.length > 60 ? `${replace.slice(0, 57)}…` : replace}”`,
      detail: detail as unknown as Record<string, unknown>,
    },
    scenario: {
      assumptions: [
        {
          statement: `The page is served by ${platform.platform} (${platform.marker})`,
          value: null,
          source_field: null,
          sensitivity: "medium",
        },
        {
          statement: `Baseline load ${page.duration_ms}ms at proposal time — the auto-rollback reference`,
          value: null,
          source_field: null,
          sensitivity: "low",
        },
      ],
      base_case: {
        case: "base",
        statement: "The page says the new thing; nothing else about it changes.",
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement:
          "The page errors or slows hard after the change — it rolls back automatically and you see why.",
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement: "The readback can compare the weeks either side, once measurement is connected.",
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: "no spend — one line of copy",
    } as never,
    reversibility: {
      level: "easy",
      if_you_change_your_mind:
        platform.editable === "manual"
          ? "You change it back in your editor — the before render here is the reference."
          : "One click: the page's previous state is stored permanently, not for a window.",
    },
    expires_at: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
  });
}
