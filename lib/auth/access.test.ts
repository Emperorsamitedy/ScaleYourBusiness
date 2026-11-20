// The security review of 2026-10-17 — every test names the attack it closes.
//
//   · A leaked profile id opened the whole business (the intake cookie WAS
//     the id). Now the cookie is signed, and an owned business opens only
//     to a session for its own account.
//   · A sign-in for a fresh email joined whatever account the cookie named,
//     as an owner. Now a login only ever claims a profile nobody owns.
//   · The login endpoint answered with the sign-in link whenever email
//     wasn't configured or a send failed. Now only local development shows it.
//   · Two concurrent redeems of one link both minted sessions.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  loginTokens,
  users,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import type { ParsedCookie } from "./access";
import { claimableProfile, decideAccess, parseProfileCookie, signProfileCookie } from "./access";
import type { AuthedSession } from "./service";
import { requestLogin } from "./service";
import { redeemLogin, signInWithEmail } from "./sign-in";
import { sendLoginEmail } from "./email";

const ID = "3c941b9e-a4e2-48ad-8e6a-4f22ff2b20ee";
const OTHER = "5d2a7c10-0b1e-4c3d-9f8a-1e2b3c4d5e6f";

describe("the intake cookie is signed — a leaked id alone opens nothing", () => {
  it("round-trips its own signature", () => {
    expect(parseProfileCookie(signProfileCookie(ID))).toEqual({ profileId: ID, signed: true });
  });

  it("refuses a forged, swapped or truncated signature", () => {
    const real = signProfileCookie(ID);
    const sig = real.slice(real.indexOf(".") + 1);
    expect(parseProfileCookie(`${OTHER}.${sig}`)).toBeNull(); // someone else's id, my signature
    expect(parseProfileCookie(`${ID}.${sig.slice(0, -2)}`)).toBeNull();
    expect(parseProfileCookie(`${ID}.not-a-signature`)).toBeNull();
    expect(parseProfileCookie(`not-a-uuid.${sig}`)).toBeNull();
    expect(parseProfileCookie("")).toBeNull();
    expect(parseProfileCookie(undefined)).toBeNull();
  });

  it("reads a legacy bare id as unsigned — the decision then limits what it may open", () => {
    expect(parseProfileCookie(ID)).toEqual({ profileId: ID, signed: false });
  });
});

const session = (account_id: string): AuthedSession => ({
  account_id,
  user_id: "u",
  email: "o@example.com",
  profile_id: null,
  role: "owner",
});
const signed: ParsedCookie = { profileId: ID, signed: true };
const legacy: ParsedCookie = { profileId: ID, signed: false };
const unowned = { id: ID, account_id: "acct-1", owner_user_id: null };
const owned = { id: ID, account_id: "acct-1", owner_user_id: "owner-1" };

describe("decideAccess — every branch", () => {
  it("an anonymous intake opens to its cookie, signed or legacy, with no session", () => {
    expect(decideAccess({ cookie: signed, profile: unowned, session: null })).toMatchObject({
      profile_id: ID,
      owned: false,
      session: null,
    });
    expect(decideAccess({ cookie: legacy, profile: unowned, session: null })).not.toBeNull();
  });

  it("THE ATTACK: an owned business never opens to its cookie alone, signed or not", () => {
    expect(decideAccess({ cookie: signed, profile: owned, session: null })).toBeNull();
    expect(decideAccess({ cookie: legacy, profile: owned, session: null })).toBeNull();
  });

  it("THE ATTACK: signed in as somebody else opens nothing — the session must be this account's", () => {
    expect(decideAccess({ cookie: signed, profile: owned, session: session("acct-2") })).toBeNull();
  });

  it("the owner, signed in, gets the business and the session that proves it", () => {
    expect(
      decideAccess({ cookie: signed, profile: owned, session: session("acct-1") }),
    ).toMatchObject({ owned: true, session: { account_id: "acct-1" } });
  });

  it("a stranger's session is never handed to a route, even on an unowned profile", () => {
    expect(
      decideAccess({ cookie: signed, profile: unowned, session: session("acct-2") })?.session,
    ).toBeNull();
  });

  it("no cookie, no profile, or a cookie for a different profile: nothing", () => {
    expect(decideAccess({ cookie: null, profile: owned, session: session("acct-1") })).toBeNull();
    expect(decideAccess({ cookie: signed, profile: null, session: null })).toBeNull();
    expect(
      decideAccess({ cookie: signed, profile: { ...unowned, id: OTHER }, session: null }),
    ).toBeNull();
  });
});

describe("the login never shows the link outside local development", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("production without an email key fails instead of handing out the link", async () => {
    delete process.env.RESEND_API_KEY;
    vi.stubEnv("NODE_ENV", "production");
    expect(await sendLoginEmail({ to: "o@example.com", link: "https://x/redeem" })).toEqual({
      delivered_via: "failed",
    });
    vi.unstubAllEnvs();
  });

  it("THE ATTACK: a failed send (a burst into the rate limit, an unverified sender) is a failure, never the link", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
    expect(await sendLoginEmail({ to: "o@example.com", link: "https://x/redeem" })).toEqual({
      delivered_via: "failed",
      provider: { status: 429, id: null },
    });
  });

  it("a send Resend accepts reports its status and email id, and nothing more", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }),
    );
    expect(await sendLoginEmail({ to: "o@example.com", link: "https://x/redeem" })).toEqual({
      delivered_via: "resend",
      provider: { status: 200, id: "email_123" },
    });
    vi.stubGlobal("fetch", async () => new Response("not json", { status: 200 }));
    expect(await sendLoginEmail({ to: "o@example.com", link: "https://x/redeem" })).toEqual({
      delivered_via: "resend",
      provider: { status: 200, id: null },
    });
  });

  it("local development with no key still shows it, for the developer", async () => {
    delete process.env.RESEND_API_KEY;
    vi.stubEnv("NODE_ENV", "development");
    expect(await sendLoginEmail({ to: "o@example.com", link: "https://x/redeem" })).toEqual({
      delivered_via: "screen",
    });
    vi.unstubAllEnvs();
  });
});

/* ── against the database ── */

const createdProfiles: { account_id: string; profile_id: string }[] = [];
const createdEmails: string[] = [];

function email(): string {
  const e = `sec-${crypto.randomUUID().slice(0, 8)}@example.com`;
  createdEmails.push(e);
  return e;
}

afterAll(async () => {
  const userRows =
    createdEmails.length > 0
      ? await db.select().from(users).where(inArray(users.email, createdEmails))
      : [];
  const accountIds = new Set([
    ...createdProfiles.map((s) => s.account_id),
    ...userRows.map((u) => u.account_id),
  ]);
  for (const u of userRows) await db.delete(authSessions).where(eq(authSessions.user_id, u.id));
  if (accountIds.size > 0) {
    await db
      .update(accounts)
      .set({ owner_user_id: null })
      .where(inArray(accounts.id, [...accountIds]));
  }
  for (const u of userRows) await db.delete(users).where(eq(users.id, u.id));
  if (createdEmails.length > 0) {
    await db.delete(loginTokens).where(inArray(loginTokens.email, createdEmails));
  }
  const profileIds = createdProfiles.map((s) => s.profile_id);
  if (profileIds.length > 0) {
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, profileIds));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, profileIds));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, profileIds));
  }
  const orphanAccounts = [...accountIds];
  if (orphanAccounts.length > 0) {
    const stillUsed = await db
      .select({ id: businessProfiles.account_id })
      .from(businessProfiles)
      .where(inArray(businessProfiles.account_id, orphanAccounts));
    const free = orphanAccounts.filter((a) => !stillUsed.some((r) => r.id === a));
    if (free.length > 0) await db.delete(accounts).where(inArray(accounts.id, free));
  }
});

describe("a sign-in only ever claims a business nobody owns", () => {
  it("the anonymous intake is claimed by the first sign-in — the product's sign-up path", async () => {
    const s = await bootstrapIntake();
    createdProfiles.push(s);
    expect(await claimableProfile(signProfileCookie(s.profile_id))).toBe(s.profile_id);
    const first = await signInWithEmail(email(), s.profile_id);
    expect(first.account_id).toBe(s.account_id);
  });

  it("THE ATTACK: with an owner in place, a stranger's sign-in gets its own account, never the business", async () => {
    const s = await bootstrapIntake();
    createdProfiles.push(s);
    await signInWithEmail(email(), s.profile_id); // the real owner
    // The route-level door: an owned profile is not claimable, signed cookie or not.
    expect(await claimableProfile(signProfileCookie(s.profile_id))).toBeNull();
    expect(await claimableProfile(s.profile_id)).toBeNull();
    // Defence in depth: even handed the id directly, the service refuses to join.
    const stranger = await signInWithEmail(email(), s.profile_id);
    expect(stranger.account_id).not.toBe(s.account_id);
    // L8: the stranger gets a business of their own, and never this one.
    expect(stranger.profile_id).not.toBeNull();
    expect(stranger.profile_id).not.toBe(s.profile_id);
  });

  it("THE ATTACK: two concurrent redeems of one link mint one session, not two", async () => {
    const login = await requestLogin(email(), null);
    const results = await Promise.allSettled([redeemLogin(login.token), redeemLogin(login.token)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
