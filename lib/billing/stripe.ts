// Payments — Session I (P1-50). Stripe Checkout for the one-off report.
//
// P6-05 moved this from lib/payments to lib/billing: it is SYB billing its
// own customer, not a business's money. lib/payments is now prepared
// payments only, under rule 26's gate (lib/payments/fence.test.ts), which
// allows no call to a payment provider there.
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
//   · One bill for several businesses (I-52a, owner 2026-10-31: one
//     checkout, the first business at the report price, each extra one
//     at EXTRA_REPORT_PRICE_MINOR, default €29.00). One Checkout Session
//     carries a line per business and a payments row per business, all
//     joined by the session id, and the webhook marks them paid together.
//     I-52e (owner 2026-10-31: "go ahead with I-52e too"): once a person
//     has paid for any business they own, every business in a later
//     checkout is at the extra price, the first included.

import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
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

/**
 * I-52a: each business after the first in one checkout. Same currency as
 * the report; never more than the report price.
 */
export function extraReportPrice(): { amount_minor: number; currency: string } {
  const full = reportPrice();
  const raw = process.env.EXTRA_REPORT_PRICE_MINOR || "2900";
  const amount = Number.parseInt(raw, 10);
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new PaymentError(
      "EXTRA_REPORT_PRICE_MINOR must be a positive integer of minor units",
      500,
    );
  }
  if (amount > full.amount_minor) {
    throw new PaymentError("EXTRA_REPORT_PRICE_MINOR can't be more than the report price", 500);
  }
  return { amount_minor: amount, currency: full.currency };
}

/**
 * Pure: what each of `n` businesses costs in one checkout: the first in
 * full, the rest at the extra price. I-52e: an owner who has already paid
 * for one of their businesses pays the extra price for all of them.
 */
export function checkoutAmounts(
  n: number,
  full: number,
  extra: number,
  paidBefore = false,
): number[] {
  return Array.from({ length: Math.max(0, n) }, (_, i) => (i === 0 && !paidBefore ? full : extra));
}

/** The businesses of `profileIds` that already have a verified payment. */
export async function paidProfiles(profileIds: readonly string[]): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set();
  const rows = await db
    .select({ profile_id: payments.profile_id })
    .from(payments)
    .where(and(inArray(payments.profile_id, [...profileIds]), eq(payments.status, "paid")));
  return new Set(rows.map((r) => r.profile_id));
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
  /** The whole checkout: every business in it. */
  amount_minor: number;
  currency: string;
  /** I-52a: how many businesses it pays for. */
  businesses: number;
}

/** I-52a: another business the same owner pays for in this checkout. */
export interface AlsoBusiness {
  profile_id: string;
  /** Its own name, for the Stripe line and receipt; null before the interview names it. */
  name: string | null;
}

/** I-52a: at most this many businesses in one checkout. */
export const MAX_CHECKOUT_BUSINESSES = 20;

/**
 * Create a Stripe Checkout Session for this profile's report, and for
 * the `also` businesses' reports in the same payment (I-52a), and record
 * one pending row per business. Repeat calls create new attempts; only a
 * webhook can make any of them paid. The caller decides who may pay for
 * which business; this refuses an `also` business that is this one,
 * repeated, already paid, or not a business.
 */
export async function startCheckout(
  profileId: string,
  appUrl: string,
  also: readonly AlsoBusiness[] = [],
  /** I-52e: the payer has already paid for another business they own (the caller checks). */
  paidBefore = false,
): Promise<CheckoutStart> {
  if (!paymentsConfigured()) throw new PaymentError("payments are not configured", 503);
  const key = process.env.STRIPE_SECRET_KEY as string;
  const price = reportPrice();
  const extra = also.length > 0 || paidBefore ? extraReportPrice() : price;

  const ids = [profileId, ...also.map((a) => a.profile_id)];
  if (new Set(ids).size !== ids.length) {
    throw new PaymentError("a business can be in a checkout only once", 400);
  }
  if (ids.length > MAX_CHECKOUT_BUSINESSES) {
    throw new PaymentError(
      `one checkout pays for at most ${MAX_CHECKOUT_BUSINESSES} businesses`,
      400,
    );
  }
  const found = await db
    .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(inArray(businessProfiles.id, ids));
  const accountOf = new Map(found.map((p) => [p.id, p.account_id]));
  if (!accountOf.has(profileId)) throw new PaymentError("no such profile", 404);
  if (also.some((a) => !accountOf.has(a.profile_id))) {
    throw new PaymentError("no such business", 404);
  }
  // Review 2026-11-01: this business too, so a direct POST can't charge a paid report again.
  const paid = await paidProfiles(ids);
  if (paid.has(profileId)) throw new PaymentError("this report is already paid for", 409);
  if (paid.size > 0) throw new PaymentError("that business is already paid for", 409);

  const amounts = checkoutAmounts(ids.length, price.amount_minor, extra.amount_minor, paidBefore);
  const params = new URLSearchParams({
    mode: "payment",
    success_url: `${appUrl}/report?checkout=success`,
    cancel_url: `${appUrl}/report?checkout=cancelled`,
    "metadata[profile_id]": profileId,
  });
  const names = ["SYB business diagnosis", ...also.map((a) => alsoLine(a.name))];
  names.forEach((name, i) => {
    params.set(`line_items[${i}][price_data][currency]`, price.currency);
    params.set(`line_items[${i}][price_data][unit_amount]`, String(amounts[i]));
    params.set(`line_items[${i}][price_data][product_data][name]`, name);
    params.set(`line_items[${i}][quantity]`, "1");
  });
  if (also.length > 0) params.set("metadata[businesses]", String(ids.length));
  if (paidBefore) params.set("metadata[returning_owner]", "true");

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

  const sessionId = body.id;
  await db.insert(payments).values(
    ids.map((id, i) => ({
      account_id: accountOf.get(id)!,
      profile_id: id,
      checkout_session_id: sessionId,
      amount_minor: amounts[i]!,
      currency: price.currency,
    })),
  );

  return {
    checkout_url: body.url,
    checkout_session_id: sessionId,
    amount_minor: amounts.reduce((a, b) => a + b, 0),
    currency: price.currency,
    businesses: ids.length,
  };
}

/** Pure: the Stripe line for another business; its name, else a plain stand-in. */
export function alsoLine(name: string | null): string {
  const n = name?.trim();
  return n
    ? `SYB business diagnosis: ${n.slice(0, 80)}`
    : "SYB business diagnosis: another business";
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
 * Mark a checkout session paid: every business it paid for (I-52a), in
 * one statement. Idempotent: Stripe retries webhooks, and a second
 * delivery of the same event must change nothing.
 */
export async function markCheckoutPaid(
  checkoutSessionId: string,
): Promise<"paid" | "already" | "unknown"> {
  const rows = await db
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.checkout_session_id, checkoutSessionId));
  if (rows.length === 0) return "unknown";
  const marked = await db
    .update(payments)
    .set({ status: "paid", paid_at: new Date().toISOString() })
    .where(and(eq(payments.checkout_session_id, checkoutSessionId), ne(payments.status, "paid")))
    .returning({ id: payments.id });
  return marked.length > 0 ? "paid" : "already";
}
