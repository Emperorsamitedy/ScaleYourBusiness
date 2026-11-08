// Which connections' observations count as measurements — TikTok Ads, 2026-11-08.
//
// Measurement normally comes from `measure` connections (rule 9: read-only
// scopes, the measurement registry). One kind of execute connection also
// measures: a platform whose reporting permission can't be separated from
// its write permission, held as one consent the I-45a way and read through
// a fence that can only GET (TikTok Ads: lib/tiktok/read.ts). Its rows live
// in metric_observations on the execute connection, and the screens that
// show measured figures read them beside the measure rows.
//
// This list is the only place that says so. Adding a provider to it is a
// deliberate edit: measured-sources.test.ts pins it, and asserts each one
// is an execution provider whose read side is fenced.

import { and, eq, inArray, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { connections } from "../../db/schema";

/** Execute-purpose providers whose fenced reads are measurements. */
export const MEASURED_EXECUTE_PROVIDERS = ["tiktok_ads"] as const;

export type MeasuredExecuteProvider = (typeof MEASURED_EXECUTE_PROVIDERS)[number];

export function isMeasuredExecuteProvider(provider: string): provider is MeasuredExecuteProvider {
  return (MEASURED_EXECUTE_PROVIDERS as readonly string[]).includes(provider);
}

/** The where-clause: a measure row, or an execute row of a measuring provider. */
export function measuredConnection(opts: { andImports?: boolean } = {}): SQL {
  return or(
    eq(connections.purpose, "measure"),
    ...(opts.andImports ? [eq(connections.purpose, "import")] : []),
    and(
      eq(connections.purpose, "execute"),
      inArray(connections.provider, [...MEASURED_EXECUTE_PROVIDERS]),
    ),
  ) as SQL;
}

/** Owner-facing names for the measuring execute providers (not in the read provider registry). */
export const MEASURED_EXECUTE_LABELS: Readonly<Record<MeasuredExecuteProvider, string>> = {
  tiktok_ads: "TikTok Ads",
};
