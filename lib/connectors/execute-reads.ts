// Reads made with an EXECUTE connection — P2-20.
//
// Rule 9 keeps every measurement connection read-only: a write-capable
// scope never enters SCOPE_REGISTRY, and connect() refuses one. Google Ads
// has no read-only scope at all, so its credential is a write consent
// (purpose "execute", lib/execution/scopes.ts google_ads). What SYB does
// with it every day is still measurement, and this registry is the one,
// narrow door through which the sync runner may pull from such a
// connection: an execute row is pulled from ONLY when its provider is
// listed here, and what is listed can only pull pages of observations —
// the type has no other method. Everything else about the sync is
// unchanged: the page and its cursor land together, then the derivation,
// the watch log and the anomaly check.
//
// The read itself is fenced in its own module (lib/google-ads/client.ts:
// search endpoints only), and the write side lives in the execution
// provider, reached only through the engine after an approval.

import type { PullContext, PullPage } from "./provider";
import { googleAdsReadSource } from "../google-ads/read";
import { tiktokAdsReadSource } from "../tiktok/read";

export interface ExecuteReadSource {
  id: string;
  /** Owner-facing name, e.g. "Google Ads". */
  label: string;
  pull(secret: string, cursor: string | null, now: Date, context?: PullContext): Promise<PullPage>;
}

const SOURCES: Readonly<Record<string, ExecuteReadSource>> = {
  google_ads: googleAdsReadSource,
  // TikTok Ads (2026-11-08): reporting can't be separated from campaign writes
  // for one TikTok app, so its read rides on the tiktok_ads consent. GET-only
  // through lib/tiktok/api's fence (read.test.ts scans the source).
  tiktok_ads: tiktokAdsReadSource,
};

/** Every execute provider the sync runner reads from. Pinned in execute-reads.test.ts. */
export const EXECUTE_READ_PROVIDERS: readonly string[] = Object.keys(SOURCES);

const overrides = new Map<string, ExecuteReadSource>();

/** The read source for an execute connection's provider, or null: such rows are never pulled. */
export function executeReadSource(provider: string): ExecuteReadSource | null {
  if (!Object.prototype.hasOwnProperty.call(SOURCES, provider)) return null;
  return overrides.get(provider) ?? SOURCES[provider] ?? null;
}

/** Test seam, like overrideProviderForTests. Returns the restore function. */
export function overrideExecuteReadSourceForTests(
  provider: string,
  source: ExecuteReadSource,
): () => void {
  if (!Object.prototype.hasOwnProperty.call(SOURCES, provider) || source.id !== provider) {
    throw new Error(`"${provider}" is not an execute read source`);
  }
  overrides.set(provider, source);
  return () => {
    overrides.delete(provider);
  };
}
