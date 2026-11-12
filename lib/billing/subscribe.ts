// The subscription lifecycle — the v1 build spec §8.1, §8.3, §8.5 (P7-72,
// P7-73). SYB billing its own customer; never a business's money.
//
//   startSubscription   locks the tier's price (the price book), opens a
//                       Stripe Checkout in subscription mode — cards, and
//                       SEPA Direct Debit for euro (§8.5) — and puts the
//                       paid €49 diagnosis on the first invoice as a credit
//                       line: deferred revenue against month 1, not a sale
//   handleBillingEvent  the verified webhook's subscription events, once
//                       each: status, period, dunning (§8.5), the credit
//                       applied on the first paid invoice
//   cancel / downgrade  the cancellation flow: Watch offered first; a
//                       cancel ends at the period's end
//   runDormantCheck     §8.5: a business whose connectors have gone silent
//                       stops being billed before it asks
//
// Stripe is reached through one function (StripeCall) so tests run against
// a stub; with no STRIPE_SECRET_KEY nothing here reaches Stripe, as with the
// report gate (lib/billing/stripe.ts). Money stays integer minor units.

import { and, desc, eq, inArray, max, ne } from "drizzle-orm";
import { db } from "../../db";
import {
  billingEvents,
  businessProfiles,
  connections,
  diagnosisCredits,
  metricObservations,
  ownerNotices,
  payments,
  subscriptions,
} from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { lockSubscription } from "./price-book";
import type { Interval, SubscriptionTier } from "./plans";
import { isSubscriptionTier, periodAmount } from "./plans";
import { PaymentError, paymentsConfigured } from "./stripe";

export type StripeCall = (
  path: string,
  params?: URLSearchParams,
  method?: "GET" | "POST" | "DELETE",
) => Promise<Record<string, unknown>>;

/** Stripe's REST API, form-encoded, as lib/billing/stripe.ts does it. */
export function liveStripe(): StripeCall {
  return async (path, params, method = "POST") => {
    if (!paymentsConfigured()) throw new PaymentError("payments are not configured", 503);
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY as string}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: method === "GET" ? null : (params?.toString() ?? ""),
    });
    const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string } };
    if (!res.ok) {
      console.error(
        JSON.stringify({
          event: "stripe_call_failed",
          path,
          status: res.status,
          message: body.error?.message,
        }),
      );
      throw new PaymentError("the payment provider refused that", 502);
    }
    return body;
  };
}

type Sub = typeof subscriptions.$inferSelect;

async function liveSubscriptionOf(profileId: string): Promise<Sub | null> {
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.profile_id, profileId), ne(subscriptions.status, "canceled")))
    .orderBy(desc(subscriptions.locked_at))
    .limit(1);
  return row ?? null;
}

async function notify(
  profileId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await db.insert(ownerNotices).values({ profile_id: profileId, kind, payload });
}

const TIER_NAMES: Record<string, string> = {
  watch: "SYB Watch",
  act: "SYB Act",
  autonomous: "SYB Autonomous",
  extra_business: "SYB extra business",
};

// ── Starting a subscription ──────────────────────────────────────────────

/**
 * §8.1: every paid diagnosis becomes a deferred credit, created when its
 * payment is marked paid. Idempotent per payment.
 */
export async function deferDiagnosisCredits(checkoutSessionId: string): Promise<number> {
  const paid = await db
    .select()
    .from(payments)
    .where(and(eq(payments.checkout_session_id, checkoutSessionId), eq(payments.status, "paid")));
  if (paid.length === 0) return 0;
  const made = await db
    .insert(diagnosisCredits)
    .values(
      paid.map((p) => ({
        profile_id: p.profile_id,
        payment_id: p.id,
        amount_minor: p.amount_minor,
        currency: p.currency,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: diagnosisCredits.id });
  return made.length;
}

export async function startSubscription(args: {
  profileId: string;
  tier: SubscriptionTier | "extra_business";
  interval: Interval;
  billingCountry: string;
  vatCountry: string;
  appUrl: string;
  parentSubscriptionId?: string | null;
  stripe?: StripeCall;
  now?: Date;
}): Promise<{ checkout_url: string; subscription_id: string; credit_minor: number }> {
  const stripe = args.stripe ?? liveStripe();
  if (!isSubscriptionTier(args.tier) && args.tier !== "extra_business") {
    throw new PaymentError("pick Watch, Act or Autonomous", 422);
  }
  const live = await liveSubscriptionOf(args.profileId);
  if (live && live.status !== "incomplete")
    throw new PaymentError("this business already has a plan", 409);
  if (args.tier === "extra_business") {
    if (!args.parentSubscriptionId)
      throw new PaymentError("an extra business rides on another plan", 422);
    const [parent] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.id, args.parentSubscriptionId), eq(subscriptions.status, "active")),
      );
    if (!parent) throw new PaymentError("the plan it rides on isn't active", 409);
  }

  const sub = await lockSubscription({
    profileId: args.profileId,
    tier: args.tier,
    billingCountry: args.billingCountry,
    vatCountry: args.vatCountry,
    status: "incomplete",
    billingInterval: args.interval,
    parentSubscriptionId: args.parentSubscriptionId ?? null,
    ...(args.now ? { now: args.now } : {}),
  });
  const amount = periodAmount(sub.price_amount_minor, sub.currency, args.interval);

  // The €49 on the first invoice: a one-time discount line, in the same currency only.
  const [credit] = await db
    .select()
    .from(diagnosisCredits)
    .where(
      and(eq(diagnosisCredits.profile_id, args.profileId), eq(diagnosisCredits.status, "deferred")),
    )
    .limit(1);
  let coupon: string | null = null;
  let creditMinor = 0;
  if (credit && credit.currency !== sub.currency) {
    // Never converted (rule 1): a person settles it.
    await db
      .update(diagnosisCredits)
      .set({ status: "needs_review", subscription_id: sub.id })
      .where(eq(diagnosisCredits.id, credit.id));
  } else if (credit) {
    creditMinor = Math.min(credit.amount_minor, amount);
    const c = await stripe(
      "coupons",
      new URLSearchParams({
        amount_off: String(creditMinor),
        currency: sub.currency.toLowerCase(),
        duration: "once",
        max_redemptions: "1",
        name: "Your diagnosis, credited",
      }),
    );
    coupon = String(c.id);
    await db
      .update(diagnosisCredits)
      .set({ subscription_id: sub.id, stripe_coupon_id: coupon })
      .where(eq(diagnosisCredits.id, credit.id));
  }

  const params = new URLSearchParams({
    mode: "subscription",
    success_url: `${args.appUrl}/billing?checkout=success`,
    cancel_url: `${args.appUrl}/billing?checkout=cancelled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": sub.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(amount),
    "line_items[0][price_data][recurring][interval]": args.interval,
    "line_items[0][price_data][product_data][name]": TIER_NAMES[args.tier] ?? "SYB",
    "payment_method_types[0]": "card",
    "metadata[subscription_id]": sub.id,
    "subscription_data[metadata][subscription_id]": sub.id,
  });
  // §8.5: SEPA Direct Debit alongside cards, where the money is in euro.
  if (sub.currency === "EUR") params.set("payment_method_types[1]", "sepa_debit");
  if (coupon) params.set("discounts[0][coupon]", coupon);
  const session = await stripe("checkout/sessions", params);
  if (typeof session.url !== "string" || typeof session.id !== "string") {
    throw new PaymentError("could not start the payment", 502);
  }
  await db
    .update(subscriptions)
    .set({ checkout_session_id: session.id })
    .where(eq(subscriptions.id, sub.id));
  return { checkout_url: session.url, subscription_id: sub.id, credit_minor: creditMinor };
}

// ── The webhook's subscription events ────────────────────────────────────

const STATUS: Record<string, string> = {
  active: "active",
  trialing: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  paused: "paused",
};

export interface StripeEvent {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

async function rowByStripe(
  stripeSubscriptionId: unknown,
  metadataId: unknown,
): Promise<Sub | null> {
  if (typeof stripeSubscriptionId === "string" && stripeSubscriptionId !== "") {
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.stripe_subscription_id, stripeSubscriptionId),
          ne(subscriptions.status, "canceled"),
        ),
      );
    if (row) return row;
  }
  if (typeof metadataId === "string" && /^[0-9a-f-]{36}$/.test(metadataId)) {
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, metadataId));
    if (row) return row;
  }
  return null;
}

const unix = (v: unknown) => (typeof v === "number" ? new Date(v * 1000).toISOString() : null);

/**
 * One verified Stripe event, applied once. Returns what it did, for the log.
 * Unknown types are acknowledged and ignored, like the report webhook.
 */
export async function handleBillingEvent(event: StripeEvent, now = new Date()): Promise<string> {
  const type = event.type ?? "";
  const obj = event.data?.object ?? {};
  if (
    !/^(checkout\.session\.completed|customer\.subscription\.|invoice\.(paid|payment_failed))/.test(
      type,
    )
  ) {
    return "ignored";
  }
  if (typeof event.id === "string") {
    const fresh = await db
      .insert(billingEvents)
      .values({ stripe_event_id: event.id, type })
      .onConflictDoNothing()
      .returning({ id: billingEvents.stripe_event_id });
    if (fresh.length === 0) return "duplicate";
  }
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;

  if (type === "checkout.session.completed") {
    if (obj.mode !== "subscription") return "ignored";
    const row = await rowByStripe(null, meta.subscription_id);
    if (!row) return "unknown";
    await db
      .update(subscriptions)
      .set({
        stripe_customer_id:
          typeof obj.customer === "string" ? obj.customer : row.stripe_customer_id,
        stripe_subscription_id:
          typeof obj.subscription === "string" ? obj.subscription : row.stripe_subscription_id,
      })
      .where(eq(subscriptions.id, row.id));
    return "linked";
  }

  if (type.startsWith("customer.subscription.")) {
    const row = await rowByStripe(obj.id, meta.subscription_id);
    if (!row) return "unknown";
    const items =
      (obj.items as { data?: { current_period_end?: number }[] } | undefined)?.data ?? [];
    const status =
      type === "customer.subscription.deleted"
        ? "canceled"
        : (STATUS[String(obj.status)] ?? row.status);
    await db
      .update(subscriptions)
      .set({
        status,
        stripe_subscription_id: typeof obj.id === "string" ? obj.id : row.stripe_subscription_id,
        stripe_customer_id:
          typeof obj.customer === "string" ? obj.customer : row.stripe_customer_id,
        current_period_end:
          unix(obj.current_period_end ?? items[0]?.current_period_end) ?? row.current_period_end,
        cancel_at_period_end: obj.cancel_at_period_end === true,
        past_due_since:
          status === "past_due"
            ? (row.past_due_since ?? now.toISOString())
            : status === "active"
              ? null
              : row.past_due_since,
        canceled_at:
          status === "canceled" ? (row.canceled_at ?? now.toISOString()) : row.canceled_at,
      })
      .where(eq(subscriptions.id, row.id));
    if (status === "canceled" && row.status !== "canceled") {
      await notify(row.profile_id, "subscription_ended", { tier: row.tier });
    }
    return status;
  }

  if (type === "invoice.payment_failed") {
    const row = await rowByStripe(
      obj.subscription ??
        (obj.parent as { subscription_details?: { subscription?: string } } | undefined)
          ?.subscription_details?.subscription,
      null,
    );
    if (!row) return "unknown";
    if (!row.past_due_since) {
      await db
        .update(subscriptions)
        .set({ past_due_since: now.toISOString() })
        .where(eq(subscriptions.id, row.id));
    }
    // §8.5 dunning: tell the owner, with the card-update path; Stripe retries on its schedule.
    await notify(row.profile_id, "payment_failed", {
      attempt: typeof obj.attempt_count === "number" ? obj.attempt_count : null,
      next_attempt: unix(obj.next_payment_attempt),
      update_card: "/billing",
    });
    return "dunning";
  }

  // invoice.paid: the first one carries the diagnosis credit.
  const row = await rowByStripe(
    obj.subscription ??
      (obj.parent as { subscription_details?: { subscription?: string } } | undefined)
        ?.subscription_details?.subscription,
    null,
  );
  if (!row) return "unknown";
  if (obj.billing_reason === "subscription_create") {
    await db
      .update(diagnosisCredits)
      .set({
        status: "applied",
        applied_invoice_id: typeof obj.id === "string" ? obj.id : null,
        applied_at: now.toISOString(),
      })
      .where(
        and(eq(diagnosisCredits.subscription_id, row.id), eq(diagnosisCredits.status, "deferred")),
      );
  }
  return "paid";
}

// ── Cancelling, downgrading, the card ────────────────────────────────────

async function requireLive(profileId: string): Promise<Sub & { stripe_subscription_id: string }> {
  const sub = await liveSubscriptionOf(profileId);
  if (!sub || !sub.stripe_subscription_id)
    throw new PaymentError("this business has no plan to change", 404);
  return sub as Sub & { stripe_subscription_id: string };
}

/** §8.5: a cancel ends at the period's end; nothing is cut off mid-month. */
export async function cancelSubscription(
  profileId: string,
  reason: string | null,
  stripe: StripeCall = liveStripe(),
) {
  const sub = await requireLive(profileId);
  await stripe(
    `subscriptions/${sub.stripe_subscription_id}`,
    new URLSearchParams({ cancel_at_period_end: "true" }),
  );
  await db
    .update(subscriptions)
    .set({ cancel_at_period_end: true })
    .where(eq(subscriptions.id, sub.id));
  await notify(profileId, "subscription_cancelling", { ends_at: sub.current_period_end, reason });
  return { ends_at: sub.current_period_end };
}

/**
 * §8.5: offered before cancelling. The price lock covers the tier, so the
 * current row closes and a new one is locked at Watch's price; the same
 * Stripe subscription moves to it from the next invoice.
 */
export async function downgradeToWatch(
  profileId: string,
  stripe: StripeCall = liveStripe(),
  now = new Date(),
) {
  const sub = await requireLive(profileId);
  if (sub.tier === "watch") throw new PaymentError("this plan is already Watch", 409);
  if (sub.tier === "extra_business")
    throw new PaymentError("an extra business follows its parent's plan", 409);
  const current = await stripe(`subscriptions/${sub.stripe_subscription_id}`, undefined, "GET");
  const itemId = ((current.items as { data?: { id?: string }[] } | undefined)?.data ?? [])[0]?.id;
  if (!itemId) throw new PaymentError("the plan couldn't be read", 502);

  await db
    .update(subscriptions)
    .set({ status: "canceled", canceled_at: now.toISOString() })
    .where(eq(subscriptions.id, sub.id));
  const watch = await lockSubscription({
    profileId,
    tier: "watch",
    billingCountry: sub.billing_country,
    vatCountry: sub.vat_country,
    status: "active",
    billingInterval: sub.billing_interval === "year" ? "year" : "month",
    stripe: { customer: sub.stripe_customer_id, subscription: sub.stripe_subscription_id },
    now,
  });
  const amount = periodAmount(
    watch.price_amount_minor,
    watch.currency,
    watch.billing_interval === "year" ? "year" : "month",
  );
  await stripe(
    `subscriptions/${sub.stripe_subscription_id}`,
    new URLSearchParams({
      "items[0][id]": itemId,
      "items[0][price_data][currency]": watch.currency.toLowerCase(),
      "items[0][price_data][unit_amount]": String(amount),
      "items[0][price_data][recurring][interval]": watch.billing_interval,
      "items[0][price_data][product]": String(
        (current.items as { data: { price?: { product?: string } }[] }).data[0]?.price?.product ??
          "",
      ),
      proration_behavior: "none",
      "metadata[subscription_id]": watch.id,
    }),
  );
  await notify(profileId, "plan_downgraded", { from: sub.tier, to: "watch" });
  return { tier: "watch" as const, subscription_id: watch.id };
}

/** The card and invoices, in Stripe's own billing portal (§8.5's card-update prompt). */
export async function billingPortal(
  profileId: string,
  returnUrl: string,
  stripe: StripeCall = liveStripe(),
) {
  const sub = await liveSubscriptionOf(profileId);
  if (!sub?.stripe_customer_id) throw new PaymentError("this business has no plan yet", 404);
  const s = await stripe(
    "billing_portal/sessions",
    new URLSearchParams({ customer: sub.stripe_customer_id, return_url: returnUrl }),
  );
  return { url: String(s.url) };
}

/** After a dormant pause: billing starts again when the owner says so. */
export async function resumeBilling(profileId: string, stripe: StripeCall = liveStripe()) {
  const sub = await requireLive(profileId);
  if (sub.status !== "paused") throw new PaymentError("billing isn't paused", 409);
  await stripe(
    `subscriptions/${sub.stripe_subscription_id}`,
    new URLSearchParams({ pause_collection: "" }),
  );
  await db
    .update(subscriptions)
    .set({ status: "active", paused_reason: null })
    .where(eq(subscriptions.id, sub.id));
  return { status: "active" as const };
}

// ── §8.5: dormant businesses stop being billed ───────────────────────────

/** Days of silence from every connected measuring connector before billing pauses. */
export const DORMANT_DAYS = 45;

export async function runDormantCheck(
  now = new Date(),
  stripe: StripeCall = liveStripe(),
): Promise<{ checked: number; paused: number }> {
  const live = await db.select().from(subscriptions).where(eq(subscriptions.status, "active"));
  const cutoff = new Date(now.getTime() - DORMANT_DAYS * 86_400_000).toISOString().slice(0, 10);
  let paused = 0;
  for (const sub of live) {
    if (!sub.stripe_subscription_id) continue;
    let accountId: string | null = null;
    try {
      const [p] = await db
        .select({ account: businessProfiles.account_id })
        .from(businessProfiles)
        .where(eq(businessProfiles.id, sub.profile_id));
      if (!p) continue;
      accountId = p.account;
      const conns = await db
        .select({ id: connections.id })
        .from(connections)
        .where(
          and(
            eq(connections.account_id, p.account),
            eq(connections.purpose, "measure"),
            eq(connections.status, "connected"),
          ),
        );
      // Silence only counts where something was listening; a broken connector is a connector problem.
      if (conns.length === 0) continue;
      const [last] = await db
        .select({ day: max(metricObservations.period_date) })
        .from(metricObservations)
        .where(
          inArray(
            metricObservations.connection_id,
            conns.map((c) => c.id),
          ),
        );
      if (!last?.day || last.day >= cutoff) continue;
      await stripe(
        `subscriptions/${sub.stripe_subscription_id}`,
        new URLSearchParams({ "pause_collection[behavior]": "void" }),
      );
      await db
        .update(subscriptions)
        .set({ status: "paused", paused_reason: "dormant" })
        .where(eq(subscriptions.id, sub.id));
      await notify(sub.profile_id, "billing_paused_dormant", {
        last_data: last.day,
        days: DORMANT_DAYS,
      });
      paused++;
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "dormant_check_failed",
          account_id: accountId,
          subscription_id: sub.id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return { checked: live.length, paused };
}
