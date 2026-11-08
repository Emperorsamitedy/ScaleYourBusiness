// The team on one business — idea 52 (I-52.1, I-52.4).
//
// A person on a team is a users row in ONE account, with a role. One
// email may have a row in several accounts (a sign-in then asks "Which
// business?"), but no row ever spans two, and every route still resolves
// its account from the session — so nothing here reads across accounts.
//
// Invites. An owner invites an address with a role. The link carries a
// 32-byte token; only its sha256 is stored, it works once, for seven days,
// and the owner can withdraw it. The token says WHICH invite — never who
// you are: joining also needs a sign-in proven for exactly the invited
// address (a signed-in session for it, or a sign-in link emailed to it
// from the invite page). A different address never joins, whatever link
// it holds.
//
// Every change — invite, withdrawal, join, role, removal — goes into the
// append-only decision log (rule 7) with ids and a hash, never an email
// or a token. The last owner can't be removed or demoted: the database
// refuses it (the users_keep_an_owner trigger, migration 0070), and this
// file turns that refusal into a sentence.
//
// A team member is never an employee record (rule 28): nothing here
// counts, scores or compares what people do.

import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import {
  authSessions,
  businessProfiles,
  decisionLog,
  fieldRecords,
  pushSubscriptions,
  teamInvites,
  users,
} from "../../db/schema";
import { normaliseEmail } from "../intake/resume";
import { eraseWhatsAppNumbers } from "../summary/whatsapp-optin";
import type { Role } from "./role-actions";
import { isRole } from "./role-actions";
import type { AuthedSession, RedeemedSession } from "./service";
import { AuthError, hash, openSession } from "./service";

export class TeamError extends Error {
  readonly status: number;
  constructor(message: string, status = 422) {
    super(message);
    this.name = "TeamError";
    this.status = status;
  }
}

export const INVITE_TTL_DAYS = 7;
const TOKEN_BYTES = 32;
/** A token as minted: 43 base64url characters. Anything else is refused before a query. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const LAST_OWNER =
  "A business always keeps at least one owner. Make someone else an owner first.";

/** Whether an error is the database refusing to leave an account without an owner. */
export function isLastOwnerError(error: unknown): boolean {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && typeof e === "object" && e !== null; depth++) {
    if ((e as { constraint?: unknown }).constraint === "users_keep_an_owner") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

// ── the decision log ──

export type TeamKind =
  | "team_invite"
  | "team_invite_revoke"
  | "team_join"
  | "team_role"
  | "team_remove"
  | "account_switch";

/**
 * Canonical sha256 of a team event. Ids, a role and a time only — never
 * an email or a token. Key order is fixed by construction.
 */
export function hashTeamDecision(p: {
  kind: TeamKind;
  account_id: string;
  ref_id: string;
  by_user_id: string | null;
  role: Role | null;
  detail: string | null;
  at: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: p.kind,
        account_id: p.account_id,
        ref_id: p.ref_id,
        by_user_id: p.by_user_id,
        role: p.role,
        detail: p.detail,
        at: p.at,
      }),
    )
    .digest("hex");
}

export async function logTeamDecision(
  tx: DbOrTx,
  e: {
    kind: TeamKind;
    profileId: string;
    accountId: string;
    refId: string;
    byUserId: string | null;
    role?: Role | null;
    detail?: string | null;
    at?: string;
  },
): Promise<void> {
  const at = e.at ?? new Date().toISOString();
  await tx.insert(decisionLog).values({
    profile_id: e.profileId,
    actor: "owner",
    kind: e.kind,
    ref_id: e.refId,
    user_id: e.byUserId,
    at,
    payload_hash: hashTeamDecision({
      kind: e.kind,
      account_id: e.accountId,
      ref_id: e.refId,
      by_user_id: e.byUserId,
      role: e.role ?? null,
      detail: e.detail ?? null,
      at,
    }),
  });
}

/** The account's one profile — the decision log is kept per profile. */
export async function profileOfAccount(accountId: string, tx: DbOrTx = db): Promise<string> {
  const [p] = await tx
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, accountId));
  if (!p) throw new TeamError("that business isn't set up yet", 409);
  return p.id;
}

// ── names ──

/** The business's own name (identity.legal_name) per profile, when it has one. */
async function businessNames(profileIds: readonly string[]): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map();
  const rows = await db
    .select({ profile_id: fieldRecords.profile_id, value: fieldRecords.value })
    .from(fieldRecords)
    .where(
      and(
        inArray(fieldRecords.profile_id, [...profileIds]),
        eq(fieldRecords.field_key, "identity.legal_name"),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const out = new Map<string, string>();
  for (const r of rows) {
    if (typeof r.value === "string" && r.value.trim() !== "") out.set(r.profile_id, r.value.trim());
  }
  return out;
}

// ── memberships: the businesses one verified email belongs to ──

export interface Membership {
  account_id: string;
  user_id: string;
  role: Role;
  /** The business's own name, or null before the interview names it. */
  business: string | null;
  profile_id: string | null;
}

/**
 * Every business this exact email is on, by name — what "Which business?"
 * and the switcher list. Only the person's own rows: a name and a role,
 * never anything inside the business.
 */
export async function membershipsFor(rawEmail: string): Promise<Membership[]> {
  const email = normaliseEmail(rawEmail);
  const rows = await db
    .select({
      account_id: users.account_id,
      user_id: users.id,
      role: users.role,
      profile_id: businessProfiles.id,
    })
    .from(users)
    .leftJoin(businessProfiles, eq(businessProfiles.account_id, users.account_id))
    .where(and(eq(users.email, email), isNull(users.removed_at)))
    .orderBy(asc(users.created_at));
  const names = await businessNames(rows.flatMap((r) => (r.profile_id ? [r.profile_id] : [])));
  return rows.map((r) => ({
    account_id: r.account_id,
    user_id: r.user_id,
    role: r.role,
    business: r.profile_id ? (names.get(r.profile_id) ?? null) : null,
    profile_id: r.profile_id,
  }));
}

// ── the team screen ──

export type InviteStatus = "pending" | "expired" | "accepted" | "revoked";

/** Pure: an invite's state at `now`. Accepted and revoked are final; expiry is read. */
export function inviteStatus(
  row: { expires_at: string; accepted_at: string | null; revoked_at: string | null },
  now: Date = new Date(),
): InviteStatus {
  if (row.accepted_at !== null) return "accepted";
  if (row.revoked_at !== null) return "revoked";
  return new Date(row.expires_at).getTime() <= now.getTime() ? "expired" : "pending";
}

export interface TeamMember {
  user_id: string;
  email: string;
  display_name: string;
  role: Role;
  joined_at: string;
}

export interface TeamInvite {
  id: string;
  email: string;
  role: Role;
  created_at: string;
  expires_at: string;
  status: InviteStatus;
}

export interface TeamList {
  members: TeamMember[];
  /** Invites still open (pending or run out but not withdrawn), newest first. */
  invites: TeamInvite[];
}

/** One business's team: the people on it now, and the invites still open. */
export async function teamList(accountId: string, now: Date = new Date()): Promise<TeamList> {
  const [memberRows, inviteRows] = await Promise.all([
    db
      .select({
        user_id: users.id,
        email: users.email,
        display_name: users.display_name,
        role: users.role,
        joined_at: users.created_at,
      })
      .from(users)
      .where(and(eq(users.account_id, accountId), isNull(users.removed_at)))
      .orderBy(asc(users.created_at)),
    db
      .select()
      .from(teamInvites)
      .where(
        and(
          eq(teamInvites.account_id, accountId),
          isNull(teamInvites.accepted_at),
          isNull(teamInvites.revoked_at),
        ),
      )
      .orderBy(asc(teamInvites.created_at)),
  ]);
  const rank: Record<Role, number> = { owner: 0, manager: 1, viewer: 2 };
  return {
    members: [...memberRows].sort((a, b) => rank[a.role] - rank[b.role]),
    invites: inviteRows.reverse().map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      created_at: r.created_at,
      expires_at: r.expires_at,
      status: inviteStatus(r, now),
    })),
  };
}

// ── inviting ──

export const inviteTokenHash = (token: string): string => hash(token);

/**
 * Invite an address into this business with a role. Returns the token
 * once — the caller builds the link from it; it is never readable again.
 * An open invite for the same address is withdrawn and replaced, in the
 * same transaction (one open invite per address).
 */
export async function createInvite(args: {
  accountId: string;
  profileId: string;
  invitedBy: string | null;
  email: string;
  role: unknown;
  now?: Date;
}): Promise<{ token: string; invite: TeamInvite }> {
  const now = args.now ?? new Date();
  let email: string;
  try {
    email = normaliseEmail(args.email);
  } catch {
    throw new TeamError("that doesn't look like an email address");
  }
  if (!isRole(args.role)) throw new TeamError("pick a role: owner, manager or viewer");
  const role = args.role;

  const [already] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.account_id, args.accountId), eq(users.email, email), isNull(users.removed_at)),
    );
  if (already) throw new TeamError(`${email} is already on the team`, 409);

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000).toISOString();

  const row = await db.transaction(async (tx) => {
    const replaced = await tx
      .update(teamInvites)
      .set({ revoked_at: at })
      .where(
        and(
          eq(teamInvites.account_id, args.accountId),
          eq(teamInvites.email, email),
          isNull(teamInvites.accepted_at),
          isNull(teamInvites.revoked_at),
        ),
      )
      .returning({ id: teamInvites.id });
    for (const old of replaced) {
      await logTeamDecision(tx, {
        kind: "team_invite_revoke",
        profileId: args.profileId,
        accountId: args.accountId,
        refId: old.id,
        byUserId: args.invitedBy,
        detail: "replaced",
        at,
      });
    }
    const [inserted] = await tx
      .insert(teamInvites)
      .values({
        account_id: args.accountId,
        email,
        role,
        token_hash: inviteTokenHash(token),
        invited_by: args.invitedBy,
        created_at: at,
        expires_at: expiresAt,
      })
      .returning();
    if (!inserted) throw new TeamError("the invite could not be made", 500);
    await logTeamDecision(tx, {
      kind: "team_invite",
      profileId: args.profileId,
      accountId: args.accountId,
      refId: inserted.id,
      byUserId: args.invitedBy,
      role,
      at,
    });
    return inserted;
  });

  console.log(
    JSON.stringify({
      event: "team_invite_created",
      account_id: args.accountId,
      invite_id: row.id,
      role,
    }),
  );
  return {
    token,
    invite: {
      id: row.id,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
      expires_at: row.expires_at,
      status: inviteStatus(row, now),
    },
  };
}

/** Withdraw an open invite. Only this account's; anything else is "no such invite". */
export async function revokeInvite(args: {
  accountId: string;
  profileId: string;
  inviteId: string;
  byUserId: string | null;
}): Promise<void> {
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(teamInvites)
      .set({ revoked_at: at })
      .where(
        and(
          eq(teamInvites.id, args.inviteId),
          eq(teamInvites.account_id, args.accountId),
          isNull(teamInvites.accepted_at),
          isNull(teamInvites.revoked_at),
        ),
      )
      .returning({ id: teamInvites.id });
    if (!row) throw new TeamError("no such invite", 404);
    await logTeamDecision(tx, {
      kind: "team_invite_revoke",
      profileId: args.profileId,
      accountId: args.accountId,
      refId: row.id,
      byUserId: args.byUserId,
      at,
    });
  });
}

// ── the invite page ──

export interface InvitePeek {
  invite_id: string;
  email: string;
  role: Role;
  business: string | null;
  status: InviteStatus;
}

/**
 * What an invite link is for, WITHOUT using it — the page shows the
 * business, the role and the address before anyone presses anything.
 * Unknown and malformed tokens are null; a used, withdrawn or run-out
 * invite says which, so the person knows to ask again.
 */
export async function peekInvite(
  token: string,
  now: Date = new Date(),
): Promise<InvitePeek | null> {
  if (!INVITE_TOKEN_RE.test(token)) return null;
  const [row] = await db
    .select()
    .from(teamInvites)
    .where(eq(teamInvites.token_hash, inviteTokenHash(token)));
  if (!row) return null;
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, row.account_id));
  const names = await businessNames(profile ? [profile.id] : []);
  return {
    invite_id: row.id,
    email: row.email,
    role: row.role,
    business: profile ? (names.get(profile.id) ?? null) : null,
    status: inviteStatus(row, now),
  };
}

// ── joining ──

/**
 * Accept an invite as the person whose address it names. `email` must be
 * an address already PROVEN (a session's, or a redeemed sign-in link's);
 * it is compared exactly with the invite's. Single use: the invite is
 * claimed by a conditional update, so two accepts make one member.
 * A removed member's own row comes back, with the invite's role.
 */
async function acceptInvite(
  where: ReturnType<typeof eq>,
  provenEmail: string,
): Promise<{ user_id: string; account_id: string }> {
  const email = normaliseEmail(provenEmail);
  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(teamInvites)
      .where(
        and(
          where,
          isNull(teamInvites.accepted_at),
          isNull(teamInvites.revoked_at),
          gt(teamInvites.expires_at, now),
        ),
      )
      .for("update");
    if (!invite) throw new TeamError("that invite is no longer open — ask for a new one", 410);
    if (invite.email !== email) {
      // Never joins the wrong person, whatever link they hold.
      throw new TeamError(
        `this invite is for ${invite.email}, and you're signed in as ${email}`,
        403,
      );
    }
    const [existing] = await tx
      .select()
      .from(users)
      .where(and(eq(users.account_id, invite.account_id), eq(users.email, email)));
    let userId: string;
    if (existing && existing.removed_at === null) {
      // Already on the team (joined another way since): the invite is spent, the role kept.
      userId = existing.id;
    } else if (existing) {
      await tx
        .update(users)
        .set({ removed_at: null, role: invite.role })
        .where(eq(users.id, existing.id));
      userId = existing.id;
    } else {
      const [created] = await tx
        .insert(users)
        .values({
          account_id: invite.account_id,
          email,
          display_name: email.split("@")[0] ?? email,
          role: invite.role,
        })
        .returning({ id: users.id });
      if (!created) throw new TeamError("could not join just now", 500);
      userId = created.id;
    }
    await tx
      .update(teamInvites)
      .set({ accepted_at: now, accepted_user_id: userId })
      .where(eq(teamInvites.id, invite.id));
    const profileId = await profileOfAccount(invite.account_id, tx);
    await logTeamDecision(tx, {
      kind: "team_join",
      profileId,
      accountId: invite.account_id,
      refId: userId,
      byUserId: userId,
      role: invite.role,
      detail: invite.id,
      at: now,
    });
    return { user_id: userId, account_id: invite.account_id };
  });
}

/** Join from the invite page, already signed in as the invited address. */
export async function joinWithSession(
  token: string,
  session: Pick<AuthedSession, "email">,
): Promise<RedeemedSession> {
  if (!INVITE_TOKEN_RE.test(token)) throw new TeamError("that invite is no longer open", 410);
  const joined = await acceptInvite(
    eq(teamInvites.token_hash, inviteTokenHash(token)),
    session.email,
  );
  return sessionFor(joined.user_id);
}

/**
 * Join through a sign-in link asked for from the invite page — the link
 * went to the invite's own address, and `email` is that link's. Called by
 * redeemLogin only.
 */
export async function joinByInviteId(inviteId: string, email: string): Promise<RedeemedSession> {
  try {
    const joined = await acceptInvite(eq(teamInvites.id, inviteId), email);
    return sessionFor(joined.user_id);
  } catch (error) {
    if (error instanceof TeamError) throw new AuthError(error.message, 401);
    throw error;
  }
}

async function sessionFor(userId: string): Promise<RedeemedSession> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new TeamError("could not join just now", 500);
  return { ...(await openSession(user)), choose: false };
}

// ── roles and removal ──

async function memberOf(accountId: string, userId: string, tx: DbOrTx) {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.account_id, accountId), isNull(users.removed_at)));
  if (!row) throw new TeamError("no such person on this team", 404);
  return row;
}

/** Change a member's role. The last owner can't be made anything else. */
export async function setMemberRole(args: {
  accountId: string;
  profileId: string;
  targetUserId: string;
  role: unknown;
  byUserId: string | null;
}): Promise<void> {
  if (!isRole(args.role)) throw new TeamError("pick a role: owner, manager or viewer");
  const role = args.role;
  try {
    await db.transaction(async (tx) => {
      const target = await memberOf(args.accountId, args.targetUserId, tx);
      if (target.role === role) return;
      await tx.update(users).set({ role }).where(eq(users.id, target.id));
      await logTeamDecision(tx, {
        kind: "team_role",
        profileId: args.profileId,
        accountId: args.accountId,
        refId: target.id,
        byUserId: args.byUserId,
        role,
      });
    });
  } catch (error) {
    if (isLastOwnerError(error)) throw new TeamError(LAST_OWNER, 409);
    throw error;
  }
}

/**
 * Take someone off the team: the row is kept (proposals and the log name
 * it) but marked removed, and every session it had is revoked in the same
 * transaction — they are signed out everywhere at once. The last owner
 * can't be removed.
 */
export async function removeMember(args: {
  accountId: string;
  profileId: string;
  targetUserId: string;
  byUserId: string | null;
}): Promise<void> {
  const at = new Date().toISOString();
  try {
    await db.transaction(async (tx) => {
      const target = await memberOf(args.accountId, args.targetUserId, tx);
      await tx.update(users).set({ removed_at: at }).where(eq(users.id, target.id));
      await tx
        .update(authSessions)
        .set({ revoked_at: at })
        .where(and(eq(authSessions.user_id, target.id), isNull(authSessions.revoked_at)));
      // Idea 53's phone alerts go with them, as a sign-out takes its own.
      await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.user_id, target.id));
      // P6-07 (rule 22): and any WhatsApp number they gave for the weekly summary.
      await eraseWhatsAppNumbers(target.id, tx);
      await logTeamDecision(tx, {
        kind: "team_remove",
        profileId: args.profileId,
        accountId: args.accountId,
        refId: target.id,
        byUserId: args.byUserId,
        at,
      });
    });
  } catch (error) {
    if (isLastOwnerError(error)) throw new TeamError(LAST_OWNER, 409);
    throw error;
  }
}
