// The database half of launch readiness (lib/ops/readiness.ts): what ran,
// what is seeded, and what binds a later choice. Read-only, three small
// queries, each allowed to fail on its own — a database that can't answer
// one question still answers the others, and the item says CHECK.
//
// "Bundled with the app" means imported: the migration journal and the
// bank's version travel inside the build, so the comparison is between the
// code that is running and the database it runs on. drizzle-kit applies a
// migration when its journal `when` is newer than the newest applied row's
// created_at, so that is the comparison made here too.

import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { countryComplianceMatrix, priceBook, usageQuotas } from "../../db/schema";
import { navGuideMissing } from "../connectors/nav/guide";
import journal from "../../db/migrations/meta/_journal.json";
import bank from "../../specs/question-bank-v1.json";
import type { ReadinessFacts } from "./readiness";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** The journal this build carries. */
export function bundledMigrations(
  entries: readonly JournalEntry[] = (journal as { entries: JournalEntry[] }).entries,
): ReadinessFacts["bundled_migrations"] {
  const last = entries[entries.length - 1];
  if (!last) throw new Error("the migration journal is empty");
  return { count: entries.length, latest_tag: last.tag, latest_when: last.when };
}

export const BUNDLED_BANK_VERSION: string = (bank as { bank_version: string }).bank_version;

function tagFor(when: number | null): string | null {
  if (when === null) return null;
  const entry = (journal as { entries: JournalEntry[] }).entries.find((e) => e.when === when);
  return entry?.tag ?? null;
}

async function appliedMigrations(): Promise<ReadinessFacts["migrations"]> {
  try {
    const result = await db.execute<{ applied: string | number; latest: string | number | null }>(
      sql`select count(*) as applied, max(created_at) as latest from drizzle.__drizzle_migrations`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const latest = row.latest === null ? null : Number(row.latest);
    return {
      applied: Number(row.applied),
      latest_applied_at: latest,
      latest_applied_tag: tagFor(latest),
    };
  } catch (error) {
    // 42P01: the table doesn't exist — nothing has ever been migrated.
    if ((error as { cause?: { code?: string } }).cause?.code === "42P01") {
      return { applied: 0, latest_applied_at: null, latest_applied_tag: null };
    }
    return null;
  }
}

async function seededBank(): Promise<ReadinessFacts["bank"]> {
  try {
    const result = await db.execute<{ version: string }>(
      sql`select version from bank_versions where is_current limit 1`,
    );
    return { seeded: result.rows[0]?.version ?? null };
  } catch {
    return null;
  }
}

/**
 * Everything launchReadiness needs from the database. The law review and
 * the first-campaign queue are passed in: /ops has already read them for
 * its own sections.
 */
export async function readReadinessFacts(known: {
  law_review: ReadinessFacts["law_review"];
  first_campaigns_waiting: number | null;
}): Promise<ReadinessFacts> {
  const [migrations, bankRow, hungary] = await Promise.all([
    appliedMigrations(),
    seededBank(),
    hungaryFacts().catch(() => null),
  ]);
  return {
    migrations,
    bundled_migrations: bundledMigrations(),
    bank: bankRow,
    bundled_bank_version: BUNDLED_BANK_VERSION,
    law_review: known.law_review,
    first_campaigns_waiting: known.first_campaigns_waiting,
    hungary,
  };
}

/** The multi-market spec's Hungary gates, read from the database and the guide's folder. */
async function hungaryFacts(): Promise<NonNullable<ReadinessFacts["hungary"]>> {
  const [quotas, prices, matrix] = await Promise.all([
    db.select({ confirmed: usageQuotas.confirmed }).from(usageQuotas),
    db.select({ enabled: priceBook.enabled }).from(priceBook).where(eq(priceBook.country, "HU")),
    db.select().from(countryComplianceMatrix).where(eq(countryComplianceMatrix.country, "HU")),
  ]);
  const row = matrix[0];
  return {
    nav_guide_missing: navGuideMissing(),
    quotas_confirmed: quotas.length > 0 && quotas.every((q) => q.confirmed),
    prices_enabled: prices.length > 0 && prices.every((p) => p.enabled),
    matrix: {
      exists: row !== undefined,
      signed_off: row?.legal_signoff_date != null,
      phone_unblocked: row !== undefined && !row.blocked && !row.execution_halted,
    },
  };
}
