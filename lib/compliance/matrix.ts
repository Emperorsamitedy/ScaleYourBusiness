// The country compliance matrix — the v1 build spec §9.2 and §9.5 (P7-32).
//
// Configuration, not code: one row per country, read at every check and
// changed here without a deploy. Every change names who made it, and the
// table's trigger (migration 0101) copies it, before and after, into the
// append-only country_compliance_changes — so the log can't be skipped even
// by a hand-written UPDATE. A country without a row is blocked for every
// regulated capability: strictest first (§9.2).
//
// This module imports only the database and its schema: the phone line
// reads it too, inside its import fence (lib/support/structure.test.ts).

import { desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { countryComplianceChanges, countryComplianceMatrix } from "../../db/schema";

export type CountryRule = typeof countryComplianceMatrix.$inferSelect;
export type CountryChange = typeof countryComplianceChanges.$inferSelect;

export class MatrixError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixError";
  }
}

const ISO = /^[A-Z]{2}$/;

function iso(country: string): string {
  const c = country.trim().toUpperCase();
  if (!ISO.test(c)) throw new MatrixError(`"${country}" isn't a two-letter country code`);
  return c;
}

/** The country's row, or null — which every reader treats as blocked. */
export async function countryRule(country: string | null): Promise<CountryRule | null> {
  if (country === null || !ISO.test(country.toUpperCase())) return null;
  const [row] = await db
    .select()
    .from(countryComplianceMatrix)
    .where(eq(countryComplianceMatrix.country, country.toUpperCase()));
  return row ?? null;
}

/** Inbound phone answering, and the recording and transcription beside it (§9.2). */
export function inboundPhoneAllowed(rule: CountryRule | null): boolean {
  return rule !== null && !rule.blocked && !rule.execution_halted;
}

/** Outbound AI calling: its own flag, and never before inbound (§9.2). */
export function outboundPhoneAllowed(rule: CountryRule | null): boolean {
  return inboundPhoneAllowed(rule) && rule !== null && !rule.outbound_blocked;
}

export interface CountryRuleChange {
  recording_regime?: "all_party" | "single_party";
  criminal_penalty?: boolean;
  outbound_consent_required?: boolean;
  legal_signoff_date?: string | null;
  legal_signoff_reference?: string | null;
  blocked?: boolean;
  outbound_blocked?: boolean;
  execution_halted?: boolean;
  note?: string | null;
}

/**
 * Change one country's row (creating it, strictest-first, when missing).
 * `actor` names who — an operator's name, never blank — and `reason` why;
 * both land in the audit log by the trigger. Unblocking without counsel's
 * dated sign-off is refused, here in words and by the table's check.
 */
export async function setCountryRule(args: {
  country: string;
  change: CountryRuleChange;
  actor: string;
  reason: string;
}): Promise<CountryRule> {
  const country = iso(args.country);
  const actor = args.actor.trim();
  if (actor === "") throw new MatrixError("say who is making this change");
  if (args.reason.trim() === "") throw new MatrixError("say why this change is being made");

  const current = await countryRule(country);
  const next = {
    blocked: args.change.blocked ?? current?.blocked ?? true,
    outbound_blocked: args.change.outbound_blocked ?? current?.outbound_blocked ?? true,
    legal_signoff_date:
      args.change.legal_signoff_date !== undefined
        ? args.change.legal_signoff_date
        : (current?.legal_signoff_date ?? null),
    legal_signoff_reference:
      args.change.legal_signoff_reference !== undefined
        ? args.change.legal_signoff_reference
        : (current?.legal_signoff_reference ?? null),
  };
  const unblocking = !next.blocked || !next.outbound_blocked;
  if (
    unblocking &&
    (next.legal_signoff_date === null || (next.legal_signoff_reference ?? "").trim() === "")
  ) {
    throw new MatrixError(
      `${country} can only be unblocked with counsel's sign-off: the date and its reference`,
    );
  }
  if (!next.outbound_blocked && next.blocked) {
    throw new MatrixError(
      "outbound calling is unblocked only after inbound is, in the same country",
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('syb.actor', ${actor}, true)`);
    await tx.execute(sql`select set_config('syb.reason', ${args.reason.trim()}, true)`);
    const values = { ...args.change, updated_at: new Date().toISOString() };
    const [row] = await tx
      .insert(countryComplianceMatrix)
      .values({ country, ...values })
      .onConflictDoUpdate({ target: countryComplianceMatrix.country, set: values })
      .returning();
    if (!row) throw new MatrixError("the change could not be saved");
    return row;
  });
}

/** Remove a country's row — it is then blocked again. Audit-logged like any change. */
export async function removeCountryRule(args: {
  country: string;
  actor: string;
  reason: string;
}): Promise<void> {
  const country = iso(args.country);
  if (args.actor.trim() === "") throw new MatrixError("say who is making this change");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('syb.actor', ${args.actor.trim()}, true)`);
    await tx.execute(sql`select set_config('syb.reason', ${args.reason.trim()}, true)`);
    await tx.delete(countryComplianceMatrix).where(eq(countryComplianceMatrix.country, country));
  });
}

export async function listCountryRules(): Promise<CountryRule[]> {
  return db.select().from(countryComplianceMatrix).orderBy(countryComplianceMatrix.country);
}

/** A country's change history, newest first. */
export async function countryChanges(country: string, limit = 50): Promise<CountryChange[]> {
  return db
    .select()
    .from(countryComplianceChanges)
    .where(eq(countryComplianceChanges.country, iso(country)))
    .orderBy(desc(countryComplianceChanges.at))
    .limit(limit);
}

/** The latest changes across every country, newest first — for /ops. */
export async function recentCountryChanges(limit = 20): Promise<CountryChange[]> {
  return db
    .select()
    .from(countryComplianceChanges)
    .orderBy(desc(countryComplianceChanges.at))
    .limit(limit);
}
