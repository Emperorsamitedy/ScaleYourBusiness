// Monthly re-diagnosis — the v1 build spec §6.4 (P7-53).
//
// "Re-diagnose monthly. Each re-run is a diff against the previous report."
// generateReport already writes the diff (lib/diagnosis/diff.ts), the next
// version number and the leak register; this job only decides WHEN: a
// business whose latest report is REDIAGNOSE_AFTER_DAYS old or older is
// re-run, on the weekly beat (app/api/cron/weekly-watch) — no cron of its
// own. Cost discipline: generateReport returns the existing report, with no
// model call, when the profile hasn't changed since it, and its quota guard
// stops a business at its plan's hard cap. A run touches at most
// MAX_PER_RUN businesses; the rest wait for next week's beat.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, diagnosisReports } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import { isAppLocale } from "../i18n/locales";
import type { AppLocale } from "../i18n/locales";

export const REDIAGNOSE_AFTER_DAYS = 30;
/** A hard cap on re-diagnoses per run (cost rule: every loop has one). */
export const MAX_PER_RUN = 25;

const DAY = 86_400_000;

/** Pure: is a report generated at `generatedAt` due to be re-run at `now`? */
export function dueForRediagnosis(generatedAt: string, now: Date): boolean {
  return now.getTime() - Date.parse(generatedAt) >= REDIAGNOSE_AFTER_DAYS * DAY;
}

type Generate = (args: {
  accountId: string;
  profileId: string;
  locale?: AppLocale;
}) => Promise<{ fresh: boolean }>;

export interface RediagnosisRun {
  checked: number;
  /** A new version was written (the profile had changed). */
  regenerated: number;
  /** Due, but nothing had changed: the report stands, at no cost. */
  unchanged: number;
  failed: number;
  /** Due businesses left for next week by MAX_PER_RUN. */
  deferred: number;
}

export async function runMonthlyRediagnosis(
  now = new Date(),
  generate?: Generate,
): Promise<RediagnosisRun> {
  const run: RediagnosisRun = { checked: 0, regenerated: 0, unchanged: 0, failed: 0, deferred: 0 };
  const rows = await db
    .select({
      profile_id: diagnosisReports.profile_id,
      generated_at: diagnosisReports.generated_at,
      language: diagnosisReports.language,
      account_id: businessProfiles.account_id,
    })
    .from(diagnosisReports)
    .innerJoin(businessProfiles, eq(businessProfiles.id, diagnosisReports.profile_id))
    .orderBy(desc(diagnosisReports.generated_at));
  // The latest report per business (rows are newest first).
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.profile_id)) latest.set(r.profile_id, r);
  const due = [...latest.values()].filter((r) => dueForRediagnosis(r.generated_at, now));
  run.checked = latest.size;
  run.deferred = Math.max(0, due.length - MAX_PER_RUN);

  const gen: Generate =
    generate ?? (async (a) => (await import("../report/service")).generateReport(a));
  for (const r of due.slice(0, MAX_PER_RUN)) {
    try {
      const { fresh } = await gen({
        accountId: r.account_id,
        profileId: r.profile_id,
        locale: isAppLocale(r.language) ? r.language : "en",
      });
      if (fresh) run.regenerated++;
      else run.unchanged++;
    } catch (error) {
      run.failed++;
      console.error(
        JSON.stringify({
          event: "rediagnosis_failed",
          account_id: r.account_id,
          ...logSafeError(error),
        }),
      );
    }
  }
  return run;
}
