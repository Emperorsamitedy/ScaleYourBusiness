// Execution connections — P3-20b (Session D, layer D0), rule 13.
//
// Write access is its own consent, never an upgrade. A write credential
// lives in the same `connections` table as the read-only ones, under
// purpose = "execute", and comes in through THIS door only. The read
// side's connect() refuses every write-capable scope (rule 9) and never
// sees these rows; this side accepts a credential only when what the
// provider says it was granted is EXACTLY the registry's write scopes
// plus the declared readback scopes — one scope more or fewer is refused
// by name, so the owner can see which permission to add or remove.
//
// The same order as the read side, and it must not be reordered: prove
// the credential (the injected verifier asks the platform), compare the
// scopes, encrypt, store. A credential that fails either check never
// touches the database. Nothing here returns a row with the secret on it.

import { and, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { connections } from "../../db/schema";
import { decryptSecret, encryptSecret } from "../connectors/secrets";
import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY, isExecutionProviderId } from "./scopes";
import type { CredentialVerifier } from "./verify";
import { ExecutionConnectionError, unique, verifyExecutionScopes } from "./verify";

// The pure half lives in ./verify so providers can refuse by name without
// a database; re-exported so callers keep one import.
export type { CredentialProof, CredentialVerifier } from "./verify";
export { ExecutionConnectionError, expectedExecutionScopes, verifyExecutionScopes } from "./verify";

export type ExecutionConnectionRow = typeof connections.$inferSelect;

/** What any API may say about an execute connection. No secret member exists on this type. */
export interface PublicExecutionConnection {
  id: string;
  account_id: string;
  provider: string;
  label: string;
  purpose: "execute";
  status: ExecutionConnectionRow["status"];
  granted_scopes: string[];
  failure_count: number;
  last_error: string | null;
  created_at: string;
  disconnected_at: string | null;
}

export function toPublicExecutionConnection(
  row: ExecutionConnectionRow,
): PublicExecutionConnection {
  const label = isExecutionProviderId(row.provider)
    ? EXECUTION_SCOPE_REGISTRY[row.provider].label
    : row.provider;
  return {
    id: row.id,
    account_id: row.account_id,
    provider: row.provider,
    label,
    purpose: "execute",
    status: row.status,
    granted_scopes: row.granted_scopes,
    failure_count: row.failure_count,
    last_error: row.last_error,
    created_at: row.created_at,
    disconnected_at: row.disconnected_at,
  };
}

/** The live execute connection for (account, provider), if any. Internal: carries the secret. */
export async function activeExecutionConnection(
  accountId: string,
  provider: ExecutionProviderId,
): Promise<ExecutionConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, provider),
        eq(connections.purpose, "execute"),
        ne(connections.status, "disconnected"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The credential at rest, decrypted for a provider call. Never logged, never returned. */
export function executionSecret(row: ExecutionConnectionRow): string {
  if (row.purpose !== "execute") {
    throw new ExecutionConnectionError("not an execute connection", 422);
  }
  if (row.encrypted_secret === null) {
    throw new ExecutionConnectionError("no credential at rest — reconnect the provider", 409);
  }
  return decryptSecret(row.encrypted_secret);
}

export interface ConnectForExecutionArgs {
  accountId: string;
  provider: string;
  secret: string;
  verify: CredentialVerifier;
}

/**
 * Connect a write credential. Proven with the platform, scope-matched
 * exactly, encrypted and stored — in that order — and never returned.
 */
export async function connectForExecution(
  args: ConnectForExecutionArgs,
): Promise<PublicExecutionConnection> {
  if (!isExecutionProviderId(args.provider)) {
    throw new ExecutionConnectionError(`unknown execution provider "${args.provider}"`, 400);
  }
  const provider = args.provider;
  if (args.secret.trim() === "") {
    throw new ExecutionConnectionError("a credential is required", 400);
  }
  if (await activeExecutionConnection(args.accountId, provider)) {
    throw new ExecutionConnectionError(
      `${EXECUTION_SCOPE_REGISTRY[provider].label} is already connected for execution — disconnect it first`,
      409,
    );
  }

  const proof = await args.verify(args.secret);
  verifyExecutionScopes(provider, proof.granted_scopes);

  const [row] = await db
    .insert(connections)
    .values({
      account_id: args.accountId,
      provider,
      purpose: "execute",
      status: "connected",
      encrypted_secret: encryptSecret(args.secret),
      granted_scopes: unique(proof.granted_scopes),
    })
    .returning();
  if (!row) throw new ExecutionConnectionError("connection could not be stored", 500);
  console.log(
    JSON.stringify({
      event: "execution_connected",
      account_id: args.accountId,
      provider,
      connection_id: row.id,
    }),
  );
  return toPublicExecutionConnection(row);
}

/**
 * Revoke locally: the secret is wiped and the row stays, so every
 * execution and readback row that cites it keeps its provenance. Only a
 * connection this account owns; a foreign one is "not found".
 */
export async function disconnectExecution(
  accountId: string,
  connectionId: string,
): Promise<PublicExecutionConnection> {
  const [row] = await db
    .update(connections)
    .set({
      status: "disconnected",
      encrypted_secret: null,
      disconnected_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.account_id, accountId),
        eq(connections.purpose, "execute"),
        ne(connections.status, "disconnected"),
      ),
    )
    .returning();
  if (!row) throw new ExecutionConnectionError("connection not found", 404);
  return toPublicExecutionConnection(row);
}

export async function listExecutionConnections(
  accountId: string,
): Promise<PublicExecutionConnection[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.account_id, accountId), eq(connections.purpose, "execute")))
    .orderBy(connections.created_at);
  return rows.map(toPublicExecutionConnection);
}
