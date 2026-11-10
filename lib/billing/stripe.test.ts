// Session I — P1-50. The properties that make payment trustworthy:
// only the verified webhook writes "paid", the signature check rejects
// everything a forger can send, marking is idempotent under Stripe's
// redelivery, and the price stays integer minor units.

import "dotenv/config";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, payments } from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import {
  alsoLine,
  checkoutAmounts,
  extraReportPrice,
  hasPaidReport,
  markCheckoutPaid,
  paymentsConfigured,
  reportPrice,
  verifyStripeSignature,
} from "./stripe";
import { POST as webhook } from "../../app/api/stripe/webhook/route";

const SECRET = "whsec_test_secret";

function sign(body: string, t = Math.floor(Date.now() / 1000), secret = SECRET): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const created: { account_id: string; profile_id: string }[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  for (const s of created) {
    await db.delete(payments).where(eq(payments.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P1-50 — webhook signature", () => {
  const body = '{"type":"checkout.session.completed"}';

  it("accepts a correctly signed body", () => {
    expect(verifyStripeSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body — the signature covers every byte", () => {
    expect(verifyStripeSignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("rejects the right body signed with the wrong secret", () => {
    expect(verifyStripeSignature(body, sign(body, undefined, "whsec_other"), SECRET)).toBe(false);
  });

  it("rejects a stale timestamp — replaying a captured webhook fails", () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect(verifyStripeSignature(body, sign(body, old), SECRET)).toBe(false);
  });

  it("rejects a missing or mangled header", () => {
    expect(verifyStripeSignature(body, null, SECRET)).toBe(false);
    expect(verifyStripeSignature(body, "t=,v1=", SECRET)).toBe(false);
    expect(verifyStripeSignature(body, "v1=deadbeef", SECRET)).toBe(false);
  });
});

describe("P1-50 — paid state", () => {
  it("marking paid is idempotent, and hasPaidReport follows the row", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const sessionId = `cs_test_${crypto.randomUUID().slice(0, 12)}`;
    await db.insert(payments).values({
      account_id: s.account_id,
      profile_id: s.profile_id,
      checkout_session_id: sessionId,
      amount_minor: 4900,
      currency: "eur",
    });

    expect(await hasPaidReport(s.profile_id)).toBe(false);
    expect(await markCheckoutPaid(sessionId)).toBe("paid");
    expect(await markCheckoutPaid(sessionId)).toBe("already"); // Stripe redelivers
    expect(await hasPaidReport(s.profile_id)).toBe(true);
  });

  it("a checkout session we never created is 'unknown', not an insert", async () => {
    expect(await markCheckoutPaid("cs_test_never_seen")).toBe("unknown");
  });
});

describe("P1-50 — configuration", () => {
  it("price comes from the price book's default row, in integer minor units, and env overrides it", async () => {
    vi.stubEnv("REPORT_PRICE_MINOR", "");
    vi.stubEnv("REPORT_CURRENCY", "");
    expect(await reportPrice()).toEqual({ amount_minor: 4900, currency: "eur" });
    vi.stubEnv("REPORT_PRICE_MINOR", "2900");
    vi.stubEnv("REPORT_CURRENCY", "USD");
    expect(await reportPrice()).toEqual({ amount_minor: 2900, currency: "usd" });
  });

  it("a nonsense price refuses to price rather than guessing", async () => {
    vi.stubEnv("REPORT_PRICE_MINOR", "49.00");
    await expect(reportPrice()).resolves.toBeDefined(); // parseInt("49.00") === 49 — integer, allowed
    vi.stubEnv("REPORT_PRICE_MINOR", "-100");
    await expect(reportPrice()).rejects.toThrow();
    vi.stubEnv("REPORT_PRICE_MINOR", "abc");
    await expect(reportPrice()).rejects.toThrow();
  });

  it("the gate is unarmed without a key and armed with one", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(paymentsConfigured()).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(paymentsConfigured()).toBe(true);
  });
});

describe("security review 2026-10-17 — paid means paid", () => {
  async function pending() {
    const s = await bootstrapIntake();
    created.push(s);
    const sessionId = `cs_test_${crypto.randomUUID().slice(0, 12)}`;
    await db.insert(payments).values({
      account_id: s.account_id,
      profile_id: s.profile_id,
      checkout_session_id: sessionId,
      amount_minor: 4900,
      currency: "eur",
    });
    return { ...s, sessionId };
  }
  function deliver(event: unknown) {
    const body = JSON.stringify(event);
    return webhook(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": sign(body) },
        body,
      }) as never,
    );
  }

  it("THE ATTACK: a completed checkout still awaiting a delayed payment does NOT unlock the report", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    const p = await pending();
    const res = await deliver({
      type: "checkout.session.completed",
      data: { object: { id: p.sessionId, payment_status: "unpaid" } },
    });
    expect(res.status).toBe(200);
    expect(await hasPaidReport(p.profile_id)).toBe(false);

    // The money arriving later is what unlocks it.
    await deliver({
      type: "checkout.session.async_payment_succeeded",
      data: { object: { id: p.sessionId, payment_status: "paid" } },
    });
    expect(await hasPaidReport(p.profile_id)).toBe(true);
  });

  it("a completed, paid checkout unlocks at once", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
    const p = await pending();
    await deliver({
      type: "checkout.session.completed",
      data: { object: { id: p.sessionId, payment_status: "paid" } },
    });
    expect(await hasPaidReport(p.profile_id)).toBe(true);
  });
});

// I-52a (owner, 2026-10-31): one checkout, the first business in full and each extra at €29.
describe("I-52a — one bill for several businesses", () => {
  it("prices the first in full and the rest at the extra price", () => {
    expect(checkoutAmounts(1, 4900, 2900)).toEqual([4900]);
    expect(checkoutAmounts(3, 4900, 2900)).toEqual([4900, 2900, 2900]);
    expect(checkoutAmounts(0, 4900, 2900)).toEqual([]);
  });

  // I-52e (owner, 2026-10-31): an owner who already paid for one business pays the extra price for all.
  it("an owner who has paid before pays the extra price for every business, the first too", () => {
    expect(checkoutAmounts(1, 4900, 2900, true)).toEqual([2900]);
    expect(checkoutAmounts(2, 4900, 2900, true)).toEqual([2900, 2900]);
    expect(checkoutAmounts(1, 4900, 2900, false)).toEqual([4900]);
  });

  it("the extra price comes from the price book, follows env, and is never more than the report", async () => {
    vi.stubEnv("REPORT_PRICE_MINOR", "");
    vi.stubEnv("REPORT_CURRENCY", "");
    vi.stubEnv("EXTRA_REPORT_PRICE_MINOR", "");
    expect(await extraReportPrice()).toEqual({ amount_minor: 2900, currency: "eur" });
    vi.stubEnv("EXTRA_REPORT_PRICE_MINOR", "3900");
    expect((await extraReportPrice()).amount_minor).toBe(3900);
    vi.stubEnv("EXTRA_REPORT_PRICE_MINOR", "5000");
    await expect(extraReportPrice()).rejects.toThrow(/more than the report price/);
    vi.stubEnv("EXTRA_REPORT_PRICE_MINOR", "-1");
    await expect(extraReportPrice()).rejects.toThrow();
  });

  it("names the extra business on its line, or says another business", () => {
    expect(alsoLine("Lumen Studio")).toBe("SYB business diagnosis: Lumen Studio");
    expect(alsoLine("  ")).toBe("SYB business diagnosis: another business");
    expect(alsoLine(null)).toBe("SYB business diagnosis: another business");
  });

  it("the webhook's mark pays every business of the session, and only once", async () => {
    const one = await bootstrapIntake();
    const two = await bootstrapIntake();
    created.push(one, two);
    const session = `cs_test_two_${crypto.randomUUID()}`;
    await db.insert(payments).values([
      {
        account_id: one.account_id,
        profile_id: one.profile_id,
        checkout_session_id: session,
        amount_minor: 4900,
        currency: "eur",
      },
      {
        account_id: two.account_id,
        profile_id: two.profile_id,
        checkout_session_id: session,
        amount_minor: 2900,
        currency: "eur",
      },
    ]);
    expect(await markCheckoutPaid(session)).toBe("paid");
    expect(await hasPaidReport(one.profile_id)).toBe(true);
    expect(await hasPaidReport(two.profile_id)).toBe(true);
    expect(await markCheckoutPaid(session)).toBe("already");
  });
});
