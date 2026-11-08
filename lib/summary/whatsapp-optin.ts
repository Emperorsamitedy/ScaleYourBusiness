// The owner's WhatsApp opt-in, read and written — P6-07, rules 19 and 22.
//
// A yes is a recorded fact (whatsapp_optins): the number, the version and
// language of the sentence shown, its sha256, and when. The sentence is the
// catalogue's own (watch.summary.whatsapp.consent): the screen shows it and
// sends it back, and a yes is recorded only when what came back is word for
// word what that language says now — what was agreed is what was shown.
// Withdrawing is one click and takes effect at once: the runner reads the
// live opt-in at send time, so next week's run sends nothing. Erasure
// clears the number for good and keeps the dates and the hash. Logs carry
// ids only, never the number.

import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db";
import { whatsappOptins } from "../../db/schema";
import type { AppLocale } from "../i18n/locales";
import { wordsFor } from "../i18n/recipient";
import { WHATSAPP_CONSENT_VERSION, toE164 } from "./whatsapp";

export interface LiveOptin {
  id: string;
  phone_number: string;
  opted_in_at: string;
}

/** The sentence a language shows beside the tick box, as the catalogue holds it now. */
export async function consentSentence(locale: AppLocale): Promise<string> {
  return (await wordsFor(locale, "watch.summary.whatsapp")).t("consent");
}

export const sha256Hex = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** The user's live yes, or null: never given, withdrawn, or erased. */
export async function liveOptin(userId: string): Promise<LiveOptin | null> {
  const [row] = await db
    .select({
      id: whatsappOptins.id,
      phone_number: whatsappOptins.phone_number,
      opted_in_at: whatsappOptins.opted_in_at,
    })
    .from(whatsappOptins)
    .where(
      and(
        eq(whatsappOptins.user_id, userId),
        isNull(whatsappOptins.withdrawn_at),
        isNotNull(whatsappOptins.phone_number),
      ),
    )
    .orderBy(desc(whatsappOptins.opted_in_at))
    .limit(1);
  return row && row.phone_number ? { ...row, phone_number: row.phone_number } : null;
}

export type OptInResult =
  { ok: true; optin: LiveOptin } | { ok: false; reason: "invalid_number" | "consent_mismatch" };

/**
 * Record a yes. `shown` is the sentence the screen showed, sent back as is;
 * it must equal the catalogue's for `locale`. A live yes before it is
 * withdrawn in the same transaction, so at most one is ever live.
 */
export async function optIn(args: {
  accountId: string;
  userId: string;
  number: string;
  locale: AppLocale;
  shown: string;
}): Promise<OptInResult> {
  const number = toE164(args.number);
  if (!number) return { ok: false, reason: "invalid_number" };
  const sentence = await consentSentence(args.locale);
  if (args.shown !== sentence) return { ok: false, reason: "consent_mismatch" };
  const now = new Date().toISOString();
  const row = await db.transaction(async (tx) => {
    await tx
      .update(whatsappOptins)
      .set({ withdrawn_at: now })
      .where(and(eq(whatsappOptins.user_id, args.userId), isNull(whatsappOptins.withdrawn_at)));
    const [inserted] = await tx
      .insert(whatsappOptins)
      .values({
        account_id: args.accountId,
        user_id: args.userId,
        phone_number: number,
        consent_version: WHATSAPP_CONSENT_VERSION,
        consent_locale: args.locale,
        consent_sha256: sha256Hex(sentence),
        opted_in_at: now,
      })
      .returning({ id: whatsappOptins.id, opted_in_at: whatsappOptins.opted_in_at });
    return inserted!;
  });
  console.log(
    JSON.stringify({
      event: "whatsapp_optin",
      account_id: args.accountId,
      optin_id: row.id,
      consent_version: WHATSAPP_CONSENT_VERSION,
      locale: args.locale,
    }),
  );
  return { ok: true, optin: { id: row.id, phone_number: number, opted_in_at: row.opted_in_at } };
}

/** Withdraw the live yes, now. Idempotent: true when one was live. */
export async function withdrawOptin(userId: string, accountId: string): Promise<boolean> {
  const rows = await db
    .update(whatsappOptins)
    .set({ withdrawn_at: new Date().toISOString() })
    .where(and(eq(whatsappOptins.user_id, userId), isNull(whatsappOptins.withdrawn_at)))
    .returning({ id: whatsappOptins.id });
  if (rows.length > 0) {
    console.log(
      JSON.stringify({ event: "whatsapp_withdrawn", account_id: accountId, optins: rows.length }),
    );
  }
  return rows.length > 0;
}

export { eraseWhatsAppNumbers } from "./whatsapp-erase";
