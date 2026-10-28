// The site audit as /site shows it — Phase 5 Session C (P5-13). Pure types
// and the row-to-view mapping; no database import, so the browser can take
// the types (components/site/SiteScreen.tsx).

import type { PlatformVerdict } from "../platform";
import type { SiteFinding } from "./findings";
import type { FormCount, NeverFollow, PageRole } from "./links";
import type { PageSpeedResult } from "./pagespeed";
import type { BrokenLink, PurchasePath } from "./walk";

/** One page of the audit: what reading it found, and what Google measured on it. */
export interface AuditedPageView {
  url: string;
  role: PageRole;
  label: string;
  clicks: number;
  status: number | null;
  error: string | null;
  price_first_screen: boolean | null;
  forms: FormCount[] | null;
  /** Null when this page wasn't sent to PageSpeed (not a key page, or the cap). */
  mobile: PageSpeedResult | null;
  desktop: PageSpeedResult | null;
  /** Why Google couldn't measure it, when it couldn't. */
  speed_error: string | null;
}

export interface SiteAuditView {
  id: string;
  ran_at: string;
  url: string;
  platform: PlatformVerdict | null;
  pages: AuditedPageView[];
  path: PurchasePath;
  broken: BrokenLink[];
  refused: { url: string; reason: NeverFollow }[];
  findings: SiteFinding[];
  page_reads: number;
  pagespeed: {
    calls: number;
    /** False: no PAGESPEED_API_KEY, so speed wasn't measured (the keyless quota is zero). */
    keyed: boolean;
    /** Why fewer pages were measured than asked, in words. */
    note: string | null;
    weekly_cap: number;
    /** Calls for this site in the 7 days to now, this run's included. */
    used_this_week: number;
    /** When the next call is allowed, when the cap is reached; null otherwise. */
    next_from: string | null;
  };
  /** Rule 30, always shown. */
  never: readonly string[];
  /** The spec's judged layer, not built: said, not hidden. */
  not_built: string;
}

export const NEVER_LINES = [
  "Reads public pages like a visitor, through the same guarded fetcher as every other site read.",
  "Never logs in, never sends a form, never adds to a cart, never opens checkout.",
  "Asks Google's public PageSpeed Insights to load the pages; SYB runs no browser of its own.",
] as const;

export const NOT_BUILT =
  "Measured only. Judging the design from screenshots (site-audit §2, the vision layer) isn't built: no screenshot is taken and no model is asked.";

export const REFUSAL_WORDS: Readonly<Record<NeverFollow, string>> = {
  login_or_account: "a login or account page — the audit never signs in",
  cart_action: "a link that changes a cart — the audit never adds to one",
  checkout: "checkout — counted from the outside, never opened",
  external_booking: "a booking page on another company's site — counted, not read",
};
