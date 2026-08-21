// Applicability resolver — step 20. Given a profile, which of the current
// bank's questions currently apply.
//
// Deterministic arithmetic over data: current field_records feed the
// condition evaluator (Session I), entity spines appear as array-valued
// views so `offers.length`-style conditions work, and the bank's stored
// ConditionExpr decides. No LLM anywhere near this (cost rule: never call
// a model for what deterministic code can do).

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  bankQuestions,
  bankVersions,
  channels,
  competitors,
  costItems,
  customerSegments,
  fieldRecords,
  goals,
  offers,
  staffRoles,
  suppliers,
} from "../../db/schema";
import type { ConditionContext, ConditionExpr, FieldView } from "../conditions/evaluate";
import { evaluate } from "../conditions/evaluate";
import type { FieldStatus } from "../core/field-status";
import { VALUE_BEARING_STATUSES } from "../core/field-status";
import type { ProfileSection } from "../profile/sections";

export class ResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolverError";
  }
}

/**
 * Build the evaluation context for a profile: every current field record,
 * plus each entity spine exposed as an answered array view — one uniform
 * lookup for `identity.sells` and `offers.length` alike.
 */
export async function buildConditionContext(profileId: string): Promise<ConditionContext> {
  const views = new Map<string, FieldView>();

  const records = await db
    .select({
      field_key: fieldRecords.field_key,
      status: fieldRecords.status,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  for (const record of records) {
    views.set(record.field_key, { status: record.status as FieldStatus, value: record.value });
  }

  const spines = [
    ["offers", offers],
    ["suppliers", suppliers],
    ["channels", channels],
    ["competitors", competitors],
    ["staff_roles", staffRoles],
    ["cost_items", costItems],
    ["customer_segments", customerSegments],
    ["goals", goals],
  ] as const;
  for (const [key, table] of spines) {
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.profile_id, profileId));
    // An empty spine is NOT an answer: a blank profile has zero offers, but
    // "what do you sell" is still unasked. Only existing entities produce a
    // value-bearing view (and with it, a truthy `answered`/.length base).
    views.set(
      key,
      rows.length > 0 ? { status: "answered", value: rows } : { status: "unasked", value: null },
    );
  }

  return { get: (fieldKey) => views.get(fieldKey) };
}

export interface ApplicableQuestion {
  id: string;
  bank_version: string;
  section: ProfileSection;
  writes_to: string;
  priority: "core" | "important" | "deep" | "optional";
  cost: number;
  prompt: unknown;
  help_text: unknown;
  input: unknown;
  unlocks: unknown;
  /** The writes_to field currently holds a value (exact-key match). */
  already_answered: boolean;
}

/**
 * The questions from the CURRENT bank whose condition holds for this
 * profile right now (null condition = always applicable). Applicability
 * is about which questions exist for this business — the interviewer
 * (Session L) decides ordering and skips what's answered.
 */
export async function applicableQuestions(profileId: string): Promise<ApplicableQuestion[]> {
  const [current] = await db.select().from(bankVersions).where(eq(bankVersions.is_current, true));
  if (!current) {
    throw new ResolverError("no current bank version is loaded — run the bank loader first");
  }

  const ctx = await buildConditionContext(profileId);
  const questions = await db
    .select()
    .from(bankQuestions)
    .where(eq(bankQuestions.bank_version, current.version));

  return questions
    .filter((q) => q.condition === null || evaluate(q.condition as ConditionExpr, ctx))
    .map((q) => {
      const view = ctx.get(q.writes_to);
      return {
        id: q.id,
        bank_version: q.bank_version,
        section: q.section,
        writes_to: q.writes_to,
        priority: q.priority,
        cost: q.cost,
        prompt: q.prompt,
        help_text: q.help_text,
        input: q.input,
        unlocks: q.unlocks,
        already_answered: view !== undefined && VALUE_BEARING_STATUSES.has(view.status),
      };
    });
}
