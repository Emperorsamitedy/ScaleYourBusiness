// Why an item can't be proposed for publishing, as a code and its values —
// L-4c of TASKS-LANGUAGES.md, namespace "contentWords". Pure, and safe in
// the browser.
//
// publishReadiness (./publish) used to say its refusals in English only, and
// the Content screen showed its "Connections" button when the sentence
// contained the English word "Connections". The refusal is now a code with
// values: the screen gets the sentence in the reader's language and a flag
// (`connect`) for the button, never a string match. English is what the
// code always said, byte for byte (lib/content/publish.test.ts).

import { dayMonthYear } from "../i18n/format";
import type { AppLocale } from "../i18n/locales";
import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

/** The namespace of the content screen's server-built sentences. */
export const CONTENT_WORDS = "contentWords";

export type PublishBlockCode =
  | "proposed"
  | "notDraft"
  | "shotList"
  | "email"
  | "kind"
  | "channel"
  | "connect"
  | "noInstagram"
  | "needsMedia"
  | "png"
  | "noDate"
  | "zone"
  | "declined"
  | "passed";

/** One reason an item isn't proposed for publishing. Values are as the data holds them. */
export interface PublishBlock {
  code: PublishBlockCode;
  /** status, kind, channel, platform, reason (English, from the timezone lookup), count, date (ISO). */
  values?: Record<string, string | number>;
}

/** The blocks Connections fixes: connecting Meta publishing there. */
export function opensConnections(block: PublishBlock): boolean {
  return block.code === "connect";
}

const STATUSES = new Set(["drafted", "queued", "publishing", "published", "failed", "withdrawn"]);
const KINDS = new Set(["post", "email", "shot_list", "video"]);

/** The timezone lookup's own English reasons (lib/hours/timezone) that the catalogue words. */
const ZONE_REASONS: Readonly<Record<string, string>> = {
  "no country given": "publish.zoneReason.noCountry",
  "the country isn't known": "publish.zoneReason.countryUnknown",
  "the business's timezone isn't known": "publish.zoneReason.zoneUnknown",
};

/** The fallback reason when the timezone lookup gave none. */
export const ZONE_UNKNOWN = "the business's timezone isn't known";

/**
 * A block in words. English says exactly what publishReadiness always said
 * (values as the data holds them); another language words the status, the
 * kind, the date and the timezone lookup's known reasons its own way, and
 * shows anything it doesn't know as it came.
 */
export function blockWords(
  block: PublishBlock,
  tr: Tr = englishTr(CONTENT_WORDS),
  locale: AppLocale = "en",
): string {
  const v = { ...(block.values ?? {}) };
  if (locale !== "en") {
    const status = String(v["status"] ?? "");
    if (STATUSES.has(status)) v["status"] = tr(`publish.status.${status}`);
    const kind = String(v["kind"] ?? "");
    if (KINDS.has(kind)) v["kind"] = tr(`publish.kind.${kind}`);
    const reason = ZONE_REASONS[String(v["reason"] ?? "")];
    if (reason) v["reason"] = tr(reason);
    if (typeof v["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v["date"])) {
      v["date"] = dayMonthYear(v["date"], locale);
    }
  }
  return tr(`publish.block.${block.code}`, v);
}
