// Completing a sign-in: a spent link or code, or an email an OAuth provider
// proved, becomes a user, a session and (L8) a first business.
//
// It lives apart from ./service on purpose. That file resolves the session
// cookie, so every route in the app loads it, the push send path among them.
// Giving a person their first business needs the intake service and the
// ladder, which reach the connectors and the execution scopes, and the push
// path may reach neither (lib/push/no-connector.test.ts). So the three
// routes that complete a sign-in import this file, and nothing else does.

import { timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { accounts, authSessions, businessProfiles, loginTokens, users } from "../../db/schema";
import { withinRateLimit } from "../core/rate-limit";
import { adoptLanguage } from "../i18n/service";
import { normaliseEmail } from "../intake/resume";
import { ensureProfile } from "../intake/service";
import { startShadowPeriod } from "../ladder/ladder";
import { joinByInviteId } from "./members";
import type { RedeemedSession, SignInChoices } from "./service";
import {
  AuthError,
  CODE_LIMIT_PER_EMAIL,
  CODE_LIMIT_PER_IP,
  CODE_REFUSED,
  CODE_TOO_MANY,
  CODE_WINDOW_MS,
  cleanChoices,
  codeHash,
  createOwner,
  hash,
  normaliseCode,
  openSession,
} from "./service";

/** What a sign-in may do beyond signing the person in. */
export interface SignInOptions {
  /**
   * L8: a person with no business yet gets one, so they land in the app and
   * are offered the interview there. False when the sign-in is on its way to
   * keeping an idea, which makes its own business (lib/ideas/keep.ts): an
   * empty operating business beside it would only be clutter.
   */
  business?: boolean;
}

/**
 * Redeem a login link. One-shot: a token that has been used, expired,
 * or never existed all fail the same way, with nothing to enumerate.
 */
export async function redeemLogin(
  token: string,
  options: SignInOptions = {},
): Promise<RedeemedSession> {
  const now = new Date().toISOString();
  const [row] = await db
    .select()
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.token_hash, hash(token)),
        isNull(loginTokens.used_at),
        gt(loginTokens.expires_at, now),
      ),
    );
  if (!row) throw new AuthError("that sign-in link is no longer valid", 401);
  return spendLogin(row, now, "that sign-in link is no longer valid", options);
}

/**
 * Redeem the 6-digit code from a sign-in email instead of its link. Any of
 * the address's live codes works (a resend issues another without killing
 * the first); the one that matches is spent exactly as its link would be.
 */
export async function redeemLoginCode(
  rawEmail: string,
  rawCode: unknown,
  /** The caller's address, as the platform reports it — for the per-IP limit only. */
  clientIp?: string | null,
  options: SignInOptions = {},
): Promise<RedeemedSession> {
  const email = normaliseEmail(rawEmail);
  if (!(await withinRateLimit(`login-code:email:${email}`, CODE_LIMIT_PER_EMAIL, CODE_WINDOW_MS))) {
    throw new AuthError(CODE_TOO_MANY, 429);
  }
  const ip = clientIp?.trim();
  if (ip && !(await withinRateLimit(`login-code:ip:${ip}`, CODE_LIMIT_PER_IP, CODE_WINDOW_MS))) {
    throw new AuthError(CODE_TOO_MANY, 429);
  }
  const code = normaliseCode(rawCode);
  if (!code) throw new AuthError(CODE_REFUSED, 401);

  const now = new Date().toISOString();
  const live = await db
    .select()
    .from(loginTokens)
    .where(
      and(
        eq(loginTokens.email, email),
        isNull(loginTokens.used_at),
        gt(loginTokens.expires_at, now),
      ),
    );
  const row = live.find((r) => {
    if (!r.code_hash) return false;
    const want = Buffer.from(r.code_hash);
    const got = Buffer.from(codeHash(r.token_hash, code));
    return want.length === got.length && timingSafeEqual(want, got);
  });
  if (!row) throw new AuthError(CODE_REFUSED, 401);
  return spendLogin(row, now, CODE_REFUSED, options);
}

/** Spend a live login token — link or code — and sign its owner in. */
async function spendLogin(
  row: typeof loginTokens.$inferSelect,
  now: string,
  refusal: string,
  options: SignInOptions = {},
): Promise<RedeemedSession> {
  // Claimed atomically: of two concurrent redeems, only the one that flips
  // used_at from null wins — the other gets the same refusal as a used link.
  const claimed = await db
    .update(loginTokens)
    .set({ used_at: now })
    .where(and(eq(loginTokens.id, row.id), isNull(loginTokens.used_at)))
    .returning({ id: loginTokens.id });
  if (claimed.length === 0) throw new AuthError(refusal, 401);

  if (row.invite_id) {
    const joined = await joinByInviteId(row.invite_id, row.email);
    return { ...joined, language: await adoptLanguage(joined.user_id, row.language) };
  }
  return signInWithEmail(
    row.email,
    row.profile_id,
    { language: row.language, currency: row.currency },
    options,
  );
}

/**
 * The account side of any proven sign-in — shared by the emailed link
 * and the OAuth callbacks, which each prove email ownership their own
 * way before landing here.
 *
 * Existing user for this email → their account (the most recently used
 * one, when there are several). Otherwise create the user on the account
 * of the profile the browser held — the "claim your anonymous intake"
 * path. With neither, a fresh account.
 *
 * L8: whichever account it is, a person with no business yet gets one here
 * (an empty profile, in its shadow month from this moment), so they land in
 * the app and are offered the interview there. An account made before this
 * and left without a business gets one on its next sign-in.
 */
export async function signInWithEmail(
  rawEmail: string,
  profileId: string | null,
  /** L-1: the browser's language and currency choices (see SignInChoices). */
  choices?: SignInChoices,
  options: SignInOptions = {},
): Promise<RedeemedSession> {
  const email = normaliseEmail(rawEmail);
  const chosen = cleanChoices(choices);
  // Removed rows sign in to nothing. The most recently used business first.
  const rows = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), isNull(users.removed_at)))
    .orderBy(
      sql`(select max(${authSessions.created_at}) from ${authSessions} where ${authSessions.user_id} = ${users.id}) desc nulls last`,
      users.created_at,
    );
  let user = rows[0];
  if (!user) {
    let accountId: string | null = null;
    if (profileId) {
      const [profile] = await db
        .select({ account_id: businessProfiles.account_id })
        .from(businessProfiles)
        .where(eq(businessProfiles.id, profileId));
      if (!profile) throw new AuthError("that sign-in is no longer valid", 401);
      // Never join an account that already has a user: a profile id is not
      // proof of anything (the security review of 2026-10-17). Such a
      // sign-in gets its own fresh account instead.
      const [someone] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.account_id, profile.account_id))
        .limit(1);
      if (!someone) accountId = profile.account_id;
    }
    if (accountId === null) {
      const [account] = await db
        .insert(accounts)
        .values({
          // L-1: the currency chosen at sign-up, else the default the intake may set from the country.
          reporting_currency: chosen.currency ?? "HUF",
          reporting_currency_chosen_at: chosen.currency ? new Date().toISOString() : null,
          locale: "en-GB",
        })
        .returning({ id: accounts.id });
      if (!account) throw new AuthError("could not create the account", 500);
      accountId = account.id;
    }
    user = await createOwner(accountId, email);
  }

  if (options.business !== false) {
    const business = await ensureProfile(user.account_id, { language: chosen.language });
    // The v1 spec §4.2 (D35): a new business's first 30 days are shadow.
    if (business.created) await startShadowPeriod(business.profile_id);
  }

  return {
    ...(await openSession(user)),
    choose: rows.length > 1,
    language: await adoptLanguage(user.id, chosen.language),
  };
}
