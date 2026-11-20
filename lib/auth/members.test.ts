// I-52.1 and I-52.4 against the real database: the owner the database
// keeps, invites (hashed, single use, seven days, withdrawn, replaced,
// never joining the wrong address), roles, removal and the decision log.

import "dotenv/config";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { authSessions, decisionLog, teamInvites, users } from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import {
  INVITE_TTL_DAYS,
  LAST_OWNER,
  TeamError,
  createInvite,
  hashTeamDecision,
  inviteStatus,
  isLastOwnerError,
  joinByInviteId,
  joinWithSession,
  membershipsFor,
  peekInvite,
  removeMember,
  revokeInvite,
  setMemberRole,
  teamList,
} from "./members";
import type { Role } from "./role-actions";
import { AuthError, currentSession, openSession, requestLogin } from "./service";
import { redeemLogin } from "./sign-in";

const mail = (tag: string) => `team-${tag}-${crypto.randomUUID().slice(0, 8)}@example.com`;

async function business() {
  const boot = await bootstrapIntake();
  const owner = await member(boot.account_id, mail("owner"), "owner");
  return { ...boot, owner };
}

async function member(accountId: string, email: string, role: Role) {
  const [u] = await db
    .insert(users)
    .values({ account_id: accountId, email, display_name: "t", role })
    .returning();
  if (!u) throw new Error("fixture");
  return u;
}

const logFor = (refId: string) =>
  db.select().from(decisionLog).where(eq(decisionLog.ref_id, refId));

describe("the database keeps one owner per business (users_keep_an_owner)", () => {
  it("refuses to demote the last owner", async () => {
    const b = await business();
    await expect(
      db.update(users).set({ role: "manager" }).where(eq(users.id, b.owner.id)),
    ).rejects.toSatisfy(isLastOwnerError);
    const [u] = await db.select().from(users).where(eq(users.id, b.owner.id));
    expect(u?.role).toBe("owner");
  });

  it("refuses to remove the last owner, even with others on the team", async () => {
    const b = await business();
    await member(b.account_id, mail("v"), "viewer");
    await expect(
      db
        .update(users)
        .set({ removed_at: new Date().toISOString() })
        .where(eq(users.id, b.owner.id)),
    ).rejects.toSatisfy(isLastOwnerError);
    await expect(db.delete(users).where(eq(users.id, b.owner.id))).rejects.toSatisfy(
      isLastOwnerError,
    );
  });

  it("refuses a team with nobody as owner from the start", async () => {
    const boot = await bootstrapIntake();
    await expect(member(boot.account_id, mail("v"), "viewer")).rejects.toSatisfy(isLastOwnerError);
  });

  it("lets an owner step down once someone else is an owner", async () => {
    const b = await business();
    const second = await member(b.account_id, mail("o2"), "owner");
    await db.update(users).set({ role: "viewer" }).where(eq(users.id, b.owner.id));
    const [u] = await db.select().from(users).where(eq(users.id, b.owner.id));
    expect(u?.role).toBe("viewer");
    // …and now the second is the last owner.
    await expect(
      db.update(users).set({ role: "viewer" }).where(eq(users.id, second.id)),
    ).rejects.toSatisfy(isLastOwnerError);
  });

  it("lets a business with nobody left on it go (every row removed together)", async () => {
    const b = await business();
    await member(b.account_id, mail("v"), "viewer");
    await db.delete(users).where(eq(users.account_id, b.account_id));
    expect(await db.select().from(users).where(eq(users.account_id, b.account_id))).toEqual([]);
  });

  it("serialises two owners demoting each other at once: one of them stays", async () => {
    const b = await business();
    const second = await member(b.account_id, mail("o2"), "owner");
    // T1 demotes the first owner and waits, uncommitted, while T2 demotes the second and commits.
    const t1 = db.transaction(async (tx) => {
      await tx.update(users).set({ role: "manager" }).where(eq(users.id, b.owner.id));
      await db.transaction(async (t2) => {
        await t2.update(users).set({ role: "manager" }).where(eq(users.id, second.id));
      });
    });
    await expect(t1).rejects.toSatisfy(isLastOwnerError);
    const owners = await db
      .select()
      .from(users)
      .where(and(eq(users.account_id, b.account_id), eq(users.role, "owner")));
    expect(owners).toHaveLength(1);
  });
});

describe("the service says it in words", () => {
  it("setMemberRole and removeMember answer the last owner with a sentence", async () => {
    const b = await business();
    const args = { accountId: b.account_id, profileId: b.profile_id, byUserId: b.owner.id };
    await expect(
      setMemberRole({ ...args, targetUserId: b.owner.id, role: "viewer" }),
    ).rejects.toThrow(LAST_OWNER);
    await expect(removeMember({ ...args, targetUserId: b.owner.id })).rejects.toThrow(LAST_OWNER);
  });

  it("changes a role and logs who did it, ids only", async () => {
    const b = await business();
    const v = await member(b.account_id, mail("v"), "viewer");
    await setMemberRole({
      accountId: b.account_id,
      profileId: b.profile_id,
      targetUserId: v.id,
      role: "manager",
      byUserId: b.owner.id,
    });
    const [u] = await db.select().from(users).where(eq(users.id, v.id));
    expect(u?.role).toBe("manager");
    const [entry] = await logFor(v.id);
    expect(entry?.kind).toBe("team_role");
    expect(entry?.user_id).toBe(b.owner.id);
    expect(entry?.profile_id).toBe(b.profile_id);
  });

  it("refuses a role that isn't one, and a person on another team", async () => {
    const b = await business();
    const other = await business();
    const base = { accountId: b.account_id, profileId: b.profile_id, byUserId: b.owner.id };
    await expect(
      setMemberRole({ ...base, targetUserId: b.owner.id, role: "admin" }),
    ).rejects.toThrow(TeamError);
    await expect(
      setMemberRole({ ...base, targetUserId: other.owner.id, role: "viewer" }),
    ).rejects.toThrow("no such person on this team");
    await expect(removeMember({ ...base, targetUserId: other.owner.id })).rejects.toThrow(
      "no such person on this team",
    );
  });

  it("removal keeps the row, revokes every session, and logs it", async () => {
    const b = await business();
    const m = await member(b.account_id, mail("m"), "manager");
    const s1 = await openSession(m);
    const s2 = await openSession(m);
    await removeMember({
      accountId: b.account_id,
      profileId: b.profile_id,
      targetUserId: m.id,
      byUserId: b.owner.id,
    });
    const [u] = await db.select().from(users).where(eq(users.id, m.id));
    expect(u?.removed_at).not.toBeNull();
    expect(await currentSession(s1.session_token)).toBeNull();
    expect(await currentSession(s2.session_token)).toBeNull();
    expect((await logFor(m.id)).map((e) => e.kind)).toContain("team_remove");
    expect((await teamList(b.account_id)).members.map((x) => x.user_id)).toEqual([b.owner.id]);
  });
});

describe("invites", () => {
  it("stores only the token's hash, for seven days, and logs the invite with no email", async () => {
    const b = await business();
    const email = mail("inv");
    const { token, invite } = await createInvite({
      accountId: b.account_id,
      profileId: b.profile_id,
      invitedBy: b.owner.id,
      email: `  ${email.toUpperCase()} `,
      role: "manager",
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(teamInvites).where(eq(teamInvites.id, invite.id));
    expect(row?.email).toBe(email); // normalised
    expect(row?.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
    const days = (Date.parse(row!.expires_at) - Date.parse(row!.created_at)) / 86_400_000;
    expect(days).toBe(INVITE_TTL_DAYS);
    const [entry] = await logFor(invite.id);
    expect(entry?.kind).toBe("team_invite");
    expect(entry?.user_id).toBe(b.owner.id);
    expect(JSON.stringify(entry)).not.toContain(email);
  });

  it("hashes ids, a role and a time — the same inputs, the same hash; an email is never one", () => {
    const p = {
      kind: "team_invite" as const,
      account_id: "a",
      ref_id: "r",
      by_user_id: "u",
      role: "viewer" as const,
      detail: null,
      at: "2026-10-29T00:00:00.000Z",
    };
    expect(hashTeamDecision(p)).toBe(hashTeamDecision({ ...p }));
    expect(hashTeamDecision(p)).not.toBe(hashTeamDecision({ ...p, role: "owner" }));
  });

  it("refuses an address already on the team, and a bad address or role", async () => {
    const b = await business();
    const base = { accountId: b.account_id, profileId: b.profile_id, invitedBy: b.owner.id };
    await expect(createInvite({ ...base, email: b.owner.email, role: "viewer" })).rejects.toThrow(
      "already on the team",
    );
    await expect(createInvite({ ...base, email: "not-an-email", role: "viewer" })).rejects.toThrow(
      TeamError,
    );
    await expect(createInvite({ ...base, email: mail("x"), role: "boss" })).rejects.toThrow(
      TeamError,
    );
  });

  it("a second invite to the same address withdraws the first", async () => {
    const b = await business();
    const email = mail("twice");
    const base = { accountId: b.account_id, profileId: b.profile_id, invitedBy: b.owner.id };
    const first = await createInvite({ ...base, email, role: "viewer" });
    const second = await createInvite({ ...base, email, role: "manager" });
    expect((await peekInvite(first.token))?.status).toBe("revoked");
    expect((await peekInvite(second.token))?.status).toBe("pending");
    expect((await teamList(b.account_id)).invites.map((i) => i.id)).toEqual([second.invite.id]);
  });

  it("joins exactly the invited address, once", async () => {
    const b = await business();
    const email = mail("join");
    const { token } = await createInvite({
      accountId: b.account_id,
      profileId: b.profile_id,
      invitedBy: b.owner.id,
      email,
      role: "viewer",
    });
    const joined = await joinWithSession(token, { email });
    expect(joined.account_id).toBe(b.account_id);
    const s = await currentSession(joined.session_token);
    expect(s?.role).toBe("viewer");
    expect(s?.email).toBe(email);
    expect((await logFor(joined.user_id)).map((e) => e.kind)).toContain("team_join");
    // Single use.
    expect((await peekInvite(token))?.status).toBe("accepted");
    await expect(joinWithSession(token, { email })).rejects.toThrow("no longer open");
  });

  it("never joins a different address, whatever link it holds", async () => {
    const b = await business();
    const { token, invite } = await createInvite({
      accountId: b.account_id,
      profileId: b.profile_id,
      invitedBy: b.owner.id,
      email: mail("right"),
      role: "manager",
    });
    const wrong = mail("wrong");
    await expect(joinWithSession(token, { email: wrong })).rejects.toThrow(/this invite is for/);
    // Nor through a sign-in link carrying the invite for another address.
    const login = await requestLogin(wrong, null, invite.id);
    await expect(redeemLogin(login.token)).rejects.toThrow(AuthError);
    const rows = await db
      .select()
      .from(users)
      .where(and(eq(users.account_id, b.account_id), eq(users.email, wrong)));
    expect(rows).toEqual([]);
    expect((await peekInvite(token))?.status).toBe("pending"); // still open for the right person
  });

  it("joins through a sign-in link asked for from the invite page", async () => {
    const b = await business();
    const email = mail("link");
    const { invite } = await createInvite({
      accountId: b.account_id,
      profileId: b.profile_id,
      invitedBy: b.owner.id,
      email,
      role: "manager",
    });
    const login = await requestLogin(email, null, invite.id);
    const session = await redeemLogin(login.token);
    expect(session.account_id).toBe(b.account_id);
    expect((await currentSession(session.session_token))?.role).toBe("manager");
  });

  it("refuses a run-out invite and a withdrawn one", async () => {
    const b = await business();
    const base = { accountId: b.account_id, profileId: b.profile_id, invitedBy: b.owner.id };
    const old = await createInvite({
      ...base,
      email: mail("old"),
      role: "viewer",
      now: new Date(Date.now() - 8 * 86_400_000),
    });
    expect((await peekInvite(old.token))?.status).toBe("expired");
    await expect(joinWithSession(old.token, { email: old.invite.email })).rejects.toThrow(
      "no longer open",
    );
    const gone = await createInvite({ ...base, email: mail("gone"), role: "viewer" });
    await revokeInvite({ ...base, inviteId: gone.invite.id, byUserId: b.owner.id });
    expect((await peekInvite(gone.token))?.status).toBe("revoked");
    await expect(joinWithSession(gone.token, { email: gone.invite.email })).rejects.toThrow(
      "no longer open",
    );
    expect((await logFor(gone.invite.id)).map((e) => e.kind)).toContain("team_invite_revoke");
    await expect(
      revokeInvite({ ...base, inviteId: gone.invite.id, byUserId: b.owner.id }),
    ).rejects.toThrow("no such invite");
  });

  it("a removed member re-invited comes back as the same row", async () => {
    const b = await business();
    const email = mail("back");
    const m = await member(b.account_id, email, "manager");
    const base = { accountId: b.account_id, profileId: b.profile_id };
    await removeMember({ ...base, targetUserId: m.id, byUserId: b.owner.id });
    const { token } = await createInvite({ ...base, invitedBy: b.owner.id, email, role: "viewer" });
    const joined = await joinWithSession(token, { email });
    expect(joined.user_id).toBe(m.id);
    const [u] = await db.select().from(users).where(eq(users.id, m.id));
    expect(u?.removed_at).toBeNull();
    expect(u?.role).toBe("viewer");
  });

  it("peekInvite knows nothing of a malformed or unknown token", async () => {
    expect(await peekInvite("short")).toBeNull();
    expect(await peekInvite("A".repeat(43))).toBeNull();
  });

  it("inviteStatus: accepted and withdrawn are final; otherwise the clock decides", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const later = "2026-11-01T00:00:00Z";
    const earlier = "2026-10-01T00:00:00Z";
    expect(inviteStatus({ expires_at: later, accepted_at: null, revoked_at: null }, now)).toBe(
      "pending",
    );
    expect(inviteStatus({ expires_at: earlier, accepted_at: null, revoked_at: null }, now)).toBe(
      "expired",
    );
    expect(inviteStatus({ expires_at: earlier, accepted_at: earlier, revoked_at: null }, now)).toBe(
      "accepted",
    );
    expect(inviteStatus({ expires_at: later, accepted_at: null, revoked_at: earlier }, now)).toBe(
      "revoked",
    );
  });
});

describe("membershipsFor — one email's businesses, by name only", () => {
  it("lists every business the exact email is on, and not a removed one", async () => {
    const email = mail("many");
    const one = await business();
    const two = await business();
    const three = await business();
    await member(one.account_id, email, "manager");
    const leaving = await member(two.account_id, email, "viewer");
    await removeMember({
      accountId: two.account_id,
      profileId: two.profile_id,
      targetUserId: leaving.id,
      byUserId: two.owner.id,
    });
    await member(three.account_id, `x${email}`, "viewer"); // a different address
    const list = await membershipsFor(email);
    expect(list.map((m) => m.account_id)).toEqual([one.account_id]);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(
      ["account_id", "business", "profile_id", "role", "user_id"].sort(),
    );
    const live = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.user_id, leaving.id), isNull(authSessions.revoked_at)));
    expect(live).toEqual([]);
  });

  it("works through joinByInviteId only for the invite's own address", async () => {
    const b = await business();
    const { invite } = await createInvite({
      accountId: b.account_id,
      profileId: b.profile_id,
      invitedBy: b.owner.id,
      email: mail("own"),
      role: "viewer",
    });
    await expect(joinByInviteId(invite.id, mail("other"))).rejects.toThrow(AuthError);
  });
});
