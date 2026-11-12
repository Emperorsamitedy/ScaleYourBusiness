// The first interview's rules, applied where questions are chosen (the v1
// build spec §6.5; ./budget.ts holds the pure parts).
//
// Both the interviewer (pickNextQuestion) and the intake screen
// (getIntakeState) narrow their candidates through applyFirstInterview, so
// the question asked and the "questions left" shown agree:
//   · a question a live connection measures is never asked
//   · until the business's first report exists, only questions that still
//     fit the 8-minute budget are offered; when none fits, the first
//     interview is over and the report follows
// After the first report there is no cap: the profile fills progressively.

import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../db";
import { connections, diagnosisReports, fieldRecords } from "../../db/schema";
import { BALANCE_IMPORT_PROVIDER } from "../balance/source";
import { CONNECTOR_READS } from "../connectors/contract";
import { isProviderId } from "../connectors/scopes";
import type { ApplicableQuestion } from "../resolver/applicability";
import type { Budget } from "./budget";
import { FIRST_INTERVIEW_SECONDS, spentSeconds, withinBudget } from "./budget";

/** The connector metrics an account's live connections measure. */
export async function measuredMetricsFor(accountId: string): Promise<Set<string>> {
  const rows = await db
    .select({ provider: connections.provider })
    .from(connections)
    .where(
      and(
        eq(connections.account_id, accountId),
        eq(connections.status, "connected"),
        ne(connections.purpose, "execute"),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    if (isProviderId(r.provider)) for (const m of CONNECTOR_READS[r.provider]) out.add(m);
    if (r.provider === BALANCE_IMPORT_PROVIDER) out.add("cash.balance");
    if (r.provider === "nav_online_szamla") {
      out.add("revenue.daily");
      out.add("purchases.daily");
    }
  }
  return out;
}

/** The facts the owner answered themselves (typed or said) — what the first interview spent time on. */
async function ownerAnswered(profileId: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: fieldRecords.field_key, source: fieldRecords.source })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  return new Set(
    rows
      .filter((r) => {
        const kind = (r.source as { kind?: unknown } | null)?.kind;
        return kind === "owner_input" || kind === "conversation";
      })
      .map((r) => r.key),
  );
}

/** The first interview's budget, or null once the business has its first report. */
export async function firstInterviewBudget(
  profileId: string,
  applicable: readonly ApplicableQuestion[],
): Promise<Budget | null> {
  const [report] = await db
    .select({ id: diagnosisReports.id })
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, profileId))
    .limit(1);
  if (report) return null;
  return {
    spent_seconds: spentSeconds(applicable, await ownerAnswered(profileId)),
    limit_seconds: FIRST_INTERVIEW_SECONDS,
  };
}

export async function applyFirstInterview(args: {
  profileId: string;
  accountId: string;
  applicable: readonly ApplicableQuestion[];
  candidates: readonly ApplicableQuestion[];
}): Promise<ApplicableQuestion[]> {
  const [budget, measured] = await Promise.all([
    firstInterviewBudget(args.profileId, args.applicable),
    measuredMetricsFor(args.accountId),
  ]);
  return withinBudget(args.candidates, budget, measured);
}
