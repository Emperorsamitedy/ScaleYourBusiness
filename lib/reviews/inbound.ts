// Inbound review notifications — idea 45 (I-45.1).
//
// The owner forwards the review emails they already get (Google,
// Trustpilot, Booksy, Fresha) to r-<token>@<SUPPORT_INBOUND_DOMAIN>. The
// support inbox's webhook (app/api/support/inbound) hands any email
// addressed to an r- address here instead of filing a ticket.
//
//   Routing. The token is on review_settings: unguessable, rotatable. Mail
//   for no known token is dropped with a log line that holds no PII.
//   Our own mail (a sign-in link forwarded back) is dropped the same way.
//
//   Recognising. Only an email whose ORIGINAL sender is a review platform's
//   (./parse.ts originalMail and isReviewNotification) is read. Anything
//   else is dropped, with a no-PII log line. Nothing a stranger sends to
//   the address from their own mailbox becomes a review.
//
//   Reading. The deterministic parser first. Only for a recognised review
//   sender whose format it couldn't read, the capped model fallback
//   (./fallback.ts). Failing both, the review is filed as one I couldn't
//   read, with its platform, its date and its link when there was one.
//
//   Idempotency. Resend's id is UNIQUE on the row (a redelivery files
//   nothing), and so is the review's content key (a re-forward files nothing).
//
// Nothing here drafts a reply, contacts anyone or creates a contact: a
// reviewer is not a customer record, and a review is not consent (rule 19).
// Stranger-facing (rule 21): lib/reviews, lib/support's mail helpers, the
// model client and the database only.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { reviewSettings, reviews } from "../../db/schema";
import { isOwnMail } from "../support/email-tickets";
import type { InboundEmail } from "../support/inbound";
import type { ReviewParseLlm } from "./fallback";
import { readWithFallback } from "./fallback";
import type { ParsedReview } from "./parse";
import { isReviewNotification, originalMail, parseNotification } from "./parse";
import type { ReadBy } from "./store";
import { fileReview } from "./store";

export const REVIEW_TOKEN_RE = /^[0-9a-f]{32}$/;
const ADDRESS_RE = /^r-([0-9a-f]{32})@([a-z0-9.-]+)$/;

/** The address a business forwards its review notifications to. */
export function reviewAddress(token: string, domain: string): string {
  return `r-${token}@${domain}`;
}

/** The review token an email's addresses carry for our domain, or null: then it isn't review mail. */
export function reviewRoutingFrom(addresses: readonly string[], domain: string): string | null {
  for (const raw of addresses) {
    const m = ADDRESS_RE.exec(raw.trim().toLowerCase());
    if (m && m[2] === domain) return m[1]!;
  }
  return null;
}

export type ReviewInboundOutcome =
  | { kind: "filed"; review_id: string; alerted: boolean; read_by: ReadBy }
  | { kind: "duplicate" }
  | { kind: "unrouted" }
  | { kind: "own_mail" }
  /** Not from a review platform, or not a review notification: dropped. */
  | { kind: "not_a_review" };

/** File one forwarded review notification under the business its address names. */
export async function receiveReviewEmail(
  email: InboundEmail,
  domain: string,
  opts: { llm?: ReviewParseLlm; now?: Date; spentEur?: (now: Date) => Promise<number> } = {},
): Promise<ReviewInboundOutcome> {
  const now = opts.now ?? new Date();
  const [already] = await db
    .select({ id: reviews.id })
    .from(reviews)
    .where(eq(reviews.provider_id, email.provider_id));
  if (already) return { kind: "duplicate" };

  const token = reviewRoutingFrom(email.to, domain);
  const [settings] = token
    ? await db.select().from(reviewSettings).where(eq(reviewSettings.inbound_token, token))
    : [];
  if (!settings) {
    // No PII: not the address, not the subject — only that it happened.
    console.log(JSON.stringify({ event: "review_inbound_unrouted", account_id: null }));
    return { kind: "unrouted" };
  }
  const who = { account_id: settings.account_id, profile_id: settings.profile_id };
  if (isOwnMail(email.from.address)) {
    console.log(JSON.stringify({ event: "review_inbound_own_mail_dropped", ...who }));
    return { kind: "own_mail" };
  }

  const mail = originalMail({
    from: email.from.address,
    subject: email.subject,
    text: email.text,
  });
  if (!mail || !isReviewNotification(mail)) {
    // Dropped unread: which sender or what it said is never logged.
    console.log(
      JSON.stringify({
        event: "review_inbound_not_a_review",
        ...who,
        platform: mail?.platform ?? null,
      }),
    );
    return { kind: "not_a_review" };
  }

  let read: ParsedReview = parseNotification(mail, now);
  let readBy: ReadBy = "parser";
  if (read.stars === null) {
    const fallback = await readWithFallback({
      mail,
      profileId: settings.profile_id,
      accountId: settings.account_id,
      now,
      ...(opts.llm ? { llm: opts.llm } : {}),
      ...(opts.spentEur ? { spentEur: opts.spentEur } : {}),
    });
    const got = fallback.kind === "read" ? fallback.review : null;
    if (got && (got.stars !== null || got.text !== null)) {
      // The model copies; the parser's date and link stand where it found none.
      read = {
        stars: got.stars,
        reviewer: got.reviewer ?? read.reviewer,
        text: got.text ?? read.text,
        link: got.link ?? read.link,
        reviewed_at: read.reviewed_at,
      };
      readBy = "model";
    } else if (read.text !== null) {
      // Review 2026-10-30: the fallback was capped or found nothing, but the
      // parser had read the words: they stay, with no stars, so the flag-word
      // check (worthKnowing) still runs on them.
      readBy = "parser";
    } else {
      // Unread: nothing of the email is kept but its platform, date and link.
      read = {
        stars: null,
        reviewer: null,
        text: null,
        link: read.link,
        reviewed_at: read.reviewed_at,
      };
      readBy = "unread";
    }
    console.log(
      JSON.stringify({
        event: "review_inbound_fallback",
        ...who,
        platform: mail.platform,
        outcome: fallback.kind === "capped" ? `capped_${fallback.why}` : fallback.kind,
        read_by: readBy,
      }),
    );
  }

  const out = await fileReview(
    {
      ...read,
      ...who,
      platform: mail.platform,
      source: "email",
      read_by: readBy,
      received_at: email.received_at,
      provider_id: email.provider_id,
      fallback_id: email.message_id ?? email.provider_id,
      sender_auth: email.sender_auth,
    },
    now,
  );
  if (out.kind === "duplicate") return { kind: "duplicate" };
  return { kind: "filed", review_id: out.review.id, alerted: out.alerted, read_by: readBy };
}
