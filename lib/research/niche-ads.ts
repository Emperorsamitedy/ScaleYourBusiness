// What the niche's ads say — P3-50's analysis. Deterministic, no model.
//
// The Ad Library publishes no performance figures for ordinary business
// ads: no spend, no reach, no results. So "the ads that work" is read from
// the two things an advertiser reveals by their own behaviour:
//
//   · RUNNING TIME. Nobody keeps paying for an ad that loses money for
//     months. Days from the first delivery to the last (or to the read, if
//     it is still running).
//   · VERSIONS. An advertiser who keeps several near-identical versions of
//     one ad alive is testing and keeping a concept, not trying one once.
//     Near-identical = the same page, and the same opening line or most of
//     the same words (word-set overlap at VERSION_RULES.same_words).
//
// The rank is staying power = days × (1 + ¼ × (versions − 1)), versions
// capped at five so one advertiser's twenty clones don't drown the rest.
// It is a proxy, and the screen calls it one. The arithmetic travels with
// every row.
//
// From each ad: its format (video / image / several cards or versions, as
// far as the Library's fields allow), its hook (the first line), and its
// offer and call to action where a plain pattern finds them — null when
// none does, never a guess.

import type { AdFormat, LibraryAd } from "./ad-library";
import { libraryUrl } from "./ad-library";

export const VERSION_RULES = {
  /** Word-set overlap at or above which two ads of one page are versions of one ad. */
  same_words: 0.7,
  /** Versions counted toward the rank; more add nothing. */
  max_versions_counted: 5,
  /** Each version beyond the first adds this share of the running time. */
  per_version: 0.25,
  /** A hook longer than this is cut at its first sentence, or at a word. */
  max_hook_chars: 140,
  /** An offer or CTA clause is quoted up to this many characters. */
  max_clause_chars: 100,
} as const;

const DAY_MS = 86_400_000;

/** Pure: days an ad ran, the first day counted, up to `asOf` while it still runs. */
export function runningDays(ad: Pick<LibraryAd, "started" | "stopped">, asOf: string): number {
  const end = ad.stopped && ad.stopped < asOf ? ad.stopped : asOf;
  const days =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${ad.started}T00:00:00Z`)) / DAY_MS) +
    1;
  return Math.max(1, days);
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}%€£$]+/u)
    .filter((w) => w !== "");
}

/** Pure: |A ∩ B| ÷ |A ∪ B| over the two texts' word sets. Two empty texts are not alike. */
export function wordOverlap(a: string, b: string): number {
  const A = new Set(wordsOf(a));
  const B = new Set(wordsOf(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** Pure: the ad's opening line — its hook — trimmed to a sentence when long. */
export function hookOf(body: string): string | null {
  const first =
    body
      .split(/\r?\n/)
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  if (first === "") return null;
  if (first.length <= VERSION_RULES.max_hook_chars) return first;
  const sentence = /^(.{20,}?[.!?])(\s|$)/u.exec(first)?.[1];
  if (sentence && sentence.length <= VERSION_RULES.max_hook_chars) return sentence;
  const cut = first.slice(0, VERSION_RULES.max_hook_chars - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trimEnd()}…`;
}

const normHook = (body: string) => wordsOf(hookOf(body) ?? "").join(" ");

/** What reads as an offer: a price, a percentage, free delivery, a bundle, a sale. */
const OFFER_PATTERNS: readonly RegExp[] = [
  /\b\d{1,3}\s?%\s?(off|discount)\b/iu,
  /\b(save|from|only|just)\s?[€£$]\s?\d/iu,
  /[€£$]\s?\d+(?:[.,]\d+)?/u,
  /\b\d+(?:[.,]\d+)?\s?(eur|euro|euros|ft|huf|gbp|usd)\b/iu,
  /\bfree\s+(eu\s+|uk\s+|next[- ]day\s+)?(shipping|delivery|returns|gift|trial|consultation|sample|class|lesson|wrapping)\b/iu,
  /\b(buy|get)\s+\d+\s+(get|for)\b/iu,
  /\b\d+\s+for\s+[€£$]?\d/iu,
  /\b(bogo|sale|seconds|voucher|vouchers|coupon|promo code|discount)\b/iu,
];

/** Calls to action, in the words an ad uses. Matched case-insensitively; the last one wins. */
const CTA_PHRASES: readonly string[] = [
  "shop now",
  "shop the",
  "buy now",
  "order now",
  "order yours",
  "order today",
  "book now",
  "book a",
  "book your",
  "reserve",
  "sign up",
  "learn more",
  "find out more",
  "see more",
  "discover",
  "get yours",
  "get started",
  "call us",
  "call now",
  "visit us",
  "message us",
  "send us a message",
  "dm us",
  "link in bio",
  "try it",
  "apply now",
  "download",
];

function clauses(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\r?\n/u)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

const clip = (c: string) =>
  c.length > VERSION_RULES.max_clause_chars
    ? `${c.slice(0, VERSION_RULES.max_clause_chars - 1).trimEnd()}…`
    : c;

/** Pure: the first clause of the ad that reads as an offer, quoted; null when none does. */
export function offerOf(ad: Pick<LibraryAd, "body" | "title">): string | null {
  for (const c of [...clauses(ad.body), ...(ad.title ? [ad.title] : [])]) {
    if (OFFER_PATTERNS.some((p) => p.test(c))) return clip(c);
  }
  return null;
}

/** Pure: the ad's call to action — the last CTA phrase it uses, capitalised; null when none. */
export function ctaOf(ad: Pick<LibraryAd, "body" | "title">): string | null {
  const text = `${ad.body}\n${ad.title ?? ""}`.toLowerCase();
  let best: { at: number; phrase: string } | null = null;
  for (const phrase of CTA_PHRASES) {
    const re = new RegExp(`(^|[^\\p{L}])${phrase.replace(/ /g, "\\s+")}(?=$|[^\\p{L}])`, "giu");
    for (const m of text.matchAll(re)) {
      const at = (m.index ?? 0) + (m[1]?.length ?? 0);
      if (!best || at >= best.at) best = { at, phrase };
    }
  }
  if (!best) return null;
  return best.phrase.charAt(0).toUpperCase() + best.phrase.slice(1);
}

export const FORMAT_WORD: Readonly<Record<AdFormat, string>> = {
  video: "video",
  image: "image",
  multi: "several cards or versions",
};

/** One ad concept: an ad and its near-identical versions, on one page. */
export interface NicheAdGroup {
  key: string;
  page_id: string;
  page_name: string;
  /** Set when the page belongs to a competitor the owner listed. */
  competitor_id: string | null;
  /** Every ad in the group, the longest-running first. */
  ad_ids: string[];
  /** The longest-running ad: the one quoted and linked. */
  lead_ad_id: string;
  library_url: string;
  versions: number;
  running_days: number;
  /** Still running on the day of the read. */
  active: boolean;
  started: string;
  format: AdFormat;
  platforms: string[];
  hook: string | null;
  offer: string | null;
  cta: string | null;
  /** Staying power: the proxy the rank uses. */
  score: number;
  arithmetic: string;
}

function versionsOf(ads: readonly LibraryAd[]): number {
  return ads.reduce((n, ad) => n + Math.max(1, ad.bodies), 0);
}

/** Pure: the staying-power score and its arithmetic, in words. */
export function stayingPower(
  days: number,
  versions: number,
): { score: number; arithmetic: string } {
  const counted = Math.min(Math.max(versions, 1), VERSION_RULES.max_versions_counted);
  const factor = 1 + VERSION_RULES.per_version * (counted - 1);
  const score = Math.round(days * factor * 10) / 10;
  return {
    score,
    arithmetic: `${days} days × (1 + ¼ × (${counted} version${counted === 1 ? "" : "s"} − 1)) = ${score}`,
  };
}

/** Pure: an ad's versions, grouped. Same page, and the same hook or most of the same words. */
export function groupVersions(ads: readonly LibraryAd[]): LibraryAd[][] {
  const groups: LibraryAd[][] = [];
  const byId = new Map<string, LibraryAd>();
  for (const ad of ads) if (!byId.has(ad.id)) byId.set(ad.id, ad);
  for (const ad of byId.values()) {
    const home = groups.find(
      (g) =>
        g[0]!.page_id === ad.page_id &&
        g.some(
          (other) =>
            (normHook(other.body) !== "" && normHook(other.body) === normHook(ad.body)) ||
            wordOverlap(other.body, ad.body) >= VERSION_RULES.same_words,
        ),
    );
    if (home) home.push(ad);
    else groups.push([ad]);
  }
  return groups;
}

/**
 * Pure: the niche's ads, grouped into concepts and ranked by staying
 * power, strongest first. `competitorOf` says which listed competitor a
 * page belongs to, when it does.
 */
export function rankNicheAds(
  ads: readonly LibraryAd[],
  asOf: string,
  opts: { limit?: number } = {},
): NicheAdGroup[] {
  const ranked = groupVersions(ads).map((group) => {
    const sorted = [...group].sort(
      (a, b) => runningDays(b, asOf) - runningDays(a, asOf) || a.id.localeCompare(b.id),
    );
    const lead = sorted[0]!;
    const days = runningDays(lead, asOf);
    const versions = versionsOf(group);
    const { score, arithmetic } = stayingPower(days, versions);
    const formats = new Map<AdFormat, number>();
    for (const ad of group) formats.set(ad.format, (formats.get(ad.format) ?? 0) + 1);
    const format = [...formats.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const competitor = group.find((ad) => ad.found_by.kind === "competitor")?.found_by;
    return {
      key: `${lead.page_id}:${lead.id}`,
      page_id: lead.page_id,
      page_name: lead.page_name,
      competitor_id:
        competitor && competitor.kind === "competitor" ? competitor.competitor_id : null,
      ad_ids: sorted.map((ad) => ad.id),
      lead_ad_id: lead.id,
      library_url: libraryUrl(lead.id),
      versions,
      running_days: days,
      active: group.some((ad) => ad.stopped === null || ad.stopped >= asOf),
      started: group.map((ad) => ad.started).sort()[0]!,
      format,
      platforms: [...new Set(group.flatMap((ad) => ad.platforms))].sort(),
      hook: hookOf(lead.body),
      offer: offerOf(lead),
      cta: ctaOf(lead),
      score,
      arithmetic,
    } satisfies NicheAdGroup;
  });
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.running_days - a.running_days ||
      b.versions - a.versions ||
      a.page_name.localeCompare(b.page_name),
  );
  return opts.limit === undefined ? ranked : ranked.slice(0, opts.limit);
}
