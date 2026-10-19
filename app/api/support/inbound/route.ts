// The inbound support-email webhook — Phase 4 Session C (P4-09).
//
//   POST /api/support/inbound    Resend's email.received event, Svix-signed
//
// Stranger-facing: anyone on the internet can email a business, and this
// is where that mail lands. So it reads no cookie, knows no session, and
// imports lib/support only (the rule-21 structural test holds it to that).
//
//   · An unsigned or badly signed delivery is a 401, and nothing is read.
//   · With no signing secret configured, every delivery is refused (503):
//     an unverifiable email is never filed.
//   · Other event types are acknowledged (200) and ignored.
//   · Mail for no known business is acknowledged (200) and dropped.
//   · A redelivered email is acknowledged and files nothing twice.
//   · A failure to fetch the body from Resend answers 5xx, so Resend
//     retries the delivery — the email is not lost and not half-filed.
//
// Nothing here drafts or sends a reply: a stranger emailing in can never
// spend money on a model or make a reply go out.

import { type NextRequest, NextResponse } from "next/server";
import { resendApiKey, resendWebhookSecret, supportInboundDomain } from "../../../../lib/env";
import { receiveInboundEmail } from "../../../../lib/support/email-tickets";
import {
  InboundFetchError,
  fetchReceivedEmail,
  normaliseReceived,
  parseReceivedEvent,
  verifyWebhook,
} from "../../../../lib/support/inbound";

/** The largest webhook body accepted. Resend's event is metadata only, a few KB. */
const MAX_WEBHOOK_BYTES = 256 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = resendWebhookSecret();
  const domain = supportInboundDomain();
  const apiKey = resendApiKey();
  if (!secret || !domain || !apiKey) {
    console.error(
      JSON.stringify({
        event: "support_inbound_not_configured",
        account_id: null,
        secret: secret !== null,
        domain: domain !== null,
        api_key: apiKey !== null,
      }),
    );
    return json({ error: "inbound email isn't set up" }, 503);
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_WEBHOOK_BYTES) return json({ error: "too large" }, 413);
  const verified = verifyWebhook({
    rawBody,
    secret,
    headers: {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
  });
  if (!verified.ok) {
    console.warn(
      JSON.stringify({
        event: "support_inbound_bad_signature",
        account_id: null,
        why: verified.reason,
      }),
    );
    return json({ error: "bad signature" }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return json({ error: "not JSON" }, 400);
  }
  const event = parseReceivedEvent(parsed);
  if (!event) return json({ ignored: true });

  try {
    const content = await fetchReceivedEmail(event.email_id, apiKey);
    const email = normaliseReceived(event, content);
    if (!email) {
      console.warn(JSON.stringify({ event: "support_inbound_unreadable", account_id: null }));
      return json({ ignored: true });
    }
    const outcome = await receiveInboundEmail(email, domain);
    return json({ outcome: outcome.kind });
  } catch (error) {
    // The name only — an email's content could be in a message.
    console.error(
      JSON.stringify({
        event: "support_inbound_error",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
        retryable: error instanceof InboundFetchError ? error.retryable : true,
      }),
    );
    if (error instanceof InboundFetchError && !error.retryable) {
      return json({ error: "the email could not be read" }, 200);
    }
    return json({ error: "try again" }, 503);
  }
}
