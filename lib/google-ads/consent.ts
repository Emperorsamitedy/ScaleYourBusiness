// Consent to Google Ads, held as a write consent — P2-20 / P3-22, rule 13.
//
// Decided 2026-11-08 by the owner: "build google ads too". Google's only
// Google Ads scope, adwords, can change campaigns, budgets and ads as well as
// read them, so the owner grants it the way they grant Google Business
// Profile (I-45a) and Meta ad management: a typed phrase on SYB's screen,
// then Google's own consent screen, then a decision-log `consent` row whose
// hash covers what was shown, what was typed, the scope Google granted and
// the ad account picked. Consent and connection stand or fall together: if
// the log row can't be written, the fresh connection is disconnected again.
//
// The access comes in through connectForExecution: proven with Google (a
// refresh, whose answer says which scopes the grant holds), matched EXACTLY
// against the registry's one scope, encrypted at rest, never returned. With
// it SYB reads spend daily (lib/google-ads/read.ts, search endpoints only)
// and changes a campaign only through an approved proposal, executed by the
// engine (lib/execution/providers/google-ads.ts).
//
// Revoking deletes the access here at once (disconnectExecution wipes the
// secret and keeps the row, so every measured day and execution that cites
// it keeps its provenance).

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, decisionLog } from "../../db/schema";
import type { GoogleAdsEnv } from "../env";
import type { PublicExecutionConnection } from "../execution/connections";
import {
  ExecutionConnectionError,
  activeExecutionConnection,
  connectForExecution,
  disconnectExecution,
} from "../execution/connections";
import { EXECUTION_SCOPE_REGISTRY } from "../execution/scopes";
import { refreshAccess } from "../google-business/client";
import type { FetchLike, GadsCustomer } from "./client";
import { CUSTOMER_ID_RE } from "./client";

export const GOOGLE_ADS_PROVIDER = "google_ads" as const;

/** What the owner types to confirm: the act, in their words. */
export const GOOGLE_ADS_PHRASE = "allow google ads";

export function googleAdsPhraseMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === GOOGLE_ADS_PHRASE;
}

/** The consent lines, verbatim from the registry, in the order the screen shows them. */
export function googleAdsConsentLines(): string[] {
  return EXECUTION_SCOPE_REGISTRY[GOOGLE_ADS_PROVIDER].consent.map((c) => c.why);
}

/** What the encrypted secret holds. Only the read beat, the executor and the verifier open it. */
export interface GoogleAdsSecret {
  v: 1;
  refresh_token: string;
  profile_id: string;
  /** Ten digits, no hyphens. */
  customer_id: string;
  name: string;
  /** The account's currency at consent; every read re-checks it (rule 1). */
  currency: string;
  time_zone: string | null;
}

export function readGoogleAdsSecret(plain: string): GoogleAdsSecret {
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(plain) as Record<string, unknown>;
  } catch {
    throw new ExecutionConnectionError("the stored Google Ads access couldn't be read", 409);
  }
  const str = (k: string) => typeof s[k] === "string" && s[k] !== "";
  if (
    s["v"] !== 1 ||
    !str("refresh_token") ||
    !str("profile_id") ||
    !str("customer_id") ||
    !CUSTOMER_ID_RE.test(s["customer_id"] as string) ||
    !str("name") ||
    !str("currency") ||
    !/^[A-Z]{3}$/.test(s["currency"] as string)
  ) {
    throw new ExecutionConnectionError("the stored Google Ads access couldn't be read", 409);
  }
  return {
    v: 1,
    refresh_token: s["refresh_token"] as string,
    profile_id: s["profile_id"] as string,
    customer_id: s["customer_id"] as string,
    name: s["name"] as string,
    currency: s["currency"] as string,
    time_zone: typeof s["time_zone"] === "string" ? s["time_zone"] : null,
  };
}

export function hashGoogleAdsConsent(p: {
  account_id: string;
  connection_id: string;
  granted_scopes: readonly string[];
  consent_lines: readonly string[];
  typed_confirmation: string;
  customer_id: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "consent",
        account_id: p.account_id,
        connection_id: p.connection_id,
        provider: GOOGLE_ADS_PROVIDER,
        granted_scopes: [...p.granted_scopes].sort(),
        consent_lines: [...p.consent_lines],
        typed_confirmation: p.typed_confirmation,
        customer_id: p.customer_id,
      }),
    )
    .digest("hex");
}

export interface GoogleAdsConsentArgs {
  accountId: string;
  profileId: string;
  /** Idea 52: which person granted it. */
  userId: string | null;
  confirmation: string;
  refreshToken: string;
  customer: GadsCustomer;
  client: Pick<GoogleAdsEnv, "client_id" | "client_secret">;
  fetchImpl?: FetchLike;
}

/**
 * Grant: refused, with nothing stored, unless the phrase matches, the
 * business is this account's and the ad account isn't a manager; then
 * proven with Google, scope-matched exactly, encrypted, stored and logged.
 */
export async function consentToGoogleAds(
  args: GoogleAdsConsentArgs,
): Promise<{ connection: PublicExecutionConnection; consent_hash: string }> {
  if (!googleAdsPhraseMatches(args.confirmation)) {
    throw new ExecutionConnectionError(
      `type "${GOOGLE_ADS_PHRASE}" to confirm: nothing was connected`,
      422,
    );
  }
  if (args.customer.manager) {
    throw new ExecutionConnectionError(
      "that is a manager account; pick the ad account itself: nothing was connected",
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

  const secret: GoogleAdsSecret = {
    v: 1,
    refresh_token: args.refreshToken,
    profile_id: profile.id,
    customer_id: args.customer.customer_id,
    name: args.customer.name,
    currency: args.customer.currency,
    time_zone: args.customer.time_zone,
  };
  const connection = await connectForExecution({
    accountId: args.accountId,
    provider: GOOGLE_ADS_PROVIDER,
    secret: JSON.stringify(secret),
    // Proven with Google: the refresh answer names the scopes the grant holds.
    verify: async (plain) => {
      const s = readGoogleAdsSecret(plain);
      const tokens = await refreshAccess(args.client, s.refresh_token, args.fetchImpl);
      return { granted_scopes: tokens.scopes };
    },
  });
  const consent_hash = hashGoogleAdsConsent({
    account_id: args.accountId,
    connection_id: connection.id,
    granted_scopes: connection.granted_scopes,
    consent_lines: googleAdsConsentLines(),
    typed_confirmation: GOOGLE_ADS_PHRASE,
    customer_id: secret.customer_id,
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
  console.log(
    JSON.stringify({
      event: "execution_consent",
      account_id: args.accountId,
      provider: GOOGLE_ADS_PROVIDER,
      connection_id: connection.id,
    }),
  );
  return { connection, consent_hash };
}

/** The connected ad account's name and currency, for the card — never the token. */
export function googleAdsAccountOf(plain: string): {
  name: string;
  customer_id: string;
  currency: string;
} {
  const s = readGoogleAdsSecret(plain);
  return { name: s.name, customer_id: s.customer_id, currency: s.currency };
}

/**
 * Revoke: the access is deleted here at once (the row stays, its secret
 * wiped). Only this account's Google Ads connection; anything else is "not found".
 */
export async function revokeGoogleAds(
  accountId: string,
  connectionId: string,
): Promise<PublicExecutionConnection> {
  const row = await activeExecutionConnection(accountId, GOOGLE_ADS_PROVIDER);
  if (!row || row.id !== connectionId) {
    throw new ExecutionConnectionError("connection not found", 404);
  }
  const connection = await disconnectExecution(accountId, connectionId);
  console.log(
    JSON.stringify({
      event: "execution_disconnected",
      account_id: accountId,
      provider: GOOGLE_ADS_PROVIDER,
      connection_id: connection.id,
    }),
  );
  return connection;
}
