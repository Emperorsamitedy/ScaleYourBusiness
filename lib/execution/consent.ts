// Consent to write access — P3-20h (Session D, layer D1), rule 13.
//
// The consent screen's server side: the owner typed the confirmation
// phrase, the credential is proven and scope-matched (connectForExecution),
// and the consent is a decision-log row whose hash covers what was shown
// and what was typed. Consent and connection stand or fall together: if
// the log write fails, the fresh connection is disconnected again, so no
// write credential ever sits at rest without its consent on record.

import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, decisionLog } from "../../db/schema";
import type { CredentialVerifier, PublicExecutionConnection } from "./connections";
import { ExecutionConnectionError, connectForExecution, disconnectExecution } from "./connections";
import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY, isExecutionProviderId } from "./scopes";
import { EXECUTION_SETUP, OFFERED_EXECUTION, confirmationMatches } from "./setup";

export interface ConsentPayload {
  account_id: string;
  connection_id: string;
  provider: ExecutionProviderId;
  granted_scopes: readonly string[];
  /** The registry's consent lines as the screen rendered them. */
  consent_lines: readonly string[];
  typed_confirmation: string;
}

export function hashConsentPayload(p: ConsentPayload): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "consent",
        account_id: p.account_id,
        connection_id: p.connection_id,
        provider: p.provider,
        granted_scopes: [...p.granted_scopes].sort(),
        consent_lines: [...p.consent_lines],
        typed_confirmation: p.typed_confirmation,
      }),
    )
    .digest("hex");
}

/** The consent lines, verbatim from the registry, in the order the screen shows them. */
export function consentLines(provider: ExecutionProviderId): string[] {
  return EXECUTION_SCOPE_REGISTRY[provider].consent.map((c) => c.why);
}

export interface ConsentArgs {
  accountId: string;
  provider: string;
  secret: string;
  confirmation: string;
  verify: CredentialVerifier;
}

/**
 * Connect a write credential with the owner's recorded consent. Refused,
 * with nothing stored, unless the provider is offered and the typed phrase
 * matches; then proven, scope-matched, encrypted, and logged.
 */
export async function consentToExecution(
  args: ConsentArgs,
): Promise<{ connection: PublicExecutionConnection; consent_hash: string }> {
  if (!isExecutionProviderId(args.provider) || !OFFERED_EXECUTION.includes(args.provider)) {
    throw new ExecutionConnectionError(`"${args.provider}" is not offered for execution`, 422);
  }
  const provider = args.provider;
  if (!confirmationMatches(provider, args.confirmation)) {
    throw new ExecutionConnectionError(
      `type "${EXECUTION_SETUP[provider]?.confirm_phrase}" to confirm — nothing was connected`,
      422,
    );
  }
  const [profile] = await db
    .select({ id: businessProfiles.id })
    .from(businessProfiles)
    .where(eq(businessProfiles.account_id, args.accountId))
    .orderBy(asc(businessProfiles.created_at))
    .limit(1);
  if (!profile) {
    throw new ExecutionConnectionError("no business profile on this account yet", 409);
  }

  const connection = await connectForExecution({
    accountId: args.accountId,
    provider,
    secret: args.secret,
    verify: args.verify,
  });
  const consent_hash = hashConsentPayload({
    account_id: args.accountId,
    connection_id: connection.id,
    provider,
    granted_scopes: connection.granted_scopes,
    consent_lines: consentLines(provider),
    typed_confirmation: args.confirmation.trim().toLowerCase(),
  });
  try {
    await db.insert(decisionLog).values({
      profile_id: profile.id,
      actor: "owner",
      kind: "consent",
      ref_id: connection.id,
      payload_hash: consent_hash,
    });
  } catch (error) {
    // No consent on record means no credential at rest.
    await disconnectExecution(args.accountId, connection.id);
    throw error;
  }
  console.log(
    JSON.stringify({
      event: "execution_consent",
      account_id: args.accountId,
      provider,
      connection_id: connection.id,
    }),
  );
  return { connection, consent_hash };
}
