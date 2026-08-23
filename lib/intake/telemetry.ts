// Intake telemetry — P0-87 (steps 35-36). Log every hesitation, every
// confusion, the actual abandonment point — so P0-88 rewrites the
// questions that failed, not the ones that felt awkward to us.
//
// The client batches events and flushes with sendBeacon on page-hide, so
// abandonment is visible as a trail that simply stops. Recording must
// never break the intake: the route swallows malformed batches after
// validation rather than erroring the session.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { intakeEvents } from "../../db/schema";

export const EVENT_KINDS = [
  "question_shown",
  "first_input",
  "answer_recorded",
  "marked_unknown",
  "skipped",
  "reopened",
  "reconcile_shown",
  "reconcile_resolved",
  "session_resumed",
  "page_hidden",
] as const;

export type IntakeEventKind = (typeof EVENT_KINDS)[number];

export interface IntakeEventInput {
  kind: IntakeEventKind;
  question_id?: string | null;
  /** Hesitation on first_input, dwell on answer_recorded / skipped. */
  ms_since_shown?: number | null;
  meta?: Record<string, unknown> | null;
}

const MAX_BATCH = 50;
const KIND_SET = new Set<string>(EVENT_KINDS);

/** Validate and persist a client batch. Returns how many were accepted. */
export async function recordIntakeEvents(
  profileId: string,
  events: unknown,
): Promise<number> {
  if (!Array.isArray(events)) return 0;
  const rows = events
    .slice(0, MAX_BATCH)
    .filter(
      (e): e is IntakeEventInput =>
        e !== null &&
        typeof e === "object" &&
        typeof (e as { kind?: unknown }).kind === "string" &&
        KIND_SET.has((e as { kind: string }).kind),
    )
    .map((e) => ({
      profile_id: profileId,
      kind: e.kind,
      question_id: typeof e.question_id === "string" ? e.question_id.slice(0, 32) : null,
      ms_since_shown:
        typeof e.ms_since_shown === "number" && Number.isFinite(e.ms_since_shown)
          ? Math.max(0, Math.min(Math.round(e.ms_since_shown), 3_600_000))
          : null,
      meta: e.meta && typeof e.meta === "object" ? e.meta : null,
    }));
  if (rows.length === 0) return 0;
  await db.insert(intakeEvents).values(rows);
  return rows.length;
}

export interface QuestionTelemetry {
  question_id: string;
  shown: number;
  answered: number;
  skipped: number;
  unknown: number;
  reopened: number;
  /** ms from question shown to first keystroke — the hesitation signal. */
  median_hesitation_ms: number | null;
  /** ms from shown to recorded — the total cost of the question. */
  median_dwell_ms: number | null;
  /** Profiles whose event trail ENDS at this question — the walk-aways. */
  abandonments: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Per-question aggregates across profiles — the input to P0-88. An
 * abandonment is attributed to the LAST question a profile ever saw,
 * provided the trail did not end in an answer.
 */
export async function summarizeIntakeTelemetry(
  profileIds?: string[],
): Promise<QuestionTelemetry[]> {
  const rows = await db
    .select({
      profile_id: intakeEvents.profile_id,
      question_id: intakeEvents.question_id,
      kind: intakeEvents.kind,
      ms: intakeEvents.ms_since_shown,
      at: intakeEvents.at,
    })
    .from(intakeEvents)
    .where(
      profileIds && profileIds.length > 0
        ? inArray(intakeEvents.profile_id, profileIds)
        : undefined,
    )
    .orderBy(asc(intakeEvents.at));

  const byQuestion = new Map<
    string,
    {
      shown: number;
      answered: number;
      skipped: number;
      unknown: number;
      reopened: number;
      hesitations: number[];
      dwells: number[];
      abandonments: number;
    }
  >();
  const bucket = (id: string) => {
    const existing = byQuestion.get(id);
    if (existing) return existing;
    const fresh = {
      shown: 0,
      answered: 0,
      skipped: 0,
      unknown: 0,
      reopened: 0,
      hesitations: [] as number[],
      dwells: [] as number[],
      abandonments: 0,
    };
    byQuestion.set(id, fresh);
    return fresh;
  };

  // Last meaningful event per profile, for abandonment attribution.
  const lastByProfile = new Map<string, { question_id: string | null; kind: string }>();

  for (const row of rows) {
    if (row.kind !== "page_hidden") {
      lastByProfile.set(row.profile_id, { question_id: row.question_id, kind: row.kind });
    }
    if (!row.question_id) continue;
    const b = bucket(row.question_id);
    switch (row.kind) {
      case "question_shown":
        b.shown += 1;
        break;
      case "first_input":
        if (row.ms !== null) b.hesitations.push(row.ms);
        break;
      case "answer_recorded":
        b.answered += 1;
        if (row.ms !== null) b.dwells.push(row.ms);
        break;
      case "skipped":
        b.skipped += 1;
        break;
      case "marked_unknown":
        b.unknown += 1;
        break;
      case "reopened":
        b.reopened += 1;
        break;
    }
  }

  for (const last of lastByProfile.values()) {
    if (last.question_id && last.kind === "question_shown") {
      bucket(last.question_id).abandonments += 1;
    }
  }

  return [...byQuestion.entries()]
    .map(([question_id, b]) => ({
      question_id,
      shown: b.shown,
      answered: b.answered,
      skipped: b.skipped,
      unknown: b.unknown,
      reopened: b.reopened,
      median_hesitation_ms: median(b.hesitations),
      median_dwell_ms: median(b.dwells),
      abandonments: b.abandonments,
    }))
    .sort(
      (a, b) =>
        b.abandonments - a.abandonments ||
        (b.median_hesitation_ms ?? 0) - (a.median_hesitation_ms ?? 0),
    );
}

/** Events for one profile, oldest first — the raw trail for P0-86 review. */
export async function profileTrail(profileId: string) {
  return db
    .select()
    .from(intakeEvents)
    .where(and(eq(intakeEvents.profile_id, profileId)))
    .orderBy(asc(intakeEvents.at));
}
