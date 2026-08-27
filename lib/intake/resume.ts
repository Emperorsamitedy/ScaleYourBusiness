// Resume links — P1-56/57 / Session D.
//
// Nobody finishes twenty-seven questions in one sitting, and the owner
// we are building for is answering them between customers. Identity is
// therefore the thinnest thing that works: an email and a signed link.
// No password, no account creation, no barrier at the exact moment
// somebody has decided to trust us with their numbers.
//
// Security posture, deliberately stated:
//   · The token is 32 random bytes, url-safe. Only its sha256 is stored,
//     so a leaked database row cannot be replayed as a login.
//   · Links expire (30 days) and can be revoked without being deleted.
//   · Lookup is by hash, in constant work — there is nothing to enumerate.
//   · A link grants exactly one profile. There is no account to escalate
//     into, because in Phase 1 there is no account.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, resumeTokens } from "../../db/schema";

export class ResumeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ResumeError";
    this.status = status;
  }
}

/** Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32;
export const RESUME_TTL_DAYS = 30;

/** Deliberately permissive: rejecting real addresses costs more than it saves. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normaliseEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) {
    throw new ResumeError("that doesn't look like an email address", 422);
  }
  return email;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedLink {
  /** Hand this to the owner. It is never stored. */
  token: string;
  email: string;
  expires_at: string;
}

/**
 * Issue a way back into this profile. Re-issuing is allowed and does not
 * invalidate earlier links: an owner who asks for the link twice on two
 * devices should end up with two working links, not one broken one.
 */
export async function issueResumeLink(profileId: string, rawEmail: string): Promise<IssuedLink> {
  const email = normaliseEmail(rawEmail);
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!profile) throw new ResumeError("no such profile", 404);

  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expires = new Date(Date.now() + RESUME_TTL_DAYS * 86_400_000).toISOString();

  await db.insert(resumeTokens).values({
    profile_id: profileId,
    token_hash: hash(token),
    email,
    expires_at: expires,
  });

  return { token, email, expires_at: expires };
}

export interface ResolvedLink {
  profile_id: string;
  email: string;
}

/**
 * Exchange a token for the profile it opens. Expired, revoked and unknown
 * tokens are all the same answer — a caller learns nothing by probing.
 */
export async function resolveResumeToken(token: string): Promise<ResolvedLink> {
  if (typeof token !== "string" || token.length < 20) {
    throw new ResumeError("this link isn't valid", 404);
  }
  const [row] = await db
    .select()
    .from(resumeTokens)
    .where(and(eq(resumeTokens.token_hash, hash(token)), isNull(resumeTokens.revoked_at)));

  if (!row || Date.parse(row.expires_at) <= Date.now()) {
    throw new ResumeError("this link has expired or is no longer valid", 404);
  }

  await db
    .update(resumeTokens)
    .set({ last_used_at: new Date().toISOString() })
    .where(eq(resumeTokens.id, row.id));

  return { profile_id: row.profile_id, email: row.email };
}

/** Stop a link working — a shared phone, a wrong address. */
export async function revokeResumeToken(token: string): Promise<void> {
  await db
    .update(resumeTokens)
    .set({ revoked_at: new Date().toISOString() })
    .where(eq(resumeTokens.token_hash, hash(token)));
}

/** The email we already hold for a profile, if the owner gave one. */
export async function emailForProfile(profileId: string): Promise<string | null> {
  const rows = await db
    .select({ email: resumeTokens.email, created_at: resumeTokens.created_at })
    .from(resumeTokens)
    .where(eq(resumeTokens.profile_id, profileId));
  if (rows.length === 0) return null;
  return rows.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]!.email;
}

/** The full URL to hand the owner. */
export function resumeUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/resume/${token}`;
}
