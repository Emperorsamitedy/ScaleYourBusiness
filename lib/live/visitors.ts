// Home's live line: people on the business's own site right now, minute by
// minute over the last 30 (specs/ux-spec-v1.md §2.1, "The live line").
//
// Read from the business's Google Analytics connection with its read-only
// token (lib/connectors/providers/ga4 createGa4Live) and never stored: the
// figure goes to the screen only. Each business's answer is kept for
// LIVE_CACHE_MS, so screens polling every half minute cost at most about
// two Google calls a minute per business and per server instance.

import { decryptSecret } from "../connectors/secrets";
import type { ActiveMinute } from "../connectors/providers/ga4";
import { ga4Live } from "../connectors/providers/ga4";
import { logSafeError } from "../core/log-safe";

export const LIVE_CACHE_MS = 30_000;

export type LiveVisitors =
  | { status: "live"; read_at: string; minutes: ActiveMinute[] }
  /** No Google Analytics connection: the line says what would start it. */
  | { status: "not_connected" }
  /** Connected but paused by the owner, or failing: nothing is read. */
  | { status: "paused" }
  /** Google did not answer this time; the screen keeps its last reading and says how old it is. */
  | { status: "unavailable" };

export interface LiveDeps {
  connection: (
    accountId: string,
  ) => Promise<{ status: string; encrypted_secret: string | null } | null>;
  read: (secret: string) => Promise<ActiveMinute[]>;
  decrypt: (blob: string) => string;
  now: () => number;
}

const defaults: LiveDeps = {
  // Loaded on first use, so the rules below are testable without a database.
  connection: async (accountId) =>
    (await import("../connectors/service")).activeConnection(accountId, "ga4"),
  read: (secret) => ga4Live.activeNow(secret),
  decrypt: (blob) => decryptSecret(blob),
  now: () => Date.now(),
};

const cache = new Map<string, { at: number; value: LiveVisitors }>();

/** Forget every cached answer — for tests. */
export function clearLiveCache(): void {
  cache.clear();
}

/** The live line's reading for one business (its account), cached for LIVE_CACHE_MS. */
export async function liveVisitors(
  accountId: string,
  deps: LiveDeps = defaults,
): Promise<LiveVisitors> {
  const hit = cache.get(accountId);
  if (hit && deps.now() - hit.at < LIVE_CACHE_MS) return hit.value;

  const value = await readNow(accountId, deps);
  cache.set(accountId, { at: deps.now(), value });
  return value;
}

async function readNow(accountId: string, deps: LiveDeps): Promise<LiveVisitors> {
  const row = await deps.connection(accountId);
  if (!row) return { status: "not_connected" };
  if (row.status !== "connected" || !row.encrypted_secret) return { status: "paused" };
  try {
    const minutes = await deps.read(deps.decrypt(row.encrypted_secret));
    return { status: "live", read_at: new Date(deps.now()).toISOString(), minutes };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "live_visitors_failed",
        account_id: accountId,
        ...logSafeError(error),
      }),
    );
    return { status: "unavailable" };
  }
}
