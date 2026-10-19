// Campaign delivery events — P4-17 (Phase 4 Session F).
//
//   POST /api/email/events    Resend's email.delivered / bounced / complained /
//                             suppressed events, Svix-signed
//
// Its own Resend webhook with its own secret, beside the inbound support
// webhook rather than inside it: that route is stranger-facing support
// (rule 21 keeps it to lib/support), and this one writes the outbound
// journal and the suppression list. It reads no cookie and knows no session.
//
//   · An unsigned or badly signed delivery is a 401, and nothing is read.
//   · With no signing secret configured, every delivery is refused (503).
//   · Event types it doesn't keep — opens and clicks among them — are
//     acknowledged (200) and dropped, never stored.
//   · An event for an email SYB doesn't know (or whose recipient was erased)
//     is acknowledged and dropped.
//   · A redelivered event changes nothing: every write is conditional.
//   · A database failure answers 503, so Resend retries the delivery.

import { type NextRequest, NextResponse } from "next/server";
import { resendEventsWebhookSecret } from "../../../../lib/env";
import { applyDeliveryEvent, parseDeliveryEvent } from "../../../../lib/crm/campaign-events";
import { verifyWebhook } from "../../../../lib/support/inbound";

/** Resend's events are metadata only, a few KB. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = resendEventsWebhookSecret();
  if (!secret) {
    console.error(JSON.stringify({ event: "campaign_events_not_configured", account_id: null }));
    return json({ error: "delivery events aren't set up" }, 503);
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
        event: "campaign_events_bad_signature",
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
  const event = parseDeliveryEvent(parsed);
  if (!event) return json({ ignored: true });
  try {
    const outcome = await applyDeliveryEvent(event);
    return json({ outcome: outcome.kind });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "campaign_events_error",
        account_id: null,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return json({ error: "try again" }, 503);
  }
}
