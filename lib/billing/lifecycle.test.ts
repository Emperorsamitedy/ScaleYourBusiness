// P7-71..73 — tiers, the €49 credit, the Stripe lifecycle (v1 spec §8.1,
// §8.3, §8.5, §8.6). Stripe is a recording stub: nothing leaves the test.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  billingEvents,
  businessProfiles,
  connections,
  diagnosisCredits,
  fieldRecords,
  intakeEvents,
  metricObservations,
  ownerNotices,
  payments,
  subscriptions,
} from "../../db/schema";
import { upsertObservations } from "../connectors/service";
import { bootstrapIntake } from "../intake/service";
import { stationCeiling } from "../ladder/ladder";
import { ANNUAL_DISCOUNT_BP, periodAmount, planPrices } from "./plans";
import type { StripeCall } from "./subscribe";
import {
  DORMANT_DAYS,
  cancelSubscription,
  deferDiagnosisCredits,
  downgradeToWatch,
  handleBillingEvent,
  runDormantCheck,
  startSubscription,
} from "./subscribe";

/** A Stripe that records every call and answers like Stripe would. */
function stubStripe() {
  const calls: { path: string; params: Record<string, string>; method: string }[] = [];
  const call: StripeCall = async (path, params, method = "POST") => {
    calls.push({ path, params: Object.fromEntries(params ?? []), method });
    if (path === "coupons") return { id: `coupon_${calls.length}` };
    if (path === "checkout/sessions")
      return { id: `cs_${randomUUID()}`, url: "https://checkout.stripe.test/x" };
    if (path.startsWith("subscriptions/") && method === "GET") {
      return { items: { data: [{ id: "si_1", price: { product: "prod_1" } }] } };
    }
    return { id: `obj_${calls.length}` };
  };
  return { calls, call };
}

const created: { account_id: string; profile_id: string }[] = [];
const key = process.env.STRIPE_SECRET_KEY;
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_stub"; // armed, so the tier ceiling applies
});
afterEach(() => {
  if (key === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = key;
});
afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(diagnosisCredits).where(inArray(diagnosisCredits.profile_id, ids));
  await db.delete(ownerNotices).where(inArray(ownerNotices.profile_id, ids));
  await db.delete(payments).where(inArray(payments.profile_id, ids));
  await db.delete(subscriptions).where(inArray(subscriptions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

/** A paid €49 diagnosis for this business, as the report webhook leaves it. */
async function paidDiagnosis(
  s: { account_id: string; profile_id: string },
  amount = 4_900,
  currency = "EUR",
) {
  const session = `cs_${randomUUID()}`;
  await db.insert(payments).values({
    account_id: s.account_id,
    profile_id: s.profile_id,
    checkout_session_id: session,
    amount_minor: amount,
    currency,
    status: "paid",
    paid_at: new Date().toISOString(),
  });
  expect(await deferDiagnosisCredits(session)).toBe(1);
  expect(await deferDiagnosisCredits(session)).toBe(0); // once per payment
  return session;
}

const event = (type: string, object: Record<string, unknown>) => ({
  id: `evt_${randomUUID()}`,
  type,
  data: { object },
});

async function subscribe(
  s: { profile_id: string },
  tier: "watch" | "act" | "autonomous",
  interval: "month" | "year" = "month",
) {
  const stripe = stubStripe();
  const started = await startSubscription({
    profileId: s.profile_id,
    tier,
    interval,
    billingCountry: "PT",
    vatCountry: "PT",
    appUrl: "https://app.test",
    stripe: stripe.call,
  });
  const stripeSub = `sub_${randomUUID()}`;
  await handleBillingEvent(
    event("checkout.session.completed", {
      mode: "subscription",
      customer: "cus_1",
      subscription: stripeSub,
      metadata: { subscription_id: started.subscription_id },
    }),
  );
  await handleBillingEvent(
    event("customer.subscription.created", {
      id: stripeSub,
      status: "active",
      customer: "cus_1",
      current_period_end: 1_800_000_000,
      metadata: { subscription_id: started.subscription_id },
    }),
  );
  return { ...started, stripeSub, stripe };
}

describe("§8.3 — tiers from the price book; annual at 20 % off", () => {
  it("Watch €49, Act €149, Autonomous €299, extra business €29; a year is 12 × 0.8 on the price step", async () => {
    const prices = await planPrices("PT");
    expect(prices.map((p) => [p.tier, p.monthly_minor, p.ceiling, p.guarantee])).toEqual([
      ["watch", 4_900, 2, false],
      ["act", 14_900, 3, false],
      ["autonomous", 29_900, 4, true],
      ["extra_business", 2_900, null, false],
    ]);
    expect(ANNUAL_DISCOUNT_BP).toBe(2_000);
    for (const p of prices)
      expect(p.yearly_minor).toBe(periodAmount(p.monthly_minor, "EUR", "year"));
    expect(periodAmount(29_900, "EUR", "year")).toBeLessThanOrEqual(29_900 * 12 * 0.8 + 100);
    expect(periodAmount(29_900, "EUR", "year")).toBeGreaterThanOrEqual(29_900 * 12 * 0.8 - 100);
  });
});

describe("§8.1 / §8.6 — the €49 is a credit line on the first invoice, not revenue", () => {
  it("defers the paid diagnosis, puts it on the first invoice as a one-time credit, and marks it applied when paid", async () => {
    const s = await business();
    await paidDiagnosis(s);
    const sub = await subscribe(s, "act");
    expect(sub.credit_minor).toBe(4_900);
    const coupon = sub.stripe.calls.find((c) => c.path === "coupons")!;
    expect(coupon.params).toMatchObject({
      amount_off: "4900",
      currency: "eur",
      duration: "once",
      max_redemptions: "1",
      name: "Your diagnosis, credited",
    });
    const checkout = sub.stripe.calls.find((c) => c.path === "checkout/sessions")!;
    expect(checkout.params).toMatchObject({
      mode: "subscription",
      "line_items[0][price_data][unit_amount]": "14900",
      "line_items[0][price_data][recurring][interval]": "month",
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "sepa_debit", // §8.5: SEPA alongside cards, for euro
      "discounts[0][coupon]": coupon && "coupon_1",
    });
    // Deferred until the first invoice is paid…
    let [credit] = await db
      .select()
      .from(diagnosisCredits)
      .where(eq(diagnosisCredits.profile_id, s.profile_id));
    expect(credit).toMatchObject({ status: "deferred", subscription_id: sub.subscription_id });
    await handleBillingEvent(
      event("invoice.paid", {
        id: "in_1",
        subscription: sub.stripeSub,
        billing_reason: "subscription_create",
      }),
    );
    [credit] = await db
      .select()
      .from(diagnosisCredits)
      .where(eq(diagnosisCredits.profile_id, s.profile_id));
    expect(credit).toMatchObject({ status: "applied", applied_invoice_id: "in_1" });
  });

  it("a credit in another currency is never converted: it waits for a person", async () => {
    const s = await business();
    await paidDiagnosis(s, 1_150_000, "HUF");
    const sub = await subscribe(s, "watch");
    expect(sub.credit_minor).toBe(0);
    expect(sub.stripe.calls.some((c) => c.path === "coupons")).toBe(false);
    const [credit] = await db
      .select()
      .from(diagnosisCredits)
      .where(eq(diagnosisCredits.profile_id, s.profile_id));
    expect(credit?.status).toBe("needs_review");
  });
});

describe("§8.6 — no station above the tier's ceiling", () => {
  it("Watch caps at 2, Act at 3, Autonomous at 4; an extra business follows its parent", async () => {
    const w = await business();
    await subscribe(w, "watch");
    expect(await stationCeiling(w.profile_id)).toBe(2);
    const a = await business();
    const parent = await subscribe(a, "autonomous");
    const extra = await business();
    const started = await startSubscription({
      profileId: extra.profile_id,
      tier: "extra_business",
      interval: "month",
      billingCountry: "PT",
      vatCountry: "PT",
      appUrl: "https://app.test",
      parentSubscriptionId: parent.subscription_id,
      stripe: stubStripe().call,
    });
    await handleBillingEvent(
      event("customer.subscription.created", {
        id: `sub_${randomUUID()}`,
        status: "active",
        metadata: { subscription_id: started.subscription_id },
      }),
    );
    expect(await stationCeiling(extra.profile_id)).toBeLessThanOrEqual(4);
    expect(await stationCeiling(extra.profile_id)).toBe(await stationCeiling(a.profile_id));
  });
});

describe("§8.5 — the lifecycle: once each, dunning, cancellation, dormant", () => {
  it("an event delivered twice changes nothing the second time", async () => {
    const s = await business();
    const sub = await subscribe(s, "watch");
    const e = event("customer.subscription.updated", { id: sub.stripeSub, status: "past_due" });
    expect(await handleBillingEvent(e)).toBe("past_due");
    expect(await handleBillingEvent(e)).toBe("duplicate");
    await db.delete(billingEvents).where(eq(billingEvents.stripe_event_id, e.id));
  });

  it("a failed payment tells the owner, with the way to update the card, and marks it past due", async () => {
    const s = await business();
    const sub = await subscribe(s, "act");
    expect(
      await handleBillingEvent(
        event("invoice.payment_failed", {
          subscription: sub.stripeSub,
          attempt_count: 1,
          next_payment_attempt: 1_800_100_000,
        }),
      ),
    ).toBe("dunning");
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.subscription_id));
    expect(row?.past_due_since).not.toBeNull();
    const [notice] = await db
      .select()
      .from(ownerNotices)
      .where(
        and(eq(ownerNotices.profile_id, s.profile_id), eq(ownerNotices.kind, "payment_failed")),
      );
    expect(notice?.payload).toMatchObject({ attempt: 1, update_card: "/billing" });
  });

  it("downgrade to Watch is offered first: the old row closes, Watch is locked, Stripe moves", async () => {
    const s = await business();
    const sub = await subscribe(s, "autonomous");
    const stripe = stubStripe();
    const d = await downgradeToWatch(s.profile_id, stripe.call);
    expect(d.tier).toBe("watch");
    const rows = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.profile_id, s.profile_id));
    expect(rows.find((r) => r.id === sub.subscription_id)?.status).toBe("canceled");
    expect(rows.find((r) => r.id === d.subscription_id)).toMatchObject({
      tier: "watch",
      status: "active",
      stripe_subscription_id: sub.stripeSub,
    });
    expect(stripe.calls.at(-1)?.params).toMatchObject({
      "items[0][id]": "si_1",
      "items[0][price_data][unit_amount]": "4900",
    });
    expect(await stationCeiling(s.profile_id)).toBe(2);
  });

  it("a cancel ends at the period's end", async () => {
    const s = await business();
    await subscribe(s, "watch");
    const stripe = stubStripe();
    await cancelSubscription(s.profile_id, "too expensive", stripe.call);
    expect(stripe.calls[0]?.params).toEqual({ cancel_at_period_end: "true" });
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.profile_id, s.profile_id), eq(subscriptions.status, "active")));
    expect(row?.cancel_at_period_end).toBe(true);
  });

  it("a business whose connectors have gone silent stops being billed, and is told", async () => {
    const s = await business();
    await subscribe(s, "watch");
    const [conn] = await db
      .insert(connections)
      .values({
        account_id: s.account_id,
        provider: "fixture",
        purpose: "measure",
        status: "connected",
        granted_scopes: ["read_revenue"],
      })
      .returning({ id: connections.id });
    const now = new Date("2027-03-01T00:00:00Z");
    const old = new Date(now.getTime() - (DORMANT_DAYS + 5) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await upsertObservations(conn!.id, "fixture", [
      {
        metric_key: "revenue.daily",
        dimensions: { currency: "EUR" },
        value_minor: 1_000,
        period_date: old,
        observed_at: `${old}T23:00:00.000Z`,
      },
    ]);
    const stripe = stubStripe();
    await runDormantCheck(now, stripe.call);
    const [row] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.profile_id, s.profile_id));
    expect(row).toMatchObject({ status: "paused", paused_reason: "dormant" });
    expect(
      stripe.calls.find((c) => c.params["pause_collection[behavior]"] === "void"),
    ).toBeTruthy();
  });
});
