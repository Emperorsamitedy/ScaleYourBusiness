// POST /api/stripe/webhook — the only writer of "paid" (P1-50).
//
// Signature-verified against STRIPE_WEBHOOK_SECRET over the RAW body —
// parse-then-restringify would break the HMAC. Idempotent, because
// Stripe redelivers. Everything else is acknowledged and ignored:
// a webhook endpoint that 500s on unknown event types gets retried
// forever and paged about.

import { type NextRequest, NextResponse } from "next/server";
import { markCheckoutPaid, verifyStripeSignature } from "../../../../lib/billing/stripe";

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

  let event: { type?: string; data?: { object?: { id?: string; payment_status?: string } } };
  try {
    event = JSON.parse(rawBody) as typeof event;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  // Paid means PAID: "completed" also fires with payment_status "unpaid"
  // for delayed methods (SEPA, bank transfer), whose money may never
  // arrive. Those unlock on async_payment_succeeded instead (the security
  // review of 2026-10-17).
  const paid =
    (event.type === "checkout.session.completed" &&
      event.data?.object?.payment_status === "paid") ||
    event.type === "checkout.session.async_payment_succeeded";
  if (event.type === "checkout.session.completed" && !paid) {
    console.log(
      JSON.stringify({
        event: "stripe_webhook",
        type: event.type,
        outcome: "awaiting_payment",
        payment_status: event.data?.object?.payment_status ?? null,
      }),
    );
  }
  if (paid) {
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
