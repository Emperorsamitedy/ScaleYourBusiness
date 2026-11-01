// I-54a — /api/bank-statement through the real door (only next/headers'
// cookie jar is stood in). What must hold: an owner, signed in, from SYB's
// own pages imports; a manager, a cross-site request or no sign-in can't;
// GET says the latest balance. And migration 0074 lets a cash_close claim
// onto the track record.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import { forecastChecks, users } from "../../../db/schema";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../../../lib/auth/access";
import type { Role } from "../../../lib/auth/roles";
import { openSession } from "../../../lib/auth/service";
import { recordForecasts } from "../../../lib/forecasts/record";
import { bootstrapIntake } from "../../../lib/intake/service";

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

async function member(accountId: string, role: Role) {
  const email = `bs-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const [u] = await db
    .insert(users)
    .values({ account_id: accountId, email, display_name: "bs", role })
    .returning();
  if (!u) throw new Error("fixture user");
  return (await openSession(u)).session_token;
}

function signInAs(token: string | null, profileId: string) {
  jar.clear();
  if (token) jar.set(AUTH_COOKIE, token);
  jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
}

const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const post = (body: unknown, site = "same-origin") =>
  new NextRequest("http://localhost:3000/api/bank-statement", {
    method: "POST",
    headers: { "content-type": "application/json", "sec-fetch-site": site },
    body: JSON.stringify(body),
  });
const statement = { csv: `Date,Balance\n${yesterday},1234.50`, currency: "EUR" };

describe("I-54a — importing a bank statement", () => {
  it("an owner imports, and GET then says the latest balance", async () => {
    const s = await bootstrapIntake();
    signInAs(await member(s.account_id, "owner"), s.profile_id);
    expect(await (await GET()).json()).toEqual({ latest: null });
    const res = await POST(post(statement));
    expect(res.status).toBe(201);
    expect(await (await GET()).json()).toEqual({
      latest: { day: yesterday, amount_minor: 123_450, currency: "EUR" },
    });
  });

  it("a manager can't import, nor a cross-site request, nor an anonymous intake", async () => {
    const s = await bootstrapIntake();
    await member(s.account_id, "owner");
    signInAs(await member(s.account_id, "manager"), s.profile_id);
    expect((await POST(post(statement))).status).toBe(403);
    const t = await bootstrapIntake();
    signInAs(await member(t.account_id, "owner"), t.profile_id);
    expect((await POST(post(statement, "cross-site"))).status).toBe(403);
    const u = await bootstrapIntake();
    signInAs(null, u.profile_id);
    expect((await POST(post(statement))).status).toBe(401);
  });

  it("a file it can't read is refused in words, and nothing is written", async () => {
    const s = await bootstrapIntake();
    signInAs(await member(s.account_id, "owner"), s.profile_id);
    const res = await POST(post({ csv: "Date,Amount\n2026-10-01,10.00", currency: "EUR" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/balance column/);
    expect(await (await GET()).json()).toEqual({ latest: null });
  });
});

describe("migration 0074", () => {
  it("lets a cash_close claim onto the track record", async () => {
    const s = await bootstrapIntake();
    const written = await recordForecasts([
      {
        account_id: s.account_id,
        profile_id: s.profile_id,
        kind: "cash_close",
        forecast_key: `cash_close|EUR|test|${crypto.randomUUID()}`,
        made_at: new Date().toISOString(),
        subject: "cash in the bank",
        subject_ref: { connection_id: "c" },
        metric: "cash.balance",
        unit: "money",
        window_start: "2026-11-02",
        window_end: "2026-11-08",
        low_minor: -10_000,
        high_minor: 50_000,
        currency: "EUR",
        claim: "test",
        basis: "test",
      },
    ]);
    expect(written).toBe(1);
    const rows = await db
      .select()
      .from(forecastChecks)
      .where(eq(forecastChecks.profile_id, s.profile_id));
    expect(rows[0]?.kind).toBe("cash_close");
  });
});
