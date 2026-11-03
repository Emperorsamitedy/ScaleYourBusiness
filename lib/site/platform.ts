// Platform detection — Phase 3 Session F (P3-30), site-audit §5.
//
// Which platform serves a page decides everything downstream: whether
// changes can be applied programmatically (Shopify themes, WooCommerce,
// a git-hosted custom site), partially (Webflow), or not at all (Wix,
// Squarespace — a meaningful share of small-business sites, and the
// spec is blunt: never promise automatic changes to a platform that
// can't take them; give rendered before/afters and instructions
// instead, P3-35).
//
// Detection is deterministic sniffing over the fetched page — markers
// each platform ships on every page. Pure function; the network lives
// in fetch.ts behind its SSRF guard.
//
// L-4c: the marker labels and the owner-facing lines are the "siteWords"
// catalogue's English (lib/site/say.ts); a translator says them again.

import type { Tr } from "../i18n/tr";
import { siteEnglish } from "./say";

export type Platform =
  "shopify" | "woocommerce" | "wordpress" | "wix" | "squarespace" | "webflow" | "custom";

/** What the spec's editability matrix says per platform (site-audit §5). */
export type Editability = "api" | "partial" | "manual" | "unknown";

export interface PlatformVerdict {
  platform: Platform;
  editable: Editability;
  /** The marker that decided it — evidence, not vibes. */
  marker: string;
}

const EDITABILITY: Readonly<Record<Platform, Editability>> = {
  shopify: "api",
  woocommerce: "api",
  wordpress: "partial",
  webflow: "partial",
  wix: "manual",
  squarespace: "manual",
  custom: "unknown",
};

interface Marker {
  platform: Platform;
  pattern: RegExp;
  label: string;
}

const EN = siteEnglish();

/** Order matters: WooCommerce is WordPress + more, so it checks first. */
const MARKERS: readonly Marker[] = [
  {
    platform: "shopify",
    pattern: /cdn\.shopify\.com|Shopify\.theme|\/cdn\/shop\//i,
    label: EN("platform.marker.shopify"),
  },
  { platform: "woocommerce", pattern: /woocommerce/i, label: EN("platform.marker.woocommerce") },
  {
    platform: "wix",
    pattern: /static\.parastorage\.com|wix\.com|X-Wix-/i,
    label: EN("platform.marker.wix"),
  },
  {
    platform: "squarespace",
    pattern: /squarespace\.com|static1\.squarespace|This is Squarespace/i,
    label: EN("platform.marker.squarespace"),
  },
  {
    platform: "webflow",
    pattern: /assets(-global)?\.website-files\.com|data-wf-site/i,
    label: EN("platform.marker.webflow"),
  },
  {
    platform: "wordpress",
    pattern: /wp-content|wp-includes/i,
    label: EN("platform.marker.wordpress"),
  },
];

/** Detect from page HTML and response headers. */
export function detectPlatform(
  html: string,
  headers: Record<string, string> = {},
): PlatformVerdict {
  const headerBlob = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const haystack = `${headerBlob}\n${html}`;
  for (const marker of MARKERS) {
    if (marker.pattern.test(haystack)) {
      return {
        platform: marker.platform,
        editable: EDITABILITY[marker.platform],
        marker: marker.label,
      };
    }
  }
  return { platform: "custom", editable: "unknown", marker: EN("platform.marker.none") };
}

/** The owner-facing sentence for each editability class — English unless a translator is given. */
export function editabilityLine(verdict: PlatformVerdict, tr: Tr = EN): string {
  switch (verdict.editable) {
    case "api":
    case "partial":
    case "manual":
      return tr(`platform.line.${verdict.editable}`, { platform: verdict.platform });
    default:
      return tr("platform.line.unknown");
  }
}

/** The marker that decided a verdict, in the reader's language when it is one of SYB's own. */
export function markerWords(verdict: PlatformVerdict, tr: Tr): string {
  const key =
    verdict.platform === "custom" ? "platform.marker.none" : `platform.marker.${verdict.platform}`;
  return EN(key) === verdict.marker ? tr(key) : verdict.marker;
}
