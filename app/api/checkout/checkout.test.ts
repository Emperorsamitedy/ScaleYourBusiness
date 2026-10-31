// I-52a — one bill for several businesses, through the real route.
//
// What must hold, with real sessions through the real door (only
// next/headers' cookie jar is stood in) and Stripe's API stubbed:
//   · GET offers only the person's OTHER businesses where they are an
//     owner and the report isn't paid for. Never a business they manage
//     or view, never someone else's.
//   · POST { also } puts this business at the report price and each added
//     one at the extra price into ONE Stripe Checkout Session, with one
//     pending row per business under the same session id.
//   · An id the person doesn't own, or one already paid, is refused before
//     Stripe is called. A manager can't pay at all.
//   · The verified webhook marks every business of the session paid, once.

import "dotenv/config";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import { payments, users } from "../../../db/schema";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../../../lib/auth/access";
import type { Role } from "../../../lib/auth/roles";
import { openSession } from "../../../lib/auth/service";
import { bootstrapIntake } from "../../../lib/intake/service";
import { hasPaidReport } from "../../../lib/payments/stripe";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const { GET, POST } = await import("./route");
const { POST: webhook } = await import("../stripe/webhook/route");

const WEBHOOK_SECRET = "whsec_bill_test";
let stripeCalls: URLSearchParams[] = [];

beforeEach(() => {
  stripeCalls = [];
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_bill");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("REPORT_PRICE_MINOR", "");
  vi.stubEnv("EXTRA_REPORT_PRICE_MINOR", "");
  vi.stubEnv("REPORT_CURRENCY", "");
  vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
    if (!String(url).startsWith("https://api.stripe.com/v1/checkout/sessions")) {
      throw new Error(`no real network in tests: ${url}`);
    }
    stripeCalls.push(new URLSearchParams(init.body));
    const id = `cs_test_${crypto.randomUUID().replace(/-/g, "")}`;
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/${id}` }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function business() {
  return bootstrapIntake();
}

async function member(accountId: string, email: string, role: Role) {
  const [u] = await db
    .insert(users)
    .values({ account_id: accountId, email, display_name: "bill", role })
    .returning();
  if (!u) throw new Error("fixture user");
  return (await openSession(u)).session_token;
}

function signInAs(token: string, profileId: string) {
  jar.clear();
  jar.set(AUTH_COOKIE, token);
  jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
}

const post = (body: unknown) =>
  new NextRequest("http://localhost:3000/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });

/** One person, owner of A and B, manager of C; D is someone else's. */
async function world() {
  const email = `bill-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const a = await business();
  const b = await business();
  const c = await business();
  const d = await business();
  const token = await member(a.account_id, email, "owner");
  await member(b.account_id, email, "owner");
  await member(c.account_id, `boss-${email}`, "owner");
  await member(c.account_id, email, "manager");
  await member(d.account_id, `other-${email}`, "owner");
  signInAs(token, a.profile_id);
  return { email, token, a, b, c, d };
}

describe("I-52a — the businesses offered", () => {
  it("lists only the person's other owned, unpaid businesses, with both prices", async () => {
    const { b } = await world();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      price: unknown;
      extra_price: unknown;
      others: { profile_id: string }[];
    };
    expect(body.price).toEqual({ amount_minor: 4900, currency: "eur" });
    expect(body.extra_price).toEqual({ amount_minor: 2900, currency: "eur" });
    expect(body.others.map((o) => o.profile_id)).toEqual([b.profile_id]);
  });

  it("leaves out a business already paid for", async () => {
    const { b } = await world();
    await db.insert(payments).values({
      account_id: b.account_id,
      profile_id: b.profile_id,
      checkout_session_id: `cs_paid_${crypto.randomUUID()}`,
      amount_minor: 4900,
      currency: "eur",
      status: "paid",
    });
    const body = (await (await GET()).json()) as { others: unknown[] };
    expect(body.others).toEqual([]);
  });
});

describe("I-52a — one checkout, several businesses", () => {
  it("one session: this business in full, the added one at the extra price", async () => {
    const { a, b } = await world();
    const res = await POST(post({ also: [b.profile_id] }));
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      checkout_session_id: string;
      amount_minor: number;
      businesses: number;
    };
    expect(out).toMatchObject({ amount_minor: 7800, businesses: 2 });
    expect(stripeCalls).toHaveLength(1);
    const p = stripeCalls[0]!;
    expect(p.get("mode")).toBe("payment");
    expect(p.get("line_items[0][price_data][unit_amount]")).toBe("4900");
    expect(p.get("line_items[1][price_data][unit_amount]")).toBe("2900");
    expect(p.get("line_items[1][price_data][currency]")).toBe("eur");
    expect(p.get("line_items[2][price_data][unit_amount]")).toBeNull();
    const rows = await db
      .select()
      .from(payments)
      .where(eq(payments.checkout_session_id, out.checkout_session_id));
    expect(
      rows
        .map((r) => [r.profile_id, r.amount_minor, r.status])
        .sort((x, y) => Number(x[1]) - Number(y[1])),
    ).toEqual([
      [b.profile_id, 2900, "pending"],
      [a.profile_id, 4900, "pending"],
    ]);
    expect(rows.find((r) => r.profile_id === b.profile_id)?.account_id).toBe(b.account_id);

    // The verified webhook pays for both, once.
    const event = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: out.checkout_session_id, payment_status: "paid" } },
    });
    const sign = (body: string) => {
      const t = Math.floor(Date.now() / 1000);
      return `t=${t},v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${body}`).digest("hex")}`;
    };
    const deliver = () =>
      webhook(
        new NextRequest("http://localhost:3000/api/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": sign(event) },
          body: event,
        }),
      );
    expect((await deliver()).status).toBe(200);
    expect(await hasPaidReport(a.profile_id)).toBe(true);
    expect(await hasPaidReport(b.profile_id)).toBe(true);
    const paidAt = (
      await db
        .select()
        .from(payments)
        .where(eq(payments.checkout_session_id, out.checkout_session_id))
    ).map((r) => r.paid_at);
    expect((await deliver()).status).toBe(200);
    const again = (
      await db
        .select()
        .from(payments)
        .where(eq(payments.checkout_session_id, out.checkout_session_id))
    ).map((r) => r.paid_at);
    expect(again).toEqual(paidAt);
  });

  it("an empty body is the one-business checkout, as before", async () => {
    await world();
    const res = await POST(
      new NextRequest("http://localhost:3000/api/checkout", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ amount_minor: 4900, businesses: 1 });
    expect(stripeCalls[0]!.get("line_items[1][price_data][unit_amount]")).toBeNull();
  });

  it("refuses someone else's business, one they only manage, and this one again, before Stripe", async () => {
    const { a, c, d } = await world();
    for (const id of [d.profile_id, c.profile_id, a.profile_id, crypto.randomUUID()]) {
      const res = await POST(post({ also: [id] }));
      expect(res.status, id).toBe(403);
    }
    expect((await POST(post({ also: "nope" }))).status).toBe(400);
    expect(stripeCalls).toHaveLength(0);
  });

  it("a manager can't pay, or see what's offered", async () => {
    const { email, c } = await world();
    const managerRow = (
      await db.select().from(users).where(eq(users.account_id, c.account_id))
    ).find((u) => u.email === email)!;
    signInAs((await openSession(managerRow)).session_token, c.profile_id);
    expect((await GET()).status).toBe(403);
    expect((await POST(post({}))).status).toBe(403);
    expect(stripeCalls).toHaveLength(0);
  });
});
