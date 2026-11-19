// Consent to Google Business Profile, held as a write consent — I-45a, rule 13.
//
// Decided 2026-11-01 by the owner: "go ahead with I-45a", then, asked how SYB
// should hold the permission, "as a write consent". Google's only Business
// Profile scope, business.manage, can also reply to reviews and edit the
// listing, so the owner grants it the way they grant Meta publishing: a
// typed phrase on SYB's screen, then Google's own consent screen, then a
// decision-log `consent` row whose hash covers what was shown, what was
// typed, the scope Google granted and the location picked. Consent and
// connection stand or fall together: if the log row can't be written, the
// fresh connection is disconnected again, so no Google access sits at rest
// without its consent on record.
//
// The access comes in through the same door as Meta's token,
// connectForExecution: proven with Google (a refresh, whose answer says
// which scopes the grant holds), matched EXACTLY against the registry's one
// scope (one more or fewer is refused by name), encrypted at rest with the
// connection-secret cipher, never returned. SYB uses it only to read reviews
// (./client.ts holds the GET-only fence).
//
// Revoking deletes the access here at once (disconnectExecution wipes the
// secret and keeps the row for provenance). Reviews already read stay on
// /reviews, each removable there, and go after their year like any other.
//
// I-45a lifted (2026-11-16): the consent lines now say SYB may post approved
// replies and change approved opening hours, and the typed phrase says so. A
// connection whose `consent` row was written under the old lines ("ScaleX
// never posts a reply") stays a reading connection: googleWriteConsentCurrent
// recomputes the hash under today's lines and phrase, and only a match lets
// the executor write. The owner reconnects to consent to the new lines.

import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, decisionLog, reviewSettings } from "../../db/schema";
import type { GoogleBusinessEnv } from "../env";
import type { PublicExecutionConnection } from "../execution/connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  connectForExecution,
  disconnectExecution,
  executionSecret,
} from "../execution/connections";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { ensureReviewSettings } from "../review-desk/settings";
import type { FetchLike, GbpLocation } from "./client";
import { refreshAccess } from "./client";

export const GOOGLE_PROVIDER = "google_business_reviews" as const;

/** What the owner types to confirm: the act, in their words. */
export const GOOGLE_REVIEWS_PHRASE = "allow replies and hours";

export function googlePhraseMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === GOOGLE_REVIEWS_PHRASE;
}

/** The consent lines, verbatim from the registry, in the order the screen shows them. */
export function googleConsentLines(): string[] {
  return EXECUTION_SCOPE_REGISTRY[GOOGLE_PROVIDER].consent.map((c) => c.why);
}

/** What the encrypted secret holds. Only the read beat and the verifier open it. */
export interface GoogleSecret {
  v: 1;
  refresh_token: string;
  profile_id: string;
  account: string;
  location: string;
  title: string;
  maps_uri: string | null;
}

export function readGoogleSecret(plain: string): GoogleSecret {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    throw new ExecutionConnectionError("the stored Google access couldn't be read", 409);
  }
  const str = (k: string) => typeof s[k] === "string" && s[k] !== "";
  if (
    s["v"] !== 1 ||
    !str("refresh_token") ||
    !str("profile_id") ||
    !str("account") ||
    !str("location") ||
    !str("title")
  ) {
    throw new ExecutionConnectionError("the stored Google access couldn't be read", 409);
  }
  return {
    v: 1,
    refresh_token: s["refresh_token"] as string,
    profile_id: s["profile_id"] as string,
    account: s["account"] as string,
    location: s["location"] as string,
    title: s["title"] as string,
    maps_uri: typeof s["maps_uri"] === "string" ? s["maps_uri"] : null,
  };
}

export function hashGoogleConsent(p: {
  account_id: string;
  connection_id: string;
  granted_scopes: readonly string[];
  consent_lines: readonly string[];
  typed_confirmation: string;
  location: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "consent",
        account_id: p.account_id,
        connection_id: p.connection_id,
        provider: GOOGLE_PROVIDER,
        granted_scopes: [...p.granted_scopes].sort(),
        consent_lines: [...p.consent_lines],
        typed_confirmation: p.typed_confirmation,
        location: p.location,
      }),
    )
    .digest("hex");
}

export interface GoogleConsentArgs {
  accountId: string;
  profileId: string;
  /** Idea 52: which person granted it. */
  userId: string | null;
  confirmation: string;
  refreshToken: string;
  location: GbpLocation;
  client: Pick<GoogleBusinessEnv, "client_id" | "client_secret">;
  fetchImpl?: FetchLike;
}

/**
 * Grant: refused, with nothing stored, unless the phrase matches and the
 * business is this account's; then proven with Google, scope-matched
 * exactly, encrypted, stored and logged.
 */
export async function consentToGoogleReviews(
  args: GoogleConsentArgs,
): Promise<{ connection: PublicExecutionConnection; consent_hash: string }> {
  if (!googlePhraseMatches(args.confirmation)) {
    throw new ExecutionConnectionError(
      `type "${GOOGLE_REVIEWS_PHRASE}" to confirm: nothing was connected`,
      422,
    );
  }
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(
      and(eq(businessProfiles.id, args.profileId), eq(businessProfiles.account_id, args.accountId)),
    );
  if (!profile) throw new ExecutionConnectionError("no such business on this account", 404);

  const secret: GoogleSecret = {
    v: 1,
    refresh_token: args.refreshToken,
    profile_id: profile.id,
    account: args.location.account,
    location: args.location.location,
    title: args.location.title,
    maps_uri: args.location.maps_uri,
  };
  const connection = await connectForExecution({
    accountId: args.accountId,
    provider: GOOGLE_PROVIDER,
    secret: JSON.stringify(secret),
    // Proven with Google: the refresh answer names the scopes the grant holds.
    verify: async (plain) => {
      const s = readGoogleSecret(plain);
      const tokens = await refreshAccess(args.client, s.refresh_token, args.fetchImpl);
      return { granted_scopes: tokens.scopes };
    },
  });
  const consent_hash = hashGoogleConsent({
    account_id: args.accountId,
    connection_id: connection.id,
    granted_scopes: connection.granted_scopes,
    consent_lines: googleConsentLines(),
    typed_confirmation: GOOGLE_REVIEWS_PHRASE,
    location: `${secret.account}/${secret.location}`,
  });
  try {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "consent",
      ref_id: connection.id,
      payload_hash: consent_hash,
      user_id: args.userId,
    });
  } catch (error) {
    // No consent on record means no access at rest.
    await disconnectExecution(args.accountId, connection.id);
    throw error;
  }
  try {
    await ensureReviewSettings(profile.id);
    await db
      .update(reviewSettings)
      .set({ google_location_title: secret.title, google_read_at: null, google_read_outcome: null })
      .where(eq(reviewSettings.profile_id, profile.id));
  } catch (error) {
    // The consent stands; the screen just can't name the location yet.
    console.error(
      JSON.stringify({
        event: "google_consent_settings_failed",
        account_id: args.accountId,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
  console.log(
    JSON.stringify({
      event: "execution_consent",
      account_id: args.accountId,
      provider: GOOGLE_PROVIDER,
      connection_id: connection.id,
    }),
  );
  return { connection, consent_hash };
}

/**
 * Does this account's live Google connection carry a consent to TODAY's
 * lines — the ones that allow replies and hours changes? Recomputed from the
 * connection, its location and the registry's lines, and matched against
 * the connection's latest `consent` row. Reads only.
 */
export async function googleWriteConsentCurrent(accountId: string): Promise<boolean> {
  const row = await activeExecutionConnection(accountId, GOOGLE_PROVIDER);
  if (!row || row.status !== "connected") return false;
  let secret: GoogleSecret;
  try {
    secret = readGoogleSecret(executionSecret(row));
  } catch {
    return false;
  }
  const [logged] = await db
    .select({ hash: decisionLog.payload_hash })
    .from(decisionLog)
    .where(and(eq(decisionLog.kind, "consent"), eq(decisionLog.ref_id, row.id)))
    .orderBy(desc(decisionLog.at))
    .limit(1);
  if (!logged) return false;
  return (
    logged.hash ===
    hashGoogleConsent({
      account_id: accountId,
      connection_id: row.id,
      granted_scopes: row.granted_scopes,
      consent_lines: googleConsentLines(),
      typed_confirmation: GOOGLE_REVIEWS_PHRASE,
      location: `${secret.account}/${secret.location}`,
    })
  );
}

/** The listing ScaleX may change for this business, or null when its Google connection can't write. */
export async function googleWritableListing(
  accountId: string,
  profileId: string,
): Promise<{ location: string; title: string } | null> {
  if (!(await googleWriteConsentCurrent(accountId))) return null;
  const row = await activeExecutionConnection(accountId, GOOGLE_PROVIDER);
  if (!row) return null;
  const secret = readGoogleSecret(executionSecret(row));
  return secret.profile_id === profileId
    ? { location: secret.location, title: secret.title }
    : null;
}

/**
 * Revoke: the access is deleted here at once (the row stays, its secret
 * wiped). Only this account's Google connection; anything else is "not found".
 */
export async function revokeGoogleReviews(
  accountId: string,
  connectionId: string,
): Promise<PublicExecutionConnection> {
  const row = await activeExecutionConnection(accountId, GOOGLE_PROVIDER);
  if (!row || row.id !== connectionId) {
    throw new ExecutionConnectionError("connection not found", 404);
  }
  const connection = await disconnectExecution(accountId, connectionId);
  await db
    .update(reviewSettings)
    .set({ google_location_title: null, google_read_outcome: null })
    .where(eq(reviewSettings.account_id, accountId));
  console.log(
    JSON.stringify({
      event: "execution_disconnected",
      account_id: accountId,
      provider: GOOGLE_PROVIDER,
      connection_id: connection.id,
    }),
  );
  return connection;
}
