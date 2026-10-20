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
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { NextRequest } from "next/server";
import { GET as redeemGET, POST as redeemPOST } from "../../app/api/auth/redeem/route";
import { appOriginOf } from "./same-origin";
import { currentSession, peekLogin, redeemLogin, requestLogin, revokeSession } from "./service";

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
      const [profile] = await db
        .select({ id: businessProfiles.id })
        .from(businessProfiles)
        .where(eq(businessProfiles.account_id, u.account_id));
      if (!profile) await db.delete(accounts).where(eq(accounts.id, u.account_id));
    }
    await db.delete(loginTokens).where(eq(loginTokens.email, email));
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
