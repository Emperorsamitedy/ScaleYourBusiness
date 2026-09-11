// POST /api/stripe/webhook — the only writer of "paid" (P1-50).
//
// Signature-verified against STRIPE_WEBHOOK_SECRET over the RAW body —
// parse-then-restringify would break the HMAC. Idempotent, because
// Stripe redelivers. Everything else is acknowledged and ignored:
// a webhook endpoint that 500s on unknown event types gets retried
// forever and paged about.

import { type NextRequest, NextResponse } from "next/server";
import { markCheckoutPaid, verifyStripeSignature } from "../../../../lib/payments/stripe";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  let event: { type?: string; data?: { object?: { id?: string } } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const sessionId = event.data?.object?.id;
    if (typeof sessionId === "string" && sessionId !== "") {
      const outcome = await markCheckoutPaid(sessionId);
      console.log(JSON.stringify({ event: "stripe_webhook", type: event.type, outcome }));
      if (outcome === "unknown") {
        // A session we never created. Acknowledge (200) so Stripe stops
        // retrying, but log it loudly — it is either a config mixup
        // (another environment's events) or someone probing.
        console.error(JSON.stringify({ event: "stripe_unknown_session", session: sessionId }));
      }
    }
  }

  return NextResponse.json({ received: true });
}
