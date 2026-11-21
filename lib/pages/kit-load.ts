// Guided page set-up: reading what the kit is made of (./kit says what it is).
//
// The four facts come from the fact sheet as it stands: a fact counts only
// when it is answered or worked out, so "I don't know" and a skipped
// question are gaps here, not values (rule 5). The business type is a code
// on file; it is worded in the reader's language from the bank's own option
// labels, English when the language has none.
//
// What is already connected is read from the publishing connection the owner
// granted on Connections: its Page id, and its Instagram account id or none.
// Reads only. No request goes to a platform from here, and no model is called.

import { loadFactWords } from "../bank/words";
import { metaAssets } from "../content/publish";
import { enumCode } from "../core/enum-value";
import type { AppLocale } from "../i18n/locales";
import { readCurrentField } from "../profile/field-store";
import type { KitFacts, PageKit } from "./kit";
import { KIT_FIELDS, pageKit } from "./kit";

/** A fact's value when the fact sheet holds one; null for unknown, skipped and unasked. */
async function held(profileId: string, key: string): Promise<unknown> {
  const field = await readCurrentField<unknown>(profileId, key);
  if (!field || (field.status !== "answered" && field.status !== "inferred")) return null;
  return field.value ?? null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export async function loadKitFacts(profileId: string, locale: AppLocale): Promise<KitFacts> {
  const [name, description, type, website] = await Promise.all([
    held(profileId, KIT_FIELDS.name.field),
    held(profileId, KIT_FIELDS.description.field),
    held(profileId, KIT_FIELDS.business_type.field),
    held(profileId, KIT_FIELDS.website.field),
  ]);
  const code = enumCode(type);
  let typeWords: string | null = null;
  if (code !== null) {
    const [words, english] = await Promise.all([loadFactWords(locale), loadFactWords("en")]);
    typeWords =
      words.value(KIT_FIELDS.business_type.field, code) ??
      english.value(KIT_FIELDS.business_type.field, code) ??
      code.replace(/_/g, " ");
  }
  return {
    name: text(name),
    description: text(description),
    business_type: typeWords,
    website: text(website),
  };
}

export interface PageSetupView {
  kit: PageKit;
  /** What the publishing connection holds today. */
  connected: {
    /** A Facebook Page is connected for publishing. */
    page: boolean;
    /** That Page's Instagram business account is connected too. */
    instagram: boolean;
  };
}

/** The guide's data for one business. */
export async function loadPageSetup(
  accountId: string,
  profileId: string,
  locale: AppLocale,
): Promise<PageSetupView> {
  const [facts, assets] = await Promise.all([
    loadKitFacts(profileId, locale),
    // A connection that cannot be read (a credential from another key) is "not connected" here:
    // the guide still shows, and Connections says what is wrong with the connection itself.
    metaAssets(accountId).catch(() => null),
  ]);
  return {
    kit: pageKit(facts),
    connected: { page: assets !== null, instagram: assets !== null && assets.ig_user_id !== null },
  };
}
