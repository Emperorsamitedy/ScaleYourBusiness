// Consent to write access — P3-20h (Session D, layer D1), rule 13.
//
// The consent screen's server side: the owner typed the confirmation
// phrase, the credential is proven and scope-matched (connectForExecution),
// and the consent is a decision-log row whose hash covers what was shown
// and what was typed. Consent and connection stand or fall together: if
// the log write fails, the fresh connection is disconnected again, so no
// write credential ever sits at rest without its consent on record.
//
// Consent to publishing also picks up the drafts already waiting: every
// drafted item with no publish proposal is offered for publishing now
// (P3-21a), so connecting Meta isn't a dead end for what was drafted
// before it. That step can fail without touching the consent.
//
// Consent is also how a PAUSED connection comes back (P3-24b): the pasted
// route and the Facebook-login finish both land here, connectForExecution
// retires the paused row for the new one, and — once the consent is on
// record — the work the pause held resumes from the journal
// (resumeAfterReconnect). That step, too, can fail without touching the
// consent; the due runner's own sweep picks it up on its next run.

import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, contentItems, decisionLog } from "../../db/schema";
import { proposePublishing } from "../content/publish";
import type { LimitLlm } from "../proposals/hard-limits";
import type { CredentialVerifier, PublicExecutionConnection } from "./connections";
import { ExecutionConnectionError, connectForExecution, disconnectExecution } from "./connections";
import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY, isExecutionProviderId } from "./scopes";
import { isPausableProvider, resumeAfterReconnect } from "./pause";
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

/**
 * After consent to publishing: offer every waiting draft for publishing.
 * Logged, never thrown — the consent and connection already stand.
 */
async function proposeWaitingDrafts(
  profileId: string,
  provider: ExecutionProviderId,
  args: ConsentArgs,
): Promise<number> {
  if (provider !== "meta_publish") return 0;
  try {
    const waiting = await db
      .select({ id: contentItems.id })
      .from(contentItems)
      .where(
        and(
          eq(contentItems.profile_id, profileId),
          eq(contentItems.status, "drafted"),
          isNull(contentItems.publish_proposal_id),
        ),
      );
    const run = await proposePublishing(
      profileId,
      waiting.map((w) => w.id),
      {
        ...(args.limitLlm ? { limitLlm: args.limitLlm } : {}),
        ...(args.now ? { now: args.now } : {}),
      },
    );
    return run.created.length;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "consent_publish_proposals_failed",
        account_id: args.accountId,
        profile_id: profileId,
        name: error instanceof Error ? error.name : "unknown",
      }),
    );
    return 0;
  }
}

export interface ConsentArgs {
  accountId: string;
  provider: string;
  secret: string;
  confirmation: string;
  verify: CredentialVerifier;
  /** Passed to the hard limits when waiting drafts are proposed (tests use a stand-in). */
  limitLlm?: LimitLlm;
  now?: Date;
  /** I-52d: the signed-in person who consented, recorded on the log entry. */
  userId?: string | null;
}

/**
 * Connect a write credential with the owner's recorded consent. Refused,
 * with nothing stored, unless the provider is offered and the typed phrase
 * matches; then proven, scope-matched, encrypted, and logged.
 */
export async function consentToExecution(args: ConsentArgs): Promise<{
  connection: PublicExecutionConnection;
  consent_hash: string;
  proposed: number;
  /** P3-24b: items and held runs a reconnect put back in motion. */
  resumed: number;
}> {
  if (!isExecutionProviderId(args.provider) || !OFFERED_EXECUTION.includes(args.provider)) {
    throw new ExecutionConnectionError(`"${args.provider}" is not offered for execution`, 422);
  }
  const provider = args.provider;
  if (!confirmationMatches(provider, args.confirmation)) {
    throw new ExecutionConnectionError(
      `type "${EXECUTION_SETUP[provider]?.confirm_phrase}" to confirm: nothing was connected`,
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
      user_id: args.userId ?? null,
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
  let resumed = 0;
  if (isPausableProvider(provider)) {
    try {
      const out = await resumeAfterReconnect({
        accountId: args.accountId,
        provider,
        announce: true,
      });
      resumed = out.reduce((n, o) => n + o.items + o.runs, 0);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "consent_resume_failed",
          account_id: args.accountId,
          provider,
          name: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  }
  return {
    connection,
    consent_hash,
    proposed: await proposeWaitingDrafts(profile.id, provider, args),
    resumed,
  };
}
