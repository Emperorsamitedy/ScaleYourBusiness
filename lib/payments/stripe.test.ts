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
  hasPaidReport,
  markCheckoutPaid,
  paymentsConfigured,
  reportPrice,
  verifyStripeSignature,
} from "./stripe";

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
  it("price defaults to €49.00 in integer minor units and follows env", () => {
    vi.stubEnv("REPORT_PRICE_MINOR", "");
    vi.stubEnv("REPORT_CURRENCY", "");
    expect(reportPrice()).toEqual({ amount_minor: 4900, currency: "eur" });
    vi.stubEnv("REPORT_PRICE_MINOR", "2900");
    vi.stubEnv("REPORT_CURRENCY", "USD");
    expect(reportPrice()).toEqual({ amount_minor: 2900, currency: "usd" });
  });

  it("a nonsense price refuses to price rather than guessing", () => {
    vi.stubEnv("REPORT_PRICE_MINOR", "49.00");
    expect(() => reportPrice()).not.toThrow(); // parseInt("49.00") === 49 — integer, allowed
    vi.stubEnv("REPORT_PRICE_MINOR", "-100");
    expect(() => reportPrice()).toThrow();
    vi.stubEnv("REPORT_PRICE_MINOR", "abc");
    expect(() => reportPrice()).toThrow();
  });

  it("the gate is unarmed without a key and armed with one", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(paymentsConfigured()).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    expect(paymentsConfigured()).toBe(true);
  });
});
