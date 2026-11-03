// What customers check — P2-32 (Phase 2 Session G, blindspots).
//
// For each business type, the things a potential customer looks for
// before buying (specs/customer-checks-v1.json — data, not code, rule 4),
// and a deterministic check of whether the owner's own site shows them:
// keyword presence in the fetched pages' text and link targets. No model
// call. It is deliberately not the full Tier 1 site audit (site-audit §2):
// no screenshots, no judgement of design — only "is it there at all".
//
// Pages are fetched through the existing GET-only fetcher with its
// resolved-IP SSRF guard (lib/site/fetch.ts), at most MAX_PAGES of the
// owner's own origin. The result is a fact with a web_research source
// (rule 2) naming the page it was read from.
//
// L-4b: a check's label shown to the owner is a "blindspotsWords" message
// keyed by its code (the spec's English is the English message); the
// keyword lists are data and stay as they are. The site check's reasons
// are returned in English, as before, and worded for the screen by the
// route (NO_WEBSITE_REASON, UNREADABLE_REASON name them without matching
// a sentence).

import checksSpec from "../../specs/customer-checks-v1.json";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { englishTr } from "../i18n/tr";
import type { Tr } from "../i18n/tr";
import { readCurrentField, writeField } from "../profile/field-store";
import type { PageFetcher } from "../site/fetch";
import { livePageFetcher } from "../site/fetch";

export const SITE_CHECKS_KEY = "presence.site_checks";
export const WEBSITE_KEY = "presence.website_url";
export const BUSINESS_TYPE_KEY = "identity.business_type";
export const MAX_PAGES = 5;

/** The namespace of the sentences lib/blindspots builds. */
export const BLINDSPOT_WORDS = "blindspotsWords";
/** runSiteChecks' reason when the profile has no website. */
export const NO_WEBSITE_REASON = "no website in the profile";
/** runSiteChecks' reason when no page could be read starts with this, then ": " and why. */
export const UNREADABLE_REASON = "the website couldn't be read";

/** What stopped the site check: no website, no page readable, or an error thrown on the way. */
export type SiteNoteKind = "no_site" | "unreadable" | "error";

/** Pure: the site check's English reason as a kind and its words in the reader's language. */
export function siteNote(reason: string, w: { tr: Tr }): { kind: SiteNoteKind; note: string } {
  if (reason === NO_WEBSITE_REASON) return { kind: "no_site", note: w.tr("siteNote.noSite") };
  const prefix = `${UNREADABLE_REASON}: `;
  if (reason.startsWith(prefix)) {
    return {
      kind: "unreadable",
      note: w.tr("siteNote.unreadable", { detail: reason.slice(prefix.length) }),
    };
  }
  return { kind: "error", note: reason };
}

interface CheckDef {
  label: { en: string };
  keywords: Record<string, string[]>;
}
interface ChecksSpec {
  version: string;
  checks: Record<string, CheckDef>;
  by_business_type: Record<string, string[]>;
  default: string[];
}

export const CHECKS = checksSpec as unknown as ChecksSpec;

export function checksFor(businessType: string | null): string[] {
  return (businessType && CHECKS.by_business_type[businessType]) || CHECKS.default;
}

/** A check's label in the reader's words ("blindspotsWords.check.<code>"); an unknown code shows as itself. */
export function checkLabel(code: string, tr: Tr = englishTr(BLINDSPOT_WORDS)): string {
  return Object.hasOwn(CHECKS.checks, code) ? tr(`check.${code}`) : code;
}

/** Text a customer would read, plus link targets (tel:, mailto:, maps links count). */
export function pageText(html: string): string {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]).join(" ");
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&euro;/g, "€")
    .replace(/&pound;/g, "£");
  return `${text} ${hrefs}`.replace(/\s+/g, " ").toLowerCase();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Keyword at a word boundary (a letter before it doesn't count, so "ár"
 * never matches "nyár"); keywords of three letters or fewer must also end
 * at one, so "eur" never matches "Europe". Symbols and URL fragments
 * ("€", "tel:") match anywhere.
 */
export function keywordMatches(text: string, keyword: string): boolean {
  const kw = keyword.toLowerCase();
  if (!/^[\p{L}\p{N} ]+$/u.test(kw)) return text.includes(kw);
  const tail = kw.length <= 3 ? "(?![\\p{L}\\p{N}])" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}])${escape(kw)}${tail}`, "u").test(text);
}

export function detects(text: string, code: string): boolean {
  const def = CHECKS.checks[code];
  if (!def) return false;
  return Object.values(def.keywords).some((list) => list.some((kw) => keywordMatches(text, kw)));
}

/** Same-origin links worth reading for the checks, best first. */
export function candidateLinks(html: string, base: URL): string[] {
  const wanted =
    /menu|etlap|price|ar(ak|lista)?\b|contact|kapcsolat|elerhetoseg|about|rolunk|book|foglal|faq|shipping|szallitas|delivery|returns|visszakuld/i;
  const seen = new Set<string>([base.href]);
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(m[1] ?? "", base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin || seen.has(url.href)) continue;
    const label = `${url.pathname} ${(m[2] ?? "").replace(/<[^>]+>/g, " ")}`
      .normalize("NFD")
      .replace(/\p{M}/gu, "");
    if (!wanted.test(label)) continue;
    seen.add(url.href);
    out.push(url.href);
  }
  return out;
}

export interface SiteChecks {
  version: string;
  business_type: string | null;
  checked_at: string;
  pages: string[];
  /** check code → the page it was found on, or null when no page showed it. */
  results: Record<string, string | null>;
  /** Pages that could not be read, with why. */
  unreadable: { url: string; reason: string }[];
}

/** Read the owner's site and record which checks it shows. */
export async function runSiteChecks(
  profileId: string,
  opts: { fetcher?: PageFetcher; now?: Date } = {},
): Promise<SiteChecks | { reason: string }> {
  const fetcher = opts.fetcher ?? livePageFetcher;
  const now = opts.now ?? new Date();
  const site = await readCurrentField<string>(profileId, WEBSITE_KEY);
  if (
    !site ||
    site.status !== "answered" ||
    typeof site.value !== "string" ||
    site.value.trim() === ""
  ) {
    return { reason: NO_WEBSITE_REASON };
  }
  const type = await readCurrentField<{ code?: string } | string>(profileId, BUSINESS_TYPE_KEY);
  const businessType =
    typeof type?.value === "string"
      ? type.value
      : ((type?.value as { code?: string } | null)?.code ?? null);
  const codes = checksFor(businessType);

  const pages: string[] = [];
  const unreadable: SiteChecks["unreadable"] = [];
  const texts: { url: string; text: string }[] = [];
  const queue = [site.value.includes("://") ? site.value : `https://${site.value}`];
  let base: URL | null = null;
  while (queue.length > 0 && pages.length + unreadable.length < MAX_PAGES) {
    const url = queue.shift() as string;
    try {
      const page = await fetcher(url);
      pages.push(page.url);
      texts.push({ url: page.url, text: pageText(page.html) });
      if (base === null) {
        base = new URL(page.url);
        queue.push(...candidateLinks(page.html, base).slice(0, MAX_PAGES - 1));
      }
    } catch (error) {
      unreadable.push({ url, reason: error instanceof Error ? error.message : String(error) });
      if (base === null) break;
    }
  }
  if (texts.length === 0) {
    return { reason: `${UNREADABLE_REASON}: ${unreadable[0]?.reason ?? "no page"}` };
  }

  const results: Record<string, string | null> = {};
  for (const code of codes) {
    results[code] = texts.find((t) => detects(t.text, code))?.url ?? null;
  }
  const value: SiteChecks = {
    version: CHECKS.version,
    business_type: businessType,
    checked_at: now.toISOString(),
    pages,
    results,
    unreadable,
  };
  await writeField(
    profileId,
    createField<SiteChecks>({
      id: fieldId(SITE_CHECKS_KEY),
      value,
      status: "answered",
      confidence: confidence(0.5),
      source: { kind: "web_research", researched_url: pages[0] as string },
      observed_at: isoDateTime(now.toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
      note: null,
    }),
  );
  return value;
}
