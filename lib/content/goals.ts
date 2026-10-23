// Goals, end to end — Phase 3 Session C (P3-14).
//
// The spine has existed since P0-22 and intake fills it from 13.1; what
// was missing is a service that reads a goal as one coherent view,
// lets the owner add and refine goals OUTSIDE the interview, and
// suggests goals from the diagnosis — suggested, never auto-written:
// a goal is the owner's intent, and intent is not inferred.
//
// Every attribute write goes through the supersession store, so a goal
// edited in March still shows what it said in January (rule 3), and
// the trust layer (P3-25) can score outcomes against the statement
// that was true at approval time, not the one edited afterwards.

import { desc, eq } from "drizzle-orm";
import { db } from "../../db";
import type { DbTx } from "../../db";
import { diagnosisReports, goals } from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { SourceRef } from "../core/source-ref";
import { readCurrentField, writeField } from "../profile/field-store";
import type { StoredRecommendation } from "../report/service";
import { vocabularyCodes } from "../vocab/validate";
import { enumCode } from "../core/enum-value";

export class GoalError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "GoalError";
    this.status = status;
  }
}

export interface GoalView {
  goal_id: string;
  created_at: string;
  statement: string | null;
  /** goal_horizon vocabulary code — "3m", "6m", "12m"-class values. */
  horizon: string | null;
  /** focus_area vocabulary code. */
  area: string | null;
  target_value: string | null;
}

const ATTRS = ["statement", "horizon", "area", "target_value"] as const;
type GoalAttr = (typeof ATTRS)[number];

export async function listGoals(profileId: string): Promise<GoalView[]> {
  const spine = await db
    .select({ id: goals.id, created_at: goals.created_at })
    .from(goals)
    .where(eq(goals.profile_id, profileId))
    .orderBy(goals.created_at);
  const views: GoalView[] = [];
  for (const row of spine) {
    const view: GoalView = {
      goal_id: row.id,
      created_at: row.created_at,
      statement: null,
      horizon: null,
      area: null,
      target_value: null,
    };
    for (const attr of ATTRS) {
      const field = await readCurrentField<unknown>(profileId, `goals.${row.id}.${attr}`);
      // horizon and area are single-selects: the intake stores {code}.
      const v = field ? enumCode(field.value) : null;
      if (v !== null) view[attr] = v;
    }
    views.push(view);
  }
  return views;
}

export interface GoalInput {
  statement: string;
  horizon?: string | null;
  area?: string | null;
  target_value?: string | null;
}

async function validateCodes(input: Partial<GoalInput>): Promise<void> {
  if (input.horizon) {
    const codes = await vocabularyCodes("goal_horizon");
    if (!codes.includes(input.horizon)) {
      throw new GoalError(`horizon must be one of: ${codes.join(", ")}`, 422);
    }
  }
  if (input.area) {
    const codes = await vocabularyCodes("focus_area");
    if (!codes.includes(input.area)) {
      throw new GoalError(`area must be one of: ${codes.join(", ")}`, 422);
    }
  }
}

/**
 * Who stated it. The goals screen writes owner_input at 0.75; the chat
 * (feature 33) writes the owner's confirmed message — conversation at
 * 0.70, naming the utterance (conversation-channel §2.1, §2.3).
 */
export interface GoalWriteSource {
  source: SourceRef;
  confidence: number;
}
const OWNER_INPUT: GoalWriteSource = { source: { kind: "owner_input" }, confidence: 0.75 };

async function writeAttr(
  profileId: string,
  goalId: string,
  attr: GoalAttr,
  value: string,
  by: GoalWriteSource = OWNER_INPUT,
  tx?: DbTx,
): Promise<string> {
  const at = isoDateTime(new Date().toISOString());
  return writeField(
    profileId,
    createField<string>({
      id: fieldId(`goals.${goalId}.${attr}`),
      value,
      status: "answered",
      confidence: confidence(by.confidence),
      source: by.source,
      observed_at: at,
      recorded_at: at,
    }),
    tx ? { tx } : {},
  );
}

/**
 * One attribute of one goal, superseding — the chat's single-change
 * write (feature 33). Returns the new field record's id.
 */
export async function setGoalAttr(
  profileId: string,
  goalId: string,
  attr: "statement" | "target_value",
  value: string,
  by: GoalWriteSource,
  /** Join the caller's transaction (the chat's confirm, #21); validation is then the caller's. */
  tx?: DbTx,
): Promise<string> {
  const [spine] = await db
    .select({ id: goals.id, profile_id: goals.profile_id })
    .from(goals)
    .where(eq(goals.id, goalId));
  if (!spine || spine.profile_id !== profileId) throw new GoalError("no such goal", 404);
  if (value.trim() === "") throw new GoalError("a goal needs words", 422);
  return writeAttr(profileId, goalId, attr, value.trim(), by, tx);
}

/** Add a goal the owner states outside the interview. */
export async function addGoal(
  profileId: string,
  input: GoalInput,
  by: GoalWriteSource = OWNER_INPUT,
  /** Join the caller's transaction (the chat's confirm, #21); validation is then the caller's. */
  tx?: DbTx,
): Promise<GoalView> {
  if (input.statement.trim() === "") {
    throw new GoalError("a goal needs a statement — what do you want to achieve?", 422);
  }
  await validateCodes(input);
  const [row] = await (tx ?? db)
    .insert(goals)
    .values({ profile_id: profileId })
    .returning({ id: goals.id, created_at: goals.created_at });
  if (!row) throw new GoalError("could not create the goal", 500);
  await writeAttr(profileId, row.id, "statement", input.statement.trim(), by, tx);
  if (input.horizon) await writeAttr(profileId, row.id, "horizon", input.horizon, by, tx);
  if (input.area) await writeAttr(profileId, row.id, "area", input.area, by, tx);
  if (input.target_value) {
    await writeAttr(profileId, row.id, "target_value", input.target_value, by, tx);
  }
  if (tx) {
    // Uncommitted: the read path can't see it yet, so the view is what was written.
    return {
      goal_id: row.id,
      created_at: row.created_at,
      statement: input.statement.trim(),
      horizon: input.horizon ?? null,
      area: input.area ?? null,
      target_value: input.target_value ?? null,
    };
  }
  const [view] = (await listGoals(profileId)).filter((g) => g.goal_id === row.id);
  return view as GoalView;
}

/** Refine a goal — each changed attribute supersedes, never overwrites. */
export async function updateGoal(
  profileId: string,
  goalId: string,
  patch: Partial<GoalInput>,
): Promise<GoalView> {
  const [spine] = await db
    .select({ id: goals.id, profile_id: goals.profile_id })
    .from(goals)
    .where(eq(goals.id, goalId));
  if (!spine || spine.profile_id !== profileId) throw new GoalError("no such goal", 404);
  await validateCodes(patch);
  for (const attr of ATTRS) {
    const value = patch[attr];
    if (typeof value === "string" && value.trim() !== "") {
      await writeAttr(profileId, goalId, attr, value.trim());
    }
  }
  const [view] = (await listGoals(profileId)).filter((g) => g.goal_id === goalId);
  return view as GoalView;
}

export interface GoalSuggestion {
  statement: string;
  /** Where it came from — the recommendation on the report, by index. */
  source: string;
}

/**
 * Suggest goals from the latest diagnosis — deterministic, from the
 * recommendations' own titles. SUGGESTED, never written: the screen
 * offers each as one click, and only the owner's click writes.
 */
export async function suggestGoalsFromReport(profileId: string): Promise<GoalSuggestion[]> {
  const [report] = await db
    .select({ id: diagnosisReports.id, recommendations: diagnosisReports.recommendations })
    .from(diagnosisReports)
    .where(eq(diagnosisReports.profile_id, profileId))
    .orderBy(desc(diagnosisReports.generated_at))
    .limit(1);
  if (!report) return [];
  const recs = report.recommendations as StoredRecommendation[];
  const existing = new Set(
    (await listGoals(profileId)).map((g) => g.statement?.toLowerCase().trim()).filter(Boolean),
  );
  return recs
    .filter((r) => r.status !== "rejected")
    .map((r, i) => ({ statement: r.title, source: `report:${report.id}:rec:${i}` }))
    .filter((s) => !existing.has(s.statement.toLowerCase().trim()));
}
