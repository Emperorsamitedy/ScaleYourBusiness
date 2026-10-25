// Payments — Session I (P1-50). Stripe Checkout for the one-off report.
//
// No SDK: Stripe's API is form-encoded HTTP and the webhook signature is
// an HMAC — both are less code than the dependency. The rules that
// matter:
//   · "paid" is only ever written by the VERIFIED webhook. The success
//     redirect proves nothing — any browser can fabricate a URL.
//   · Price comes from env (REPORT_PRICE_MINOR, integer minor units +
//     REPORT_CURRENCY), defaulting to €49.00. Money stays integer.
//   · When STRIPE_SECRET_KEY is absent, payments are NOT configured and
//     the report gate stands down (today's behaviour, logged). The gate
//     arms itself the moment the key exists.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, payments } from "../../db/schema";

export class PaymentError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PaymentError";
    this.status = status;
  }
}

export function paymentsConfigured(): boolean {
  return typeof process.env.STRIPE_SECRET_KEY === "string" && process.env.STRIPE_SECRET_KEY !== "";
}

export function reportPrice(): { amount_minor: number; currency: string } {
  // An empty env var (which hosted env editors happily produce) means
  // unset, not "the empty currency".
  const raw = process.env.REPORT_PRICE_MINOR || "4900";
  const amount = Number.parseInt(raw, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentError("REPORT_PRICE_MINOR must be a positive integer of minor units", 500);
  }
  return { amount_minor: amount, currency: (process.env.REPORT_CURRENCY || "eur").toLowerCase() };
}

/** Has this profile a verified payment? The report gate's one question. */
export async function hasPaidReport(profileId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.profile_id, profileId), eq(payments.status, "paid")))
    .limit(1);
  return row !== undefined;
}

export interface CheckoutStart {
  checkout_url: string;
  checkout_session_id: string;
  amount_minor: number;
  currency: string;
}

/**
 * Create a Stripe Checkout Session for this profile's report and record
 * the attempt as pending. Repeat calls create new attempts; only a
 * webhook can make any of them paid.
 */
export async function startCheckout(profileId: string, appUrl: string): Promise<CheckoutStart> {
  if (!paymentsConfigured()) throw new PaymentError("payments are not configured", 503);
  const key = process.env.STRIPE_SECRET_KEY as string;
  const price = reportPrice();

  const [profile] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new PaymentError("no such profile", 404);

  const params = new URLSearchParams({
    mode: "payment",
    "line_items[0][price_data][currency]": price.currency,
    "line_items[0][price_data][unit_amount]": String(price.amount_minor),
    "line_items[0][price_data][product_data][name]": "SYB business diagnosis",
    "line_items[0][quantity]": "1",
    success_url: `${appUrl}/report?checkout=success`,
    cancel_url: `${appUrl}/report?checkout=cancelled`,
    "metadata[profile_id]": profileId,
  });

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const body = (await res.json()) as { id?: string; url?: string; error?: { message?: string } };
  if (!res.ok || !body.id || !body.url) {
    console.error(
      JSON.stringify({
        event: "checkout_create_failed",
        status: res.status,
        message: body.error?.message,
      }),
    );
    throw new PaymentError("could not start the payment", 502);
  }

  await db.insert(payments).values({
    account_id: profile.account_id,
    profile_id: profileId,
    checkout_session_id: body.id,
    amount_minor: price.amount_minor,
    currency: price.currency,
  });

  return {
    checkout_url: body.url,
    checkout_session_id: body.id,
    amount_minor: price.amount_minor,
    currency: price.currency,
  };
}

/** Signature window — Stripe's own recommendation. */
const TOLERANCE_SECONDS = 300;

/**
 * Verify a Stripe webhook signature (t + v1 HMAC-SHA256 over
 * `${t}.${body}`), constant-time. Returns false rather than throwing:
 * the route turns false into a 400 without leaking which part failed.
 */
export function verifyStripeSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!signatureHeader) return false;
  const parts = new Map<string, string[]>();
  for (const piece of signatureHeader.split(",")) {
    const [k, v] = piece.split("=", 2);
    if (!k || v === undefined) continue;
    const list = parts.get(k.trim()) ?? [];
    list.push(v);
    parts.set(k.trim(), list);
  }
  const t = Number.parseInt(parts.get("t")?.[0] ?? "", 10);
  const candidates = parts.get("v1") ?? [];
  if (!Number.isFinite(t) || candidates.length === 0) return false;
  if (Math.abs(nowSeconds - t) > TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  return candidates.some((candidate) => {
    const buf = Buffer.from(candidate, "utf8");
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });
}

/**
 * Mark a checkout session paid. Idempotent: Stripe retries webhooks, and
 * a second delivery of the same event must change nothing.
 */
export async function markCheckoutPaid(
  checkoutSessionId: string,
): Promise<"paid" | "already" | "unknown"> {
  const [row] = await db
    .select({ id: payments.id, status: payments.status })
    .from(payments)
    .where(eq(payments.checkout_session_id, checkoutSessionId));
  if (!row) return "unknown";
  if (row.status === "paid") return "already";
  await db
    .update(payments)
    .set({ status: "paid", paid_at: new Date().toISOString() })
    .where(eq(payments.id, row.id));
  return "paid";
}
