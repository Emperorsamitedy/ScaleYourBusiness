// What the platform said about its rate limits during ONE attempt — P3-24d
// (Session D, layer D5).
//
// The engine journals every attempt (execution_attempts, P3-13); this is how
// the rate-limit usage Meta reports in its response headers reaches that
// row without the provider importing the database or the engine threading a
// collector through every call. The engine opens a collector around
// provider.execute; the Meta request helper (providers/meta.ts, metaCall)
// adds every response's usage headers to whichever collector is open. No
// collector open (a pre-flight read, an undo, a test calling the provider
// directly) and nothing is recorded — the structured meta_usage log line
// still is.
//
// Only the headers' parsed JSON, the request's registered name and the
// percentages are kept. Never a URL, a token or a body.

import { AsyncLocalStorage } from "node:async_hooks";

/** One request's usage, as Meta reported it. */
export interface RequestUsage {
  /** The registered request name (META_EXEC_REQUESTS), never a URL. */
  request: string;
  /** The highest percentage across this response's usage headers, or null. */
  usage_pct: number | null;
  /** P3-22d: the Marketing API access tier, when the response carried one. */
  access_tier: string | null;
  /** Each usage header Meta sent, lower-cased, as parsed JSON. Absent ones are left out. */
  headers: Record<string, unknown>;
}

/** What lands on execution_attempts.usage. */
export interface AttemptUsage {
  /** The highest percentage on any request in the attempt, or null when none reported one. */
  max_pct: number | null;
  access_tier: string | null;
  requests: RequestUsage[];
  /** True when more requests were made than are kept here. */
  truncated?: boolean;
}

/** A hard cap on the requests kept per attempt row (an Instagram poll loop can make a dozen). */
export const MAX_REQUESTS_PER_ATTEMPT = 25;

const store = new AsyncLocalStorage<AttemptUsage>();

export function emptyUsage(): AttemptUsage {
  return { max_pct: null, access_tier: null, requests: [] };
}

/** Run `fn` with `usage` open as the collector; whatever it sends is noted there. */
export function withUsage<T>(usage: AttemptUsage, fn: () => Promise<T>): Promise<T> {
  return store.run(usage, fn);
}

/** Called by the request helper for every response; a no-op when no attempt is open. */
export function noteRequestUsage(entry: RequestUsage): void {
  const usage = store.getStore();
  if (!usage) return;
  if (entry.usage_pct !== null) {
    usage.max_pct = Math.max(usage.max_pct ?? 0, entry.usage_pct);
  }
  if (entry.access_tier !== null) usage.access_tier = entry.access_tier;
  if (usage.requests.length >= MAX_REQUESTS_PER_ATTEMPT) {
    usage.truncated = true;
    return;
  }
  usage.requests.push(entry);
}
