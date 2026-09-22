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

/** Order matters: WooCommerce is WordPress + more, so it checks first. */
const MARKERS: readonly Marker[] = [
  {
    platform: "shopify",
    pattern: /cdn\.shopify\.com|Shopify\.theme|\/cdn\/shop\//i,
    label: "Shopify CDN/theme object",
  },
  { platform: "woocommerce", pattern: /woocommerce/i, label: "WooCommerce assets" },
  {
    platform: "wix",
    pattern: /static\.parastorage\.com|wix\.com|X-Wix-/i,
    label: "Wix static assets",
  },
  {
    platform: "squarespace",
    pattern: /squarespace\.com|static1\.squarespace|This is Squarespace/i,
    label: "Squarespace assets",
  },
  {
    platform: "webflow",
    pattern: /assets(-global)?\.website-files\.com|data-wf-site/i,
    label: "Webflow site attributes",
  },
  { platform: "wordpress", pattern: /wp-content|wp-includes/i, label: "WordPress content paths" },
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
  return { platform: "custom", editable: "unknown", marker: "no platform markers found" };
}

/** The owner-facing sentence for each editability class. */
export function editabilityLine(verdict: PlatformVerdict): string {
  switch (verdict.editable) {
    case "api":
      return `${verdict.platform} — changes can be applied for you once its write access is connected (its own consent, Session D gate).`;
    case "partial":
      return `${verdict.platform} — some elements can be changed programmatically, not all; anything beyond that comes as instructions.`;
    case "manual":
      return `${verdict.platform} can't be edited programmatically — you'll get the exact change rendered before/after, plus step-by-step instructions for your editor. That's the honest version of this feature for your platform.`;
    default:
      return "I can't tell what serves this site — I'll show you the change and the diff, and applying it stays manual until I can.";
  }
}
