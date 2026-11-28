// The five facts lib/journey/stage.ts needs, read for one business. Every
// query is scoped to the profile or its account (the one door has already
// been asked by the caller).

import { and, count, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  diagnosisReports,
  fieldRecords,
  intakeEvents,
  modeDecisions,
} from "../../db/schema";
import { type Journey, type JourneyFacts, journeyOf } from "./stage";

export async function journeyFacts(accountId: string, profileId: string): Promise<JourneyFacts> {
  const [currency, factRows, core, report, connRows, mode] = await Promise.all([
    db
      .select({ chosen_at: accounts.reporting_currency_chosen_at })
      .from(businessProfiles)
      .innerJoin(accounts, eq(accounts.id, businessProfiles.account_id))
      .where(eq(businessProfiles.id, profileId))
      .limit(1),
    db
      .select({ n: count() })
      .from(fieldRecords)
      .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at))),
    db
      .select({ id: intakeEvents.id })
      .from(intakeEvents)
      .where(
        and(eq(intakeEvents.profile_id, profileId), eq(intakeEvents.kind, "funnel_core_completed")),
      )
      .limit(1),
    db
      .select({ id: diagnosisReports.id })
      .from(diagnosisReports)
      .where(eq(diagnosisReports.profile_id, profileId))
      .limit(1),
    db
      .select({ n: count() })
      .from(connections)
      .where(and(eq(connections.account_id, accountId), eq(connections.status, "connected"))),
    db
      .select({ id: modeDecisions.id })
      .from(modeDecisions)
      .where(eq(modeDecisions.profile_id, profileId))
      .limit(1),
  ]);
  return {
    currency_chosen: (currency[0]?.chosen_at ?? null) !== null,
    facts: Number(factRows[0]?.n ?? 0),
    core_done: core.length > 0,
    has_report: report.length > 0,
    connections: Number(connRows[0]?.n ?? 0),
    mode_decided: mode.length > 0,
  };
}

export async function journeyFor(accountId: string, profileId: string): Promise<Journey> {
  return journeyOf(await journeyFacts(accountId, profileId));
}
