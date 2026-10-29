// Reading a forwarded review notification — idea 45 (I-45.1). Pure.
//
// The formats are data (specs/review-notifications-v1.json, rule 4); this
// file only applies them. Nothing here calls a model: a recognised sender's
// email that doesn't parse is the inbound path's business (the capped
// fallback in ./fallback.ts), and mail from anyone else never gets this far.
//
//   1. Who really sent it. An auto-forward keeps the platform's own From
//      line; a manual forward puts the owner on the From line and the
//      platform in a "Forwarded message" block. Both are read here.
//   2. Is it a review notification? Its original sender is on a platform's
//      list, or on its domain with a review word in the subject, and the
//      subject isn't a sign-in, security or billing email.
//   3. What it says: the stars, the reviewer as shown, the review's words,
//      the link where it lives and the date, every one bounded.
//
// A review's words are content, never instructions (rule 24): they are
// only ever stored and shown as text.

import { createHash } from "node:crypto";
import spec from "../../specs/review-notifications-v1.json";

export const REVIEW_PLATFORMS = ["google", "trustpilot", "booksy", "fresha"] as const;
export type ReviewPlatform = (typeof REVIEW_PLATFORMS)[number];
/** What a pasted review from somewhere else is filed under. */
export type ReviewPlatformKey = ReviewPlatform | "other";

export interface PlatformSpec {
  label: string;
  verified: boolean;
  found: string;
  sender_addresses: string[];
  sender_domains: string[];
  review_words: string[];
  link_hosts: string[];
}

export interface NotificationSpec {
  version: string;
  researched: string;
  note: string;
  platforms: Record<ReviewPlatform, PlatformSpec>;
  subject_exclude: string[];
  patterns: {
    stars: string[];
    star_glyphs: string;
    reviewer: string[];
    review_date: string[];
    stop: string[];
    skip: string[];
  };
  forwarded_markers: string[];
  flag_words: string[];
}

export const NOTIFICATIONS = spec as NotificationSpec;

export const PLATFORM_LABELS: Readonly<Record<ReviewPlatformKey, string>> = {
  google: NOTIFICATIONS.platforms.google.label,
  trustpilot: NOTIFICATIONS.platforms.trustpilot.label,
  booksy: NOTIFICATIONS.platforms.booksy.label,
  fresha: NOTIFICATIONS.platforms.fresha.label,
  other: "Another site",
};

export function isPlatformKey(v: unknown): v is ReviewPlatformKey {
  return v === "other" || (REVIEW_PLATFORMS as readonly unknown[]).includes(v);
}

/** Bounds on what a review row keeps. */
export const REVIEW_LIMITS = {
  reviewer_chars: 120,
  text_chars: 4_000,
  link_chars: 500,
  /** The body a parser (or the fallback) reads: a notification is short. */
  body_chars: 12_000,
} as const;

const re = (source: string) => new RegExp(source, "i");
const STARS_RES = NOTIFICATIONS.patterns.stars.map(re);
const GLYPHS_RE = re(NOTIFICATIONS.patterns.star_glyphs);
const REVIEWER_RES = NOTIFICATIONS.patterns.reviewer.map(re);
const DATE_RES = NOTIFICATIONS.patterns.review_date.map(re);
const STOP_RES = NOTIFICATIONS.patterns.stop.map(re);
const SKIP_RES = NOTIFICATIONS.patterns.skip.map(re);
const FORWARD_RES = NOTIFICATIONS.forwarded_markers.map(re);
const WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/* ── 1. who really sent it ── */

const ADDRESS_IN = /<?([^\s<>()",;:@]+@[^\s<>()",;:@]+\.[^\s<>()",;:@]+)>?/;

function addressIn(line: string): string | null {
  const m = ADDRESS_IN.exec(line);
  return m ? m[1]!.toLowerCase().replace(/[.>]+$/, "") : null;
}

/** The platform an address belongs to, by its listed addresses and domains. */
export function platformOfAddress(
  address: string,
): { platform: ReviewPlatform; listed: boolean } | null {
  const a = address.trim().toLowerCase();
  const domain = a.split("@")[1] ?? "";
  for (const p of REVIEW_PLATFORMS) {
    const s = NOTIFICATIONS.platforms[p];
    if (s.sender_addresses.includes(a)) return { platform: p, listed: true };
  }
  for (const p of REVIEW_PLATFORMS) {
    const s = NOTIFICATIONS.platforms[p];
    if (s.sender_domains.some((d) => domain === d || domain.endsWith(`.${d}`))) {
      return { platform: p, listed: false };
    }
  }
  return null;
}

/** A line with any leading quote markers ("> ", ">>") taken off. */
const unquote = (line: string) => line.replace(/^\s*(?:>\s?)+/, "");

export interface OriginalMail {
  platform: ReviewPlatform;
  /** Whether the sender address itself is listed, rather than only its domain. */
  listed: boolean;
  subject: string;
  /** The original notification's body, unquoted, without the forwarding block's header lines. */
  body: string;
  /** The forwarded block's Date line, when it had one. */
  date_line: string | null;
  forwarded: boolean;
}

/**
 * The platform's own email inside what arrived: the outer From when it is
 * a platform's (an auto-forward), else the first forwarded-message block
 * whose From is a platform's (a manual forward). Null when neither is.
 */
export function originalMail(email: {
  from: string;
  subject: string;
  text: string;
}): OriginalMail | null {
  const text = email.text.slice(0, REVIEW_LIMITS.body_chars).replace(/\r\n?/g, "\n");
  const outer = platformOfAddress(email.from);
  if (outer) {
    return {
      ...outer,
      subject: squash(email.subject),
      body: text,
      date_line: null,
      forwarded: false,
    };
  }
  const lines = text.split("\n").map(unquote);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:from|von|de|da|od|feladó)\s*:\s*(.+)$/i.exec(lines[i]!);
    if (!m) continue;
    // A From line counts only inside a forwarded block: a marker just above it,
    // or the start of the body (Outlook puts the header block first).
    const above = lines.slice(Math.max(0, i - 3), i).map((l) => l.trim());
    const marked =
      above.some((l) => FORWARD_RES.some((r) => r.test(l))) ||
      lines.slice(0, i).every((l) => l.trim() === "");
    if (!marked) continue;
    const address = addressIn(m[1]!);
    const platform = address ? platformOfAddress(address) : null;
    if (!platform) continue;
    let subject = "";
    let dateLine: string | null = null;
    let j = i + 1;
    for (; j < lines.length && j < i + 8; j++) {
      const h = /^\s*(subject|date|sent|to|cc|tárgy|betreff|dátum|datum|an)\s*:\s*(.*)$/i.exec(
        lines[j]!,
      );
      if (!h) break;
      const name = h[1]!.toLowerCase();
      if (["subject", "tárgy", "betreff"].includes(name)) subject = squash(h[2]!);
      if (["date", "sent", "dátum", "datum"].includes(name)) dateLine = squash(h[2]!);
    }
    return {
      ...platform,
      subject:
        subject || squash(email.subject.replace(/^\s*(?:fwd?|wg|tr|továbbítás)\s*:\s*/i, "")),
      body: lines.slice(j).join("\n").trim(),
      date_line: dateLine,
      forwarded: true,
    };
  }
  return null;
}

/* ── 2. is it a review notification? ── */

/**
 * A listed sender always counts; a domain-only sender only with a review
 * word in the subject. Either way, a subject naming sign-in, security,
 * billing and the like is never a review (the same company sends those).
 */
export function isReviewNotification(mail: OriginalMail): boolean {
  const subject = mail.subject.toLowerCase();
  if (NOTIFICATIONS.subject_exclude.some((w) => subject.includes(w))) return false;
  if (mail.listed) return true;
  return NOTIFICATIONS.platforms[mail.platform].review_words.some((w) => subject.includes(w));
}

/* ── 3. what it says ── */

export interface ParsedReview {
  stars: number | null;
  reviewer: string | null;
  text: string | null;
  link: string | null;
  /** An ISO instant from the notification, when it stated a usable date. */
  reviewed_at: string | null;
}

function starsIn(line: string): number | null {
  const t = line.trim();
  if (t !== "" && GLYPHS_RE.test(t) && /[★⭐]/.test(t)) {
    const full = [...t].filter((c) => c === "★" || c === "⭐").length;
    const all = [...t].filter((c) => "★☆✩✭✮⭐".includes(c)).length;
    // A run of five glyphs: the filled ones are the stars. Five or fewer filled alone also reads.
    if (full >= 1 && full <= 5 && all <= 5) return full;
    return null;
  }
  for (const r of STARS_RES) {
    const m = r.exec(t);
    if (!m) continue;
    const raw = m[1]!.toLowerCase();
    const n = WORDS[raw] ?? Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
  }
  return null;
}

/** An https link on one of the platform's hosts, bounded; null for anything else. */
export function platformLink(raw: string, platform: ReviewPlatformKey): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/[)>\].,]+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const href = url.toString();
  if (href.length > REVIEW_LIMITS.link_chars) return null;
  if (platform === "other") return href;
  const host = url.hostname.toLowerCase();
  const hosts = NOTIFICATIONS.platforms[platform].link_hosts;
  if (!hosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  if (/unsubscribe|notification|settings|preferences|privacy|policies|help/i.test(url.pathname)) {
    return null;
  }
  return href;
}

function linkIn(body: string, platform: ReviewPlatform): string | null {
  const urls = body.match(/https:\/\/[^\s<>"')\]]+/g) ?? [];
  const ok = urls.map((u) => platformLink(u, platform)).filter((u): u is string => u !== null);
  // A link that names a review beats the first one on the right host.
  return ok.find((u) => /review/i.test(u)) ?? ok[0] ?? null;
}

/** "Tue, Oct 27, 2026 at 2:03 PM" and friends → ISO, or null. Never in the future. */
export function parseLooseDate(raw: string | null, now: Date): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+at\s+/i, " ").replace(/\s*\(.*\)\s*$/, "");
  const ms = Date.parse(cleaned);
  if (Number.isNaN(ms) || ms > now.getTime() + 86_400_000 || ms < Date.UTC(2000, 0, 1)) {
    return null;
  }
  return new Date(ms).toISOString();
}

const bounded = (s: string | null, max: number): string | null => {
  if (s === null) return null;
  const t = s
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, "")
    .trim();
  return t === "" ? null : t.slice(0, max);
};

/**
 * Read the notification's body. Stars are the one thing it must yield to
 * count as parsed; the rest is best effort, and a missing piece is null,
 * never guessed.
 */
export function parseNotification(mail: OriginalMail, now: Date): ParsedReview {
  const lines = mail.body
    .split("\n")
    .map((l) => l.split(String.fromCharCode(160)).join(" ").trim())
    .filter((l, i, all) => !(l === "" && all[i - 1] === ""));
  let stars: number | null = starsIn(mail.subject);
  let reviewer: string | null = null;
  let reviewedAt = parseLooseDate(mail.date_line, now);
  for (const r of REVIEWER_RES) {
    const m = r.exec(mail.subject);
    if (m) {
      reviewer = m[1]!;
      break;
    }
  }

  let ratingLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (stars === null || ratingLine === -1) {
      const s = starsIn(line);
      if (s !== null) {
        if (stars === null) stars = s;
        if (ratingLine === -1) ratingLine = i;
      }
    }
    if (reviewer === null) {
      for (const r of REVIEWER_RES) {
        const m = r.exec(line);
        if (m) {
          reviewer = m[1]!;
          break;
        }
      }
    }
    if (reviewedAt === null) {
      for (const r of DATE_RES) {
        const m = r.exec(line);
        if (m) reviewedAt = parseLooseDate(m[1]!, now);
      }
    }
  }

  // The words: what follows the rating line (or the reviewer's line), up to
  // the first button, footer or link, leaving out the lines read above.
  let start = ratingLine;
  if (start === -1 && reviewer !== null) {
    start = lines.findIndex((l) => l.includes(reviewer!));
  }
  const words: string[] = [];
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "" && words.length === 0) continue;
      if (STOP_RES.some((r) => r.test(line))) break;
      if (SKIP_RES.some((r) => r.test(line))) continue;
      if (starsIn(line) !== null && words.length === 0) continue;
      if (reviewer !== null && words.length === 0 && line.includes(reviewer)) continue;
      if (/^(?:date|reviewed|posted|written|reviewer|from|by|name)\s*:/i.test(line)) continue;
      // A line quoted whole (a review's title or words) loses its quote marks.
      words.push(line.replace(/^["“](.*)["”]$/, "$1"));
    }
  }
  const text = words
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return {
    stars,
    reviewer: bounded(reviewer, REVIEW_LIMITS.reviewer_chars),
    text: bounded(text === "" ? null : text, REVIEW_LIMITS.text_chars),
    link: linkIn(mail.body, mail.platform),
    reviewed_at: reviewedAt,
  };
}

/* ── the alert's deterministic check (I-45.2) ── */

const FLAG_RES = NOTIFICATIONS.flag_words.map(
  (w) =>
    new RegExp(`(?:^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}])`, "iu"),
);

/** The flag words a review's text carries, from the list in the spec. */
export function flaggedWords(text: string | null): string[] {
  if (!text) return [];
  return NOTIFICATIONS.flag_words.filter((_, i) => FLAG_RES[i]!.test(text));
}

/**
 * Worth knowing: 3 stars or fewer; or, with no stars to go on, words the
 * check flags. A 4- or 5-star review is quiet whatever its words.
 */
export function worthKnowing(stars: number | null, text: string | null): boolean {
  if (stars !== null) return stars <= 3;
  return flaggedWords(text).length > 0;
}

/* ── the same review, twice ── */

/**
 * The key a re-forward of the same notification files nothing under: the
 * platform, link, stars, words and reviewer, hashed. The link alone isn't
 * used, because a notification's link may point at the whole listing and
 * would fold two different reviews into one. An unread notification has
 * no content to hash, so it keys on its Message-ID (or Resend's id).
 */
export function dedupeKey(
  platform: ReviewPlatformKey,
  r: Pick<ParsedReview, "stars" | "reviewer" | "text" | "link">,
  fallbackId: string | null,
): string {
  const empty = r.stars === null && r.text === null && r.reviewer === null;
  const basis = empty
    ? `unread|${fallbackId ?? ""}`
    : [
        platform,
        r.link ?? "",
        r.stars ?? "",
        squash(r.text ?? "").toLowerCase(),
        squash(r.reviewer ?? "").toLowerCase(),
      ].join("|");
  return createHash("sha256").update(basis).digest("hex");
}
