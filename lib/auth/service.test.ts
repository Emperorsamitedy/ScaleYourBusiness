// Session I — P1-49. Auth is a security boundary, so every test states
// the attack it closes: replayed links, expired links, guessing, and a
// database leak (only hashes at rest).

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  fieldRecords,
  loginTokens,
  rateLimits,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { NextRequest } from "next/server";
import { GET as redeemGET, POST as redeemPOST } from "../../app/api/auth/redeem/route";
import { appOriginOf } from "./same-origin";
import {
  AuthError,
  CODE_REFUSED,
  CODE_TOO_MANY,
  codeHash,
  currentSession,
  normaliseCode,
  peekLogin,
  redeemLogin,
  redeemLoginCode,
  requestLogin,
  revokeSession,
} from "./service";

const cleanupEmails: string[] = [];
const cleanupProfiles: { account_id: string; profile_id: string }[] = [];

function testEmail(): string {
  const email = `auth-test-${crypto.randomUUID().slice(0, 8)}@example.com`;
  cleanupEmails.push(email);
  return email;
}

afterAll(async () => {
  for (const email of cleanupEmails) {
    const rows = await db.select().from(users).where(eq(users.email, email));
    for (const u of rows) {
      await db.delete(authSessions).where(eq(authSessions.user_id, u.id));
      await db
        .update(accounts)
        .set({ owner_user_id: null })
        .where(eq(accounts.owner_user_id, u.id));
      await db.delete(users).where(eq(users.id, u.id));
      // L8: a sign-in with no business makes an empty one, which goes here
      // with its account. A business a test made itself is removed below.
      if (!cleanupProfiles.some((s) => s.account_id === u.account_id)) {
        await db.delete(businessProfiles).where(eq(businessProfiles.account_id, u.account_id));
        await db.delete(accounts).where(eq(accounts.id, u.account_id));
      }
    }
    await db.delete(loginTokens).where(eq(loginTokens.email, email));
    await db.delete(rateLimits).where(eq(rateLimits.key, `login:email:${email}:3600000`));
    await db.delete(rateLimits).where(eq(rateLimits.key, `login-code:email:${email}:900000`));
  }
  for (const s of cleanupProfiles) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P1-49 — email + signed link auth", () => {
  it("stores only the hash: a leaked login_tokens row cannot be replayed", async () => {
    const login = await requestLogin(testEmail(), null);
    const rows = await db.select().from(loginTokens).where(eq(loginTokens.email, login.email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(login.token);
    expect(rows[0]?.token_hash).toHaveLength(64); // sha256 hex
  });

  it("redeem claims the anonymous intake: same account, new user, session works", async () => {
    const s = await bootstrapIntake();
    cleanupProfiles.push(s);
    const login = await requestLogin(testEmail(), s.profile_id);
    const redeemed = await redeemLogin(login.token);

    expect(redeemed.account_id).toBe(s.account_id);
    expect(redeemed.profile_id).toBe(s.profile_id);

    const session = await currentSession(redeemed.session_token);
    expect(session?.account_id).toBe(s.account_id);
    expect(session?.email).toBe(login.email);
  });

  it("a login link is one-shot: the second redeem fails", async () => {
    const login = await requestLogin(testEmail(), null);
    await redeemLogin(login.token);
    await expect(redeemLogin(login.token)).rejects.toMatchObject({ status: 401 });
  });

  it("an unknown token fails identically to a used one — nothing to enumerate", async () => {
    await expect(redeemLogin("not-a-real-token")).rejects.toMatchObject({
      status: 401,
      message: "that sign-in link is no longer valid",
    });
  });

  it("logging in again with the same email lands on the same account", async () => {
    const s = await bootstrapIntake();
    cleanupProfiles.push(s);
    const email = testEmail();
    const first = await redeemLogin((await requestLogin(email, s.profile_id)).token);
    // Second device, no intake cookie at all:
    const second = await redeemLogin((await requestLogin(email, null)).token);
    expect(second.account_id).toBe(first.account_id);
    expect(second.profile_id).toBe(s.profile_id);
  });

  it("revoking a session stops it resolving without deleting it", async () => {
    const s = await bootstrapIntake();
    cleanupProfiles.push(s);
    const redeemed = await redeemLogin((await requestLogin(testEmail(), s.profile_id)).token);
    expect(await currentSession(redeemed.session_token)).not.toBeNull();
    await revokeSession(redeemed.session_token);
    expect(await currentSession(redeemed.session_token)).toBeNull();
  });
});

// Login CSRF (security audit 2026-10-17): opening a link only asks; the
// one way in is a POST from our own page.
describe("a sign-in link asks before it signs in", () => {
  const ORIGIN = appOriginOf("http://localhost:3000/");

  function post(token: string, headers: Record<string, string>): NextRequest {
    const body = new URLSearchParams({ token });
    return new NextRequest(`${ORIGIN}/api/auth/redeem`, {
      method: "POST",
      body,
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    });
  }

  it("peeking names the address and leaves the link usable", async () => {
    const login = await requestLogin(testEmail(), null);
    expect(await peekLogin(login.token)).toEqual({ email: login.email });
    expect(await peekLogin(login.token)).toEqual({ email: login.email });
    await redeemLogin(login.token);
    await expect(peekLogin(login.token)).rejects.toMatchObject({ status: 401 });
  });

  it("opening the link (GET) sets no cookie and doesn't burn it — it goes to the confirm page", async () => {
    const login = await requestLogin(testEmail(), null);
    const res = redeemGET(
      new NextRequest(`${ORIGIN}/api/auth/redeem?token=${encodeURIComponent(login.token)}`),
    );
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/login/confirm");
    expect(to.searchParams.get("token")).toBe(login.token);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await peekLogin(login.token)).toEqual({ email: login.email });
  });

  it("an attacker's cross-site form can't sign a victim in, and the link survives", async () => {
    const login = await requestLogin(testEmail(), null);
    for (const headers of [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example" },
      {},
    ]) {
      const res = await redeemPOST(post(login.token, headers));
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(await peekLogin(login.token)).toEqual({ email: login.email });
  });

  it("our own page's POST signs in once", async () => {
    const login = await requestLogin(testEmail(), null);
    const res = await redeemPOST(post(login.token, { "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("set-cookie")).toContain("=");
    const again = await redeemPOST(post(login.token, { origin: ORIGIN }));
    expect(new URL(again.headers.get("location")!).pathname).toBe("/login");
  });
});

describe("security review 2026-11-09 — login requests are rate-limited", () => {
  it("refuses a 6th link for the same address inside an hour, with a 429", async () => {
    const email = testEmail();
    for (let i = 0; i < 5; i++) await requestLogin(email, null);
    await expect(requestLogin(email, null)).rejects.toMatchObject({
      status: 429,
      name: "AuthError",
    });
    // Confirmed as an AuthError, not a generic one: the route maps it to
    // a named 429, the same class of bug /api/chat had before this review.
    await expect(requestLogin(email, null)).rejects.toBeInstanceOf(AuthError);
  });

  it("one address's limit never blocks a different address", async () => {
    const blocked = testEmail();
    for (let i = 0; i < 5; i++) await requestLogin(blocked, null);
    await expect(requestLogin(blocked, null)).rejects.toMatchObject({ status: 429 });
    // A fresh address still gets its link — the limit is per-email, not global.
    await expect(requestLogin(testEmail(), null)).resolves.toMatchObject({
      email: expect.any(String),
    });
  });
});

describe("2026-11-16 — the 6-digit code beside the link", () => {
  it("reads six digits however they're typed, and nothing else", () => {
    expect(normaliseCode("123456")).toBe("123456");
    expect(normaliseCode(" 012 345 ")).toBe("012345");
    expect(normaliseCode("012-345")).toBe("012345");
    expect(normaliseCode("12345")).toBeNull();
    expect(normaliseCode("12a456")).toBeNull();
    expect(normaliseCode(123456)).toBeNull();
  });

  it("stores only a salted hash: the same code on two links hashes differently", async () => {
    const login = await requestLogin(testEmail(), null);
    expect(login.code).toMatch(/^\d{6}$/);
    const rows = await db.select().from(loginTokens).where(eq(loginTokens.email, login.email));
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(login.code);
    expect(codeHash("a", "123456")).not.toBe(codeHash("b", "123456"));
  });

  it("the code signs in once, and spends the link with it", async () => {
    const login = await requestLogin(testEmail(), null);
    const session = await redeemLoginCode(login.email, login.code);
    expect(await currentSession(session.session_token)).not.toBeNull();
    await expect(redeemLoginCode(login.email, login.code)).rejects.toMatchObject({
      status: 401,
      message: CODE_REFUSED,
    });
    await expect(redeemLogin(login.token)).rejects.toMatchObject({ status: 401 });
  });

  it("a code only works for the address it was sent to", async () => {
    const login = await requestLogin(testEmail(), null);
    await expect(redeemLoginCode(testEmail(), login.code)).rejects.toMatchObject({
      message: CODE_REFUSED,
    });
    // The rightful owner can still use it.
    await expect(redeemLoginCode(login.email, login.code)).resolves.toMatchObject({
      email: login.email,
    });
  });

  it("after a resend, the first email's code still works", async () => {
    const email = testEmail();
    const first = await requestLogin(email, null);
    await requestLogin(email, null);
    await expect(redeemLoginCode(email, first.code)).resolves.toMatchObject({ email });
  });

  it("guessing stops after 5 tries in 15 minutes, even with the right code next", async () => {
    const login = await requestLogin(testEmail(), null);
    const wrong = login.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(redeemLoginCode(login.email, wrong)).rejects.toMatchObject({ status: 401 });
    }
    await expect(redeemLoginCode(login.email, login.code)).rejects.toMatchObject({
      status: 429,
      message: CODE_TOO_MANY,
    });
  });
});
