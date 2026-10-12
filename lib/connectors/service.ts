// Connections and observations — P2-01 / P2-02.
//
// connect() is the only path that stores a provider secret, and it does
// three things in order that must not be reordered: prove the secret
// works, verify the scopes it carries against the registry (P2-04), and
// only then encrypt and store (P2-03). A secret that fails either check
// never touches the database.
//
// Nothing here returns a row with encrypted_secret on it. PublicConnection
// is an explicit field list — not an Omit<> over the row type — so adding
// a column to the table cannot silently widen what an API hands out.

import { and, eq, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { connections, metricObservations } from "../../db/schema";
import { isoDate, isoDateTime } from "../core/iso";
import { money } from "../core/money";
import type { Observation, ObservationDimensions } from "./provider";
import { MONEY_METRICS, ProviderError, isMetricKey } from "./provider";
import { getProvider } from "./registry";
import { encryptSecret } from "./secrets";
import type { ProviderId } from "./scopes";
import { ScopeViolationError, isProviderId, verifyGrantedScopes } from "./scopes";

export class ConnectorError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
  }
}

export type ConnectionRow = typeof connections.$inferSelect;
export type ConnectionStatus = ConnectionRow["status"];

/** What any API may say about a connection. No secret member exists on this type. */
export interface PublicConnection {
  id: string;
  account_id: string;
  provider: string;
  /** Owner-facing provider name, e.g. "Stripe". */
  label: string;
  /** Whether granted_scopes were reported by the provider or only probed (provider.ts). */
  scope_verification: "reported" | "probed";
  /** Always "measure" here (P3-20b): execute rows have their own module and type. */
  purpose: "measure";
  status: ConnectionStatus;
  granted_scopes: string[];
  cursor: string | null;
  last_sync_at: string | null;
  failure_count: number;
  last_error: string | null;
  created_at: string;
  disconnected_at: string | null;
}

export function toPublicConnection(row: ConnectionRow): PublicConnection {
  const provider = isProviderId(row.provider) ? getProvider(row.provider) : null;
  return {
    id: row.id,
    account_id: row.account_id,
    provider: row.provider,
    label: provider?.label ?? row.provider,
    // A provider the registry doesn't know can't vouch for anything.
    scope_verification: provider?.scopeVerification ?? "probed",
    purpose: "measure",
    status: row.status,
    granted_scopes: row.granted_scopes,
    cursor: row.cursor,
    last_sync_at: row.last_sync_at,
    failure_count: row.failure_count,
    last_error: row.last_error,
    created_at: row.created_at,
    disconnected_at: row.disconnected_at,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A connection, only if this account owns it: the API's ownership check.
 * Another account's connection is "not found", never "forbidden", so there
 * is nothing to enumerate. Internal: the row carries the secret.
 */
export async function ownedConnection(
  accountId: string,
  connectionId: string,
): Promise<ConnectionRow> {
  if (!UUID_RE.test(connectionId)) throw new ConnectorError("connection not found", 404);
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.id, connectionId),
        eq(connections.account_id, accountId),
        // P3-20b: the measurement side owns measure rows only. An execute
        // connection is "not found" here — its own module manages it.
        eq(connections.purpose, "measure"),
      ),
    );
  if (!row) throw new ConnectorError("connection not found", 404);
  return row;
}

/** Disconnect, but only a connection this account owns. */
export async function disconnectForAccount(
  accountId: string,
  connectionId: string,
): Promise<PublicConnection> {
  await ownedConnection(accountId, connectionId);
  return disconnect(connectionId);
}

/** The live connection for (account, provider), if any. Internal: carries the secret. */
export async function activeConnection(
  accountId: string,
  provider: ProviderId,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.provider, provider),
        eq(connections.purpose, "measure"),
        ne(connections.status, "disconnected"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Connect a provider to an account. The secret is proven, scope-checked,
 * encrypted and stored — in that order — and never returned.
 */
export async function connect(
  accountId: string,
  providerId: string,
  secret: string,
): Promise<PublicConnection> {
  if (!isProviderId(providerId)) {
    throw new ConnectorError(`unknown provider "${providerId}"`, 400);
  }
  if (secret.trim() === "") {
    throw new ConnectorError("a credential is required", 400);
  }
  if (await activeConnection(accountId, providerId)) {
    throw new ConnectorError(`${providerId} is already connected — disconnect it first`, 409);
  }

  let granted: string[];
  try {
    granted = (await getProvider(providerId).connect(secret)).granted_scopes;
  } catch (error) {
    if (error instanceof ProviderError) throw new ConnectorError(error.message, 400);
    throw error;
  }
  try {
    verifyGrantedScopes(providerId, granted);
  } catch (error) {
    if (error instanceof ScopeViolationError) throw new ConnectorError(error.message, 422);
    throw error;
  }

  const [row] = await db
    .insert(connections)
    .values({
      account_id: accountId,
      provider: providerId,
      purpose: "measure",
      status: "connected",
      encrypted_secret: encryptSecret(secret),
      granted_scopes: granted,
    })
    .returning();
  if (!row) throw new ConnectorError("connection could not be stored", 500);
  return toPublicConnection(row);
}

/**
 * Revoke locally: the secret is wiped and sync stops. The row stays —
 * every observation it produced cites it as provenance.
 */
export async function disconnect(connectionId: string): Promise<PublicConnection> {
  const [row] = await db
    .update(connections)
    .set({
      status: "disconnected",
      encrypted_secret: null,
      disconnected_at: new Date().toISOString(),
    })
    .where(and(eq(connections.id, connectionId), ne(connections.status, "disconnected")))
    .returning();
  if (!row) throw new ConnectorError("connection not found", 404);
  return toPublicConnection(row);
}

export async function pauseConnection(connectionId: string): Promise<PublicConnection> {
  const [row] = await db
    .update(connections)
    .set({ status: "paused" })
    .where(and(eq(connections.id, connectionId), eq(connections.status, "connected")))
    .returning();
  if (!row) throw new ConnectorError("connection is not connected", 409);
  return toPublicConnection(row);
}

/** Resume a paused or failed connection; the failure count starts over. */
export async function resumeConnection(connectionId: string): Promise<PublicConnection> {
  const [row] = await db
    .update(connections)
    .set({ status: "connected", failure_count: 0, last_error: null })
    .where(
      and(eq(connections.id, connectionId), sql`${connections.status} in ('paused', 'failed')`),
    )
    .returning();
  if (!row) throw new ConnectorError("connection is not paused or failed", 409);
  return toPublicConnection(row);
}

/** The account's MEASURE connections (P3-20b): execute rows are listed by lib/execution/connections. */
export async function listConnections(accountId: string): Promise<PublicConnection[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.account_id, accountId), eq(connections.purpose, "measure")))
    .orderBy(connections.created_at);
  return rows.map(toPublicConnection);
}

/* ---------- P2-02: observations ---------- */

/** The jsonb half of the natural key, serialised with sorted keys and no empties. */
export function canonicalDimensions(dimensions: ObservationDimensions): string {
  const entries = Object.entries(dimensions)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}

export class ObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationError";
  }
}

type ObservationRow = typeof metricObservations.$inferInsert;

/**
 * Validate one observation and shape it for storage. Money metrics must
 * carry integer minor units and a currency (rule 1); count metrics must
 * not. A provider module that gets this wrong fails here, before a row
 * exists, rather than producing a fact that lies about its own type.
 */
export function toObservationRow(
  connectionId: string,
  provider: string,
  o: Observation,
): ObservationRow {
  if (!isMetricKey(o.metric_key)) {
    throw new ObservationError(`unknown metric "${String(o.metric_key)}"`);
  }
  const period_date = isoDate(o.period_date);
  const observed_at = isoDateTime(o.observed_at);
  const dimensions: Record<string, string> = JSON.parse(canonicalDimensions(o.dimensions));
  const isMoney = MONEY_METRICS.has(o.metric_key);

  if (isMoney) {
    if (o.value_num !== undefined) {
      throw new ObservationError(`${o.metric_key} is a money metric — value_num is not allowed`);
    }
    const currency = dimensions["currency"];
    if (o.value_minor === undefined || currency === undefined) {
      throw new ObservationError(
        `${o.metric_key} needs value_minor and dimensions.currency (rule 1: money is minor units + currency)`,
      );
    }
    const m = money(o.value_minor, currency);
    return {
      connection_id: connectionId,
      provider,
      metric_key: o.metric_key,
      dimensions,
      dimension_key: canonicalDimensions(o.dimensions),
      period_date,
      value_minor: m.amount_minor,
      currency: m.currency,
      value_num: null,
      observed_at,
    };
  }

  if (o.value_minor !== undefined || dimensions["currency"] !== undefined) {
    throw new ObservationError(`${o.metric_key} is a count metric — no value_minor or currency`);
  }
  if (o.value_num === undefined || !Number.isFinite(o.value_num)) {
    throw new ObservationError(`${o.metric_key} needs a finite value_num`);
  }
  return {
    connection_id: connectionId,
    provider,
    metric_key: o.metric_key,
    dimensions,
    dimension_key: canonicalDimensions(o.dimensions),
    period_date,
    value_minor: null,
    currency: null,
    value_num: o.value_num.toFixed(4),
    observed_at,
  };
}

/** Anything that can run an insert: the db, or a transaction handle from db.transaction. */
export type Executor = Pick<typeof db, "insert" | "select" | "update">;

const UPSERT_CHUNK = 500;

/**
 * Upsert observations by their natural key. Re-ingesting a day replaces
 * that day's values in place — the provider's latest word wins — and
 * never creates a second row for it, so a re-run backfill cannot
 * double-count. Returns the number of observations processed.
 */
export async function upsertObservations(
  connectionId: string,
  provider: string,
  observations: readonly Observation[],
  executor: Executor = db,
): Promise<number> {
  if (observations.length === 0) return 0;
  const rows = observations.map((o) => toObservationRow(connectionId, provider, o));
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await executor
      .insert(metricObservations)
      .values(rows.slice(i, i + UPSERT_CHUNK))
      .onConflictDoUpdate({
        target: [
          metricObservations.connection_id,
          metricObservations.metric_key,
          metricObservations.dimension_key,
          metricObservations.period_date,
        ],
        set: {
          dimensions: sql`excluded.dimensions`,
          value_minor: sql`excluded.value_minor`,
          currency: sql`excluded.currency`,
          value_num: sql`excluded.value_num`,
          observed_at: sql`excluded.observed_at`,
        },
      });
  }
  return rows.length;
}
