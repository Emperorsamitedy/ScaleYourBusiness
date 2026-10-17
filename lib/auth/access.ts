// Who may act on a business profile — the security review of 2026-10-17.
//
// The intake cookie used to be the raw profile UUID, trusted after a row
// lookup: anyone holding a profile id (from a log line, a media URL, a
// shoulder) could read that business's customers and decide its
// proposals. Two rules replace that, in ONE place every route calls:
//
//   1. The cookie is SIGNED. Its value is `<profile id>.<hmac>`, keyed by
//      a secret only the server holds, so a leaked id alone opens nothing.
//      A legacy unsigned cookie is honoured only for a profile nobody owns
//      yet (an anonymous intake in progress), and is re-issued signed.
//
//   2. An OWNED profile needs its owner. Once an account has a user, every
//      read and write on its profile requires a signed-in session for THAT
//      account. A session for some other account never counts, and the
//      session handed to routes is only ever a matching one — so "signed
//      in" can never again mean "signed in as anybody".
//
// An unowned profile (the intake before sign-up) stays cookie-only by
// design: that is the product's "answer first, sign up later" path, and
// the signature is what protects it.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "../../db";
import { accounts, businessProfiles, users } from "../../db/schema";
import type { AuthedSession } from "./service";
import { currentSession } from "./service";

export const INTAKE_COOKIE = "syb_intake_profile";
export const AUTH_COOKIE = "syb_session";
export const INTAKE_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedKey: Buffer | null = null;

/** The signing key: HKDF over COOKIE_SECRET, or CONNECTOR_KEY when that is unset. Never logged. */
function cookieKey(): Buffer {
  if (cachedKey) return cachedKey;
  const material = process.env.COOKIE_SECRET || process.env.CONNECTOR_KEY;
  if (!material) {
    throw new Error(
      "Missing COOKIE_SECRET (or CONNECTOR_KEY) — the intake cookie cannot be signed without one",
    );
  }
  cachedKey = Buffer.from(
    hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), "syb-intake-cookie-v1", 32),
  );
  return cachedKey;
}

function mac(profileId: string): string {
  return createHmac("sha256", cookieKey()).update(`intake:${profileId}`).digest("base64url");
}

/** The cookie value for a profile: `<id>.<signature>`. */
export function signProfileCookie(profileId: string): string {
  return `${profileId}.${mac(profileId)}`;
}

export type ParsedCookie =
  { profileId: string; signed: true } | { profileId: string; signed: false } | null;

/** Pure: a cookie value as a profile id, signed or legacy. Anything else is null. */
export function parseProfileCookie(raw: string | undefined | null): ParsedCookie {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot === -1) return UUID_RE.test(raw) ? { profileId: raw, signed: false } : null;
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!UUID_RE.test(id)) return null;
  const want = Buffer.from(mac(id));
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return { profileId: id, signed: true };
}

/** The cookie options every setter uses — one definition, so they can't drift. */
export function intakeCookieOptions(maxAge = INTAKE_COOKIE_MAX_AGE) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge,
  };
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 90,
  };
}

export interface Access {
  profile_id: string;
  account_id: string;
  /** True once the account has an owner — then a matching session is required. */
  owned: boolean;
  /** The caller's session, ONLY if it belongs to this profile's account. */
  session: AuthedSession | null;
}

/**
 * Pure: the access decision, given what was looked up. Exported for the
 * tests that hold every branch of it.
 */
export function decideAccess(args: {
  cookie: ParsedCookie;
  profile: { id: string; account_id: string; owner_user_id: string | null } | null;
  session: AuthedSession | null;
}): Access | null {
  const { cookie, profile, session } = args;
  if (!cookie || !profile || profile.id !== cookie.profileId) return null;
  const owned = profile.owner_user_id !== null;
  const matching = session && session.account_id === profile.account_id ? session : null;
  // An owned business opens only to its own account. An unowned one (an
  // anonymous intake) opens to its cookie, signed or legacy.
  if (owned && !matching) return null;
  return { profile_id: profile.id, account_id: profile.account_id, owned, session: matching };
}

async function profileRow(profileId: string) {
  const [row] = await db
    .select({
      id: businessProfiles.id,
      account_id: businessProfiles.account_id,
      owner_user_id: accounts.owner_user_id,
      // Any user on the account makes it owned, even one created before
      // owner_user_id existed: "owned" must never under-count.
      has_user: sql<boolean>`exists (select 1 from ${users} where ${users.account_id} = ${accounts.id})`,
    })
    .from(businessProfiles)
    .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
    .where(eq(businessProfiles.id, profileId));
  if (!row) return null;
  return {
    id: row.id,
    account_id: row.account_id,
    owner_user_id: row.owner_user_id ?? (row.has_user ? "user" : null),
  };
}

/**
 * The one door every profile route goes through. Null = no access (the
 * route answers 401). A legacy cookie that passes is re-issued signed.
 */
export async function resolveAccess(): Promise<Access | null> {
  const store = await cookies();
  const cookie = parseProfileCookie(store.get(INTAKE_COOKIE)?.value);
  if (!cookie) return null;
  const [profile, session] = await Promise.all([
    profileRow(cookie.profileId),
    currentSession(store.get(AUTH_COOKIE)?.value),
  ]);
  const access = decideAccess({ cookie, profile, session });
  if (access && !cookie.signed) {
    try {
      store.set(INTAKE_COOKIE, signProfileCookie(access.profile_id), intakeCookieOptions());
    } catch {
      // Read-only cookie store (a server component render): re-signing waits for the next route.
    }
  }
  return access;
}

/**
 * For sign-in: the profile a new user may CLAIM — only one nobody owns,
 * named by a valid cookie. An owned profile is never joined by a login.
 */
export async function claimableProfile(rawCookie: string | undefined): Promise<string | null> {
  const cookie = parseProfileCookie(rawCookie);
  if (!cookie) return null;
  const profile = await profileRow(cookie.profileId);
  return profile && profile.owner_user_id === null ? profile.id : null;
}

/** The caller's session, only if it belongs to the profile in the cookie. For signed-in-only writes. */
export async function matchingSession(): Promise<AuthedSession | null> {
  return (await resolveAccess())?.session ?? null;
}
