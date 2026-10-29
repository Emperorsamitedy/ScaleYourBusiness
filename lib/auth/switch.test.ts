// I-52.1/I-52.2 against the real database: a one-business person signs in
// exactly as before; an email on several businesses is asked which; a
// switch is a new session for the target's own row, only for the exact
// verified email, logged with ids; "Add another business" makes a new one.

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, authSessions, businessProfiles, decisionLog, users } from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import type { Role } from "./role-actions";
import { currentSession, openSession, redeemLogin, requestLogin, signInWithEmail } from "./service";
import { SwitchError, addBusiness, switchAccount } from "./switch";

const mail = (tag: string) => `sw-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function join(accountId: string, email: string, role: Role) {
  const [u] = await db
    .insert(users)
    .values({ account_id: accountId, email, display_name: "t", role })
    .returning();
  if (!u) throw new Error("fixture");
  return u;
}

async function ownedBusiness(email: string) {
  const boot = await bootstrapIntake();
  const owner = await join(boot.account_id, email, "owner");
  return { ...boot, owner };
}

describe("a one-business person — unchanged by idea 52", () => {
  it("claims the anonymous interview, then signs back in to the same business, no chooser", async () => {
    const email = mail("one");
    const boot = await bootstrapIntake();
    const first = await redeemLogin((await requestLogin(email, boot.profile_id)).token);
    expect(first.account_id).toBe(boot.account_id);
    expect(first.profile_id).toBe(boot.profile_id);
    expect(first.choose).toBe(false);
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, boot.account_id));
    expect(acct?.owner_user_id).toBe(first.user_id);

    const again = await redeemLogin((await requestLogin(email, null)).token);
    expect(again.account_id).toBe(boot.account_id);
    expect(again.user_id).toBe(first.user_id);
    expect(again.choose).toBe(false);
    const s = await currentSession(again.session_token);
    expect(s).toMatchObject({
      account_id: boot.account_id,
      user_id: first.user_id,
      email,
      profile_id: boot.profile_id,
      role: "owner",
    });
  });

  it("a brand-new email with no interview still gets a fresh account and lands on the intake", async () => {
    const s = await signInWithEmail(mail("fresh"), null);
    expect(s.profile_id).toBeNull();
    expect(s.choose).toBe(false);
  });
});

describe("one email on several businesses", () => {
  it("asks which, opening the most recently used one", async () => {
    const email = mail("two");
    const a = await ownedBusiness(email);
    const b = await bootstrapIntake();
    await join(b.account_id, mail("bowner"), "owner");
    await join(b.account_id, email, "manager");
    await openSession({ id: a.owner.id, account_id: a.account_id, email }); // A used last
    const s = await signInWithEmail(email, null);
    expect(s.choose).toBe(true);
    expect(s.account_id).toBe(a.account_id);
  });

  it("switches to the other business only for the exact same email, and logs it with ids", async () => {
    const email = mail("sw");
    const a = await ownedBusiness(email);
    const b = await bootstrapIntake();
    await join(b.account_id, mail("bowner"), "owner");
    const there = await join(b.account_id, email, "viewer");
    const here = await openSession(a.owner);
    const elsewhere = await openSession(a.owner); // another device
    const session = await currentSession(here.session_token);
    if (!session) throw new Error("fixture session");

    const next = await switchAccount({
      session,
      currentToken: here.session_token,
      targetAccountId: b.account_id,
    });
    expect(next.account_id).toBe(b.account_id);
    expect(next.user_id).toBe(there.id);
    expect((await currentSession(next.session_token))?.role).toBe("viewer");
    // This browser's old token is retired; nothing else is.
    expect(await currentSession(here.session_token)).toBeNull();
    expect(await currentSession(elsewhere.session_token)).not.toBeNull();

    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.ref_id, there.id), eq(decisionLog.kind, "account_switch")));
    expect(entry?.profile_id).toBe(b.profile_id);
    expect(entry?.user_id).toBe(there.id);
    expect(JSON.stringify(entry)).not.toContain(email);
  });

  it("refuses a business this email isn't on, or was taken off", async () => {
    const email = mail("no");
    const a = await ownedBusiness(email);
    const b = await ownedBusiness(mail("b"));
    const c = await bootstrapIntake();
    await join(c.account_id, mail("cowner"), "owner");
    await join(c.account_id, email, "manager");
    await db
      .update(users)
      .set({ removed_at: new Date().toISOString() })
      .where(and(eq(users.account_id, c.account_id), eq(users.email, email)));
    const here = await openSession(a.owner);
    const session = await currentSession(here.session_token);
    if (!session) throw new Error("fixture session");
    for (const target of [b.account_id, c.account_id]) {
      await expect(
        switchAccount({ session, currentToken: here.session_token, targetAccountId: target }),
      ).rejects.toThrow(SwitchError);
    }
    // A near-miss address is a different person.
    await expect(
      switchAccount({
        session: { ...session, email: `${email}.` },
        currentToken: here.session_token,
        targetAccountId: a.account_id,
      }),
    ).rejects.toThrow(SwitchError);
    expect(await currentSession(here.session_token)).not.toBeNull(); // nothing revoked on a refusal
  });

  it("adds another business: a new account, its profile, an owner row for the same email", async () => {
    const email = mail("add");
    const a = await ownedBusiness(email);
    const here = await openSession(a.owner);
    const session = await currentSession(here.session_token);
    if (!session) throw new Error("fixture session");
    const next = await addBusiness({ session, currentToken: here.session_token });
    expect(next.account_id).not.toBe(a.account_id);
    expect(next.profile_id).not.toBeNull();
    const [profile] = await db
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.account_id, next.account_id));
    expect(profile?.id).toBe(next.profile_id);
    const s = await currentSession(next.session_token);
    expect(s?.role).toBe("owner");
    expect(s?.email).toBe(email);
    const [acct] = await db.select().from(accounts).where(eq(accounts.id, next.account_id));
    expect(acct?.owner_user_id).toBe(next.user_id);
    // Signing in again now asks which.
    expect((await signInWithEmail(email, null)).choose).toBe(true);
    const live = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.user_id, a.owner.id), isNull(authSessions.revoked_at)));
    expect(live).toEqual([]);
  });
});
