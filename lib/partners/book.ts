// The book view and the firm-level proof ledger — the v1 build spec §7.2,
// §7.4 (P7-81).
//
// "A table of every client, sorted by size of leak found, descending."
// Columns: client, sector, diagnosis grade, open leaks (count and money),
// largest single leak, verified money this quarter, actions awaiting
// approval, connector health, last activity.
//
// Only clients the database's partner_may lets this person read
// (read_diagnosis) are in it. A fixed number of batched queries whatever
// the book's size, so 200 clients load well inside §7.7's two seconds.
// Money stays per currency; ordering across currencies uses the stored ECB
// rate for the sort alone — no converted figure is ever shown (D44).
// A leak's money is shown only at Diagnosis Grade A or B (§6.2).

import { and, desc, eq, gte, inArray, isNull, lt, max, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  businessProfiles,
  connections,
  decisionLog,
  diagnosisReports,
  fieldRecords,
  firmMetricRollups,
  leaks,
  ledgerEntries,
  measurementPlans,
  proposals,
} from "../../db/schema";
import { enumCode } from "../core/enum-value";
import { toEur } from "../core/fx";
import type { Money } from "../core/money";
import { quarterBounds, quarterOf } from "../billing/guarantee-run";
import { headlineMoneyAllowed } from "../diagnosis/diagnosis-grade";
import type { Grade } from "../core/grade";
import { rateOn } from "../fx/ecb";
import { counterOf } from "../ledger/counter";
import { partnerClients } from "./access";

export type Health = "healthy" | "attention" | "failed" | "none";

export interface BookRow {
  profile_id: string;
  name: string | null;
  sector: string | null;
  grade: Grade | null;
  leaks_open: number;
  /** Per currency; empty below grade B (§6.2). */
  leaks_money: { low: Money; high: Money }[];
  largest_leak: { title: string; high: Money | null } | null;
  verified_quarter: Money[];
  awaiting_approval: number;
  health: Health;
  last_activity: string | null;
}

const asGrade = (g: unknown): Grade | null =>
  g === "A" || g === "B" || g === "C" || g === "D" ? g : null;

export async function bookView(userId: string, now = new Date()): Promise<BookRow[]> {
  const ids = await partnerClients(userId, "read_diagnosis");
  if (ids.length === 0) return [];
  const quarter = quarterBounds(quarterOf(now));

  const [profiles, facts, reports, leakRows, ledger, pending, activity] = await Promise.all([
    db
      .select({ id: businessProfiles.id, account_id: businessProfiles.account_id })
      .from(businessProfiles)
      .where(inArray(businessProfiles.id, ids)),
    db
      .select({
        profile_id: fieldRecords.profile_id,
        key: fieldRecords.field_key,
        value: fieldRecords.value,
      })
      .from(fieldRecords)
      .where(
        and(
          inArray(fieldRecords.profile_id, ids),
          inArray(fieldRecords.field_key, ["identity.business_name", "identity.business_type"]),
          isNull(fieldRecords.superseded_at),
        ),
      ),
    db
      .selectDistinctOn([diagnosisReports.profile_id], {
        profile_id: diagnosisReports.profile_id,
        grade: diagnosisReports.diagnosis_grade,
      })
      .from(diagnosisReports)
      .where(inArray(diagnosisReports.profile_id, ids))
      .orderBy(diagnosisReports.profile_id, desc(diagnosisReports.generated_at)),
    db
      .select()
      .from(leaks)
      .where(and(inArray(leaks.profile_id, ids), inArray(leaks.status, ["open", "in_progress"]))),
    db
      .select({ entry: ledgerEntries, plan: measurementPlans })
      .from(ledgerEntries)
      .innerJoin(measurementPlans, eq(measurementPlans.id, ledgerEntries.plan_id))
      .where(
        and(
          inArray(ledgerEntries.profile_id, ids),
          gte(ledgerEntries.created_at, quarter.start),
          lt(ledgerEntries.created_at, quarter.end),
        ),
      ),
    db
      .select({ profile_id: proposals.profile_id, n: sql<number>`count(*)::int` })
      .from(proposals)
      .where(and(inArray(proposals.profile_id, ids), eq(proposals.status, "pending")))
      .groupBy(proposals.profile_id),
    db
      .select({ profile_id: decisionLog.profile_id, at: max(decisionLog.at) })
      .from(decisionLog)
      .where(inArray(decisionLog.profile_id, ids))
      .groupBy(decisionLog.profile_id),
  ]);

  const accountOf = new Map(profiles.map((p) => [p.id, p.account_id]));
  const conns = await db
    .select({ account_id: connections.account_id, status: connections.status })
    .from(connections)
    .where(inArray(connections.account_id, [...new Set(profiles.map((p) => p.account_id))]));
  const healthOf = new Map<string, Health>();
  const rank: Record<Health, number> = { none: 0, healthy: 1, attention: 2, failed: 3 };
  for (const c of conns) {
    const h: Health =
      c.status === "connected"
        ? "healthy"
        : c.status === "disconnected"
          ? "none"
          : c.status === "failed"
            ? "failed"
            : "attention";
    const held = healthOf.get(c.account_id) ?? "none";
    if (rank[h] > rank[held]) healthOf.set(c.account_id, h);
  }

  // The sort key: open leaks' upper ends, in euro cents via the stored rate — ordering only.
  const rates = new Map<string, Awaited<ReturnType<typeof rateOn>>>();
  const today = now.toISOString().slice(0, 10);
  async function sortEur(m: Money): Promise<number> {
    if (m.currency === "EUR") return m.amount_minor;
    if (!rates.has(m.currency)) rates.set(m.currency, await rateOn(m.currency, today));
    const r = rates.get(m.currency);
    return r ? toEur(m, r).amount_minor : 0;
  }

  const rows: (BookRow & { sort: number })[] = [];
  for (const id of ids) {
    const f = facts.filter((x) => x.profile_id === id);
    const name = f.find((x) => x.key === "identity.business_name")?.value;
    const grade = asGrade(reports.find((r) => r.profile_id === id)?.grade);
    const mine = leakRows.filter((l) => l.profile_id === id);
    const totals = new Map<string, { low: number; high: number }>();
    for (const l of mine) {
      if (!l.currency || l.low_minor === null || l.high_minor === null) continue;
      const t = totals.get(l.currency) ?? { low: 0, high: 0 };
      t.low += l.low_minor;
      t.high += l.high_minor;
      totals.set(l.currency, t);
    }
    const largest = [...mine].sort((a, b) => (b.high_minor ?? 0) - (a.high_minor ?? 0))[0];
    let sort = 0;
    for (const [currency, t] of totals) sort += await sortEur({ amount_minor: t.high, currency });
    const showMoney = grade !== null && headlineMoneyAllowed(grade);
    rows.push({
      profile_id: id,
      name: typeof name === "string" ? name : null,
      sector: enumCode(f.find((x) => x.key === "identity.business_type")?.value),
      grade,
      leaks_open: mine.length,
      leaks_money: showMoney
        ? [...totals].map(([currency, t]) => ({
            low: { amount_minor: t.low, currency },
            high: { amount_minor: t.high, currency },
          }))
        : [],
      largest_leak: largest
        ? {
            title: largest.title,
            high:
              showMoney && largest.currency && largest.high_minor !== null
                ? { amount_minor: largest.high_minor, currency: largest.currency }
                : null,
          }
        : null,
      verified_quarter: counterOf(ledger.filter((r) => r.entry.profile_id === id)).verified,
      awaiting_approval: pending.find((p) => p.profile_id === id)?.n ?? 0,
      health: healthOf.get(accountOf.get(id) ?? "") ?? "none",
      last_activity: activity.find((a) => a.profile_id === id)?.at ?? null,
      sort,
    });
  }
  rows.sort((a, b) => b.sort - a.sort || b.leaks_open - a.leaks_open);
  return rows.map(({ sort, ...r }) => {
    void sort; // the ordering key stays here: it is never shown
    return r;
  });
}

/**
 * §7.4: "Your practice produced €184,000 of verified client gains this
 * quarter across 31 clients." Per currency, never converted; stored.
 */
export async function firmRollup(firmId: string, userId: string, now = new Date()) {
  const period = quarterOf(now);
  const book = await bookView(userId, now);
  const byCurrency = new Map<string, number>();
  for (const r of book)
    for (const m of r.verified_quarter)
      byCurrency.set(m.currency, (byCurrency.get(m.currency) ?? 0) + m.amount_minor);
  const ids = book.map((r) => r.profile_id);
  const fixed = ids.length
    ? ((
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(leaks)
          .where(and(inArray(leaks.profile_id, ids), eq(leaks.status, "fixed_and_verified")))
      )[0]?.n ?? 0)
    : 0;
  const open = book.reduce((n, r) => n + r.leaks_open, 0);
  const currencies = byCurrency.size > 0 ? [...byCurrency] : ([["EUR", 0]] as [string, number][]);
  for (const [currency, verified] of currencies) {
    await db
      .insert(firmMetricRollups)
      .values({
        firm_id: firmId,
        period,
        currency,
        verified_minor: verified,
        leaks_open: open,
        leaks_fixed: fixed,
        clients_active: book.length,
      })
      .onConflictDoUpdate({
        target: [firmMetricRollups.firm_id, firmMetricRollups.period, firmMetricRollups.currency],
        set: {
          verified_minor: verified,
          leaks_open: open,
          leaks_fixed: fixed,
          clients_active: book.length,
          computed_at: now.toISOString(),
        },
      });
  }
  return {
    period,
    verified: currencies.map(([currency, amount_minor]) => ({ amount_minor, currency })),
    leaks_open: open,
    leaks_fixed: fixed,
    clients_active: book.length,
  };
}
