// "A customer emailed you" — the owner's notice, Phase 4 Session C (P4-11).
//
// When an inbound email opens a NEW ticket, the business's owner may get
// one short email at their own account address, the one they sign in
// with. The owner is not a customer, so this is no customer-facing send;
// it still keeps the stranger tier's discipline, because a stranger's
// email is what triggers it:
//   · it goes only to the account's owner, read from the users table —
//     never to any address the inbound mail carried;
//   · it carries no customer text (no sender, no subject, no body), so a
//     stranger can't use it to relay words to anyone;
//   · at most one an hour per business, claimed atomically, so a flood of
//     mail is one notice and the rail's count does the rest;
//   · with no RESEND_API_KEY nothing is sent and nothing claims it was;
//   · the owner can switch it off on /support.

import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { db } from "../../db";
import { supportSettings, users } from "../../db/schema";
import { appUrl, resendApiKey } from "../env";
import type { Words } from "../i18n/recipient";
import { englishWords, personLocale, wordsFor } from "../i18n/recipient";

export const OWNER_NOTICE_GAP_MS = 60 * 60 * 1000;
/** A notice Resend hasn't answered by now is given up on (review 2026-10-23, #24): the webhook waits on it. */
export const OWNER_NOTICE_TIMEOUT_MS = 10_000;

export type NoticeOutcome =
  "sent" | "not_configured" | "off" | "recently_sent" | "no_owner" | "failed";

export type NoticeFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Pure: the notice's subject and text in one language (L-6; English by default, as before). */
export function ownerNoticeContent(
  business: string,
  origin: string,
  w: Words = englishWords("emails.supportNotice"),
): { subject: string; text: string } {
  const waiting = origin
    ? w.t("waiting", { business, url: `${origin}/support` })
    : w.t("waitingNoLink", { business });
  return {
    subject: w.t("subject"),
    text: `${waiting}\n\n${w.t("nothingSent")}\n\n${w.t("atMost")}`,
  };
}

export async function notifyOwnerOfEmailTicket(args: {
  profileId: string;
  ticketId: string;
  fetchImpl?: NoticeFetch;
  now?: Date;
  timeoutMs?: number;
}): Promise<NoticeOutcome> {
  const now = args.now ?? new Date();
  const key = resendApiKey();
  const [settings] = await db
    .select()
    .from(supportSettings)
    .where(eq(supportSettings.profile_id, args.profileId));
  if (!settings) return "no_owner";
  const done = (outcome: NoticeOutcome) => {
    console.log(
      JSON.stringify({
        event: "support_owner_notice",
        account_id: settings.account_id,
        ticket_id: args.ticketId,
        outcome,
      }),
    );
    return outcome;
  };
  if (!key) return done("not_configured");
  if (!settings.notify_owner) return done("off");
  const [owner] = await db
    .select({ email: users.email, language: users.language })
    .from(users)
    .where(
      and(
        eq(users.account_id, settings.account_id),
        eq(users.role, "owner"),
        isNull(users.removed_at),
      ),
    )
    .orderBy(asc(users.created_at))
    .limit(1);
  if (!owner) return done("no_owner");

  // Claim the hour before sending: two deliveries at once send one notice.
  const cutoff = new Date(now.getTime() - OWNER_NOTICE_GAP_MS).toISOString();
  const [claimed] = await db
    .update(supportSettings)
    .set({ owner_notified_at: now.toISOString() })
    .where(
      and(
        eq(supportSettings.profile_id, args.profileId),
        or(
          isNull(supportSettings.owner_notified_at),
          lt(supportSettings.owner_notified_at, cutoff),
        ),
      ),
    )
    .returning({ profile_id: supportSettings.profile_id });
  if (!claimed) return done("recently_sent");

  const origin = appUrl()?.replace(/\/$/, "") ?? "";
  // L-6: in the owner's own language, while it is open to them; English otherwise.
  const content = ownerNoticeContent(
    settings.business_name,
    origin,
    await wordsFor(
      personLocale(owner.language, { email: owner.email, account_id: settings.account_id }),
      "emails.supportNotice",
    ),
  );
  const res = await (args.fetchImpl ?? fetch)("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `syb-owner-notice-${args.ticketId}`,
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM?.trim() || "ScaleX <onboarding@resend.dev>",
      to: [owner.email],
      subject: content.subject,
      text: content.text,
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? OWNER_NOTICE_TIMEOUT_MS),
  }).catch(() => null);
  return done(res && res.ok ? "sent" : "failed");
}
