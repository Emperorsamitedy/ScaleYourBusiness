// Intake service — Session N (steps 26-27). The seam between the intake
// UI and the engine: resolver + tier gate pick what can be asked,
// coercion validates what comes back, writeField records it with
// provenance, completeness feeds the honest fraction (P0-66).
//
// Question selection runs in one of two modes (INTERVIEWER_MODE):
//   "llm"           — pickNextQuestion (Sonnet), the production path
//   "deterministic" — first open candidate in natural bank order; used
//                     for UI development and offline demos. Same
//                     guarantees (tier gate, no repeats), no judgment.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, offers } from "../../db/schema";
import {
  channels,
  competitors,
  costItems,
  customerSegments,
  goals,
  staffRoles,
  suppliers,
} from "../../db/schema";
import { createField } from "../core/field";
import type { FieldStatus } from "../core/field-status";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import type { InputSpec } from "../interviewer/harness/answers";
import { pickNextQuestion } from "../interviewer/interviewer";
import { selectCandidates } from "../interviewer/select";
import { coerceParsedValue } from "../parser/coerce";
import { writeField } from "../profile/field-store";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions } from "../resolver/applicability";
import { computeCompleteness } from "../scorer/completeness";
import { vocabularyCodes } from "../vocab/validate";
import { entityChipDisplay, loadEntityFields, writeEntityRows } from "./entities";
import type {
  AnswerAction,
  AnswerResponse,
  IntakeChip,
  IntakeOption,
  IntakeProgress,
  IntakeQuestion,
  IntakeState,
} from "./types";

export class IntakeError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "IntakeError";
  }
}

export function interviewerMode(): "llm" | "deterministic" {
  return process.env.INTERVIEWER_MODE === "llm" ? "llm" : "deterministic";
}

/** Natural order for bank ids: "1.10" after "1.9", "1.4.1.5a" after "1.4.1.5". */
export function naturalIdCompare(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = parseInt(x, 10);
    const yn = parseInt(y, 10);
    if (xn !== yn) return xn - yn;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** "physical_products" → "Physical products". */
export function humanizeCode(code: string): string {
  const words = code.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const SPINES = [
  ["offers", offers],
  ["suppliers", suppliers],
  ["channels", channels],
  ["competitors", competitors],
  ["staff_roles", staffRoles],
  ["cost_items", costItems],
  ["customer_segments", customerSegments],
  ["goals", goals],
] as const;

interface RecordsView {
  responded: Set<string>;
  skippedKeys: Set<string>;
  byKey: Map<string, { status: FieldStatus; value: unknown }>;
}

async function loadRecords(profileId: string): Promise<RecordsView> {
  const rows = await db
    .select({
      field_key: fieldRecords.field_key,
      status: fieldRecords.status,
      value: fieldRecords.value,
    })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  const responded = new Set<string>();
  const skippedKeys = new Set<string>();
  const byKey = new Map<string, { status: FieldStatus; value: unknown }>();
  for (const r of rows) {
    byKey.set(r.field_key, { status: r.status, value: r.value });
    if (r.status === "answered" || r.status === "inferred" || r.status === "unknown") {
      responded.add(r.field_key);
    }
    if (r.status === "skipped") skippedKeys.add(r.field_key);
  }
  for (const [key, table] of SPINES) {
    const spine = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.profile_id, profileId));
    if (spine.length > 0) responded.add(key);
  }
  return { responded, skippedKeys, byKey };
}

async function optionsFor(profileId: string, spec: InputSpec): Promise<IntakeOption[]> {
  if (spec.type !== "single_select" && spec.type !== "multi_select") return [];
  if (!spec.vocabulary_id) return [];
  if (spec.vocabulary_id === "__offers__") {
    const rows = await db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.profile_id, profileId));
    return rows.map((r, i) => ({ code: r.id, label: `Product ${i + 1}` }));
  }
  const codes = await vocabularyCodes(spec.vocabulary_id);
  return codes.map((code) => ({ code, label: humanizeCode(code) }));
}

async function toIntakeQuestion(
  profileId: string,
  q: ApplicableQuestion,
  currency: string,
): Promise<IntakeQuestion> {
  const spec = q.input as InputSpec;
  const base: IntakeQuestion = {
    id: q.id,
    priority: q.priority,
    cost: q.cost,
    prompt: ((q.prompt as Record<string, string> | null)?.en ?? "").trim(),
    help: ((q.help_text as Record<string, string> | null)?.en ?? "").trim() || null,
    input_type: spec.type,
    options: await optionsFor(profileId, spec),
    allow_unknown: spec.allow_unknown !== false,
    currency,
    entity_schema: spec.entity_schema ?? null,
  };
  if (spec.type === "entity_list" && spec.entity_schema) {
    base.entity_fields = await loadEntityFields(
      spec.entity_schema,
      (s) => optionsFor(profileId, s),
      currency,
    );
  }
  return base;
}

function progressOf(
  applicable: readonly ApplicableQuestion[],
  responded: ReadonlySet<string>,
): IntakeProgress {
  const core = applicable.filter((q) => q.priority === "core");
  const done = core.filter((q) => responded.has(q.writes_to)).length;
  return {
    core_done: done,
    core_total: core.length,
    fraction: core.length === 0 ? 1 : done / core.length,
  };
}

async function reportingCurrency(profileId: string): Promise<string> {
  const [row] = await db
    .select({ currency: accounts.reporting_currency })
    .from(businessProfiles)
    .innerJoin(accounts, eq(businessProfiles.account_id, accounts.id))
    .where(eq(businessProfiles.id, profileId));
  return row?.currency ?? "HUF";
}

/** Create a fresh account+profile for an intake session (no auth in Phase 0). */
export async function bootstrapIntake(): Promise<{ account_id: string; profile_id: string }> {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "en-GB" })
    .returning();
  if (!account) throw new IntakeError("account creation failed", 500);
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account.id, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new IntakeError("profile creation failed", 500);
  return { account_id: account.id, profile_id: profile.id };
}

async function askedEntries(
  applicable: readonly ApplicableQuestion[],
  view: RecordsView,
): Promise<{ question_id: string; answer_repr: string }[]> {
  const entries: { question_id: string; answer_repr: string }[] = [];
  for (const q of applicable) {
    const record = view.byKey.get(q.writes_to);
    if (!record) continue;
    if (
      record.status === "answered" ||
      record.status === "unknown" ||
      record.status === "skipped"
    ) {
      entries.push({
        question_id: q.id,
        answer_repr:
          record.status === "answered" ? JSON.stringify(record.value)?.slice(0, 60) : record.status,
      });
    }
  }
  return entries;
}

/** The current intake state: what to ask now, what's next, honest progress. */
export async function getIntakeState(accountId: string, profileId: string): Promise<IntakeState> {
  const [applicable, view, currency] = await Promise.all([
    applicableQuestions(profileId),
    loadRecords(profileId),
    reportingCurrency(profileId),
  ]);

  // A skipped question was asked this session — never re-surfaced here.
  const skippedIds = new Set(
    applicable.filter((q) => view.skippedKeys.has(q.writes_to)).map((q) => q.id),
  );
  const selection = selectCandidates(applicable, view.responded, skippedIds);
  const progress = progressOf(applicable, view.responded);

  if (selection.tier === null) {
    const score = await computeCompleteness(profileId);
    const answered = [...view.responded].length;
    return {
      profile_id: profileId,
      done: true,
      question: null,
      on_deck: null,
      progress,
      readout: {
        answered,
        gaps: score.blocking_gaps.length + view.skippedKeys.size,
        completeness: score.overall,
      },
    };
  }

  const ordered = [...selection.candidates].sort((a, b) => naturalIdCompare(a.id, b.id));
  let chosen = ordered[0];
  if (interviewerMode() === "llm") {
    const picked = await pickNextQuestion({
      accountId,
      profileId,
      asked: await askedEntries(applicable, view),
    });
    if (picked) chosen = picked.question;
  }
  if (!chosen) throw new IntakeError("no candidate despite open tier", 500);

  const onDeck = ordered.find((q) => q.id !== chosen.id);
  return {
    profile_id: profileId,
    done: false,
    question: await toIntakeQuestion(profileId, chosen, currency),
    on_deck: onDeck
      ? ((onDeck.prompt as Record<string, string> | null)?.en ?? "").trim() || null
      : null,
    progress,
    readout: null,
  };
}

function displayOf(spec: InputSpec, value: unknown, options: readonly IntakeOption[]): string {
  switch (spec.type) {
    case "money": {
      const m = value as Money;
      const major = m.amount_minor / 100;
      return `${new Intl.NumberFormat("en-GB").format(major)} ${m.currency}`;
    }
    case "boolean":
      return value === true ? "Yes" : "No";
    case "single_select": {
      const v = value as { code: string };
      return options.find((o) => o.code === v.code)?.label ?? humanizeCode(v.code);
    }
    case "multi_select": {
      const v = value as { code: string }[];
      return v
        .map((item) => options.find((o) => o.code === item.code)?.label ?? humanizeCode(item.code))
        .join(", ");
    }
    default: {
      const s = String(value);
      return s.length > 68 ? `${s.slice(0, 68)}…` : s;
    }
  }
}

/** Record an answer (typed value, explicit unknown, or skip) and advance. */
export async function submitAnswer(
  accountId: string,
  profileId: string,
  questionId: string,
  action: AnswerAction,
): Promise<AnswerResponse> {
  const [applicable, view, currency] = await Promise.all([
    applicableQuestions(profileId),
    loadRecords(profileId),
    reportingCurrency(profileId),
  ]);
  const skippedIds = new Set(
    applicable.filter((q) => view.skippedKeys.has(q.writes_to)).map((q) => q.id),
  );
  const selection = selectCandidates(applicable, view.responded, skippedIds);
  const question = selection.candidates.find((q) => q.id === questionId);
  if (!question) {
    throw new IntakeError(`question ${questionId} is not currently askable`, 409);
  }
  const spec = question.input as InputSpec;
  const options = await optionsFor(profileId, spec);
  const at = isoDateTime(new Date().toISOString());

  let status: FieldStatus;
  let value: unknown = null;
  let confidence = 0.75;
  let note: string | null = null;
  let display: string;

  if (action.kind === "unknown") {
    if (spec.allow_unknown === false) {
      throw new IntakeError("this question needs an answer", 422);
    }
    status = "unknown";
    display = "Not known";
  } else if (action.kind === "skip") {
    status = "skipped";
    display = "Skipped for now";
  } else {
    const coerced = coerceParsedValue(
      spec,
      action.wire,
      options.map((o) => o.code),
      currency,
    );
    if (!coerced.ok) throw new IntakeError(coerced.reason, 422);
    status = "answered";
    value = coerced.value;
    if (action.estimate) {
      confidence = 0.55; // §8.1: owner input, estimated
      note = "owner marked as estimate";
    }
    display = displayOf(spec, value, options);
  }

  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(question.writes_to),
      value: status === "answered" ? value : null,
      status,
      confidence,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note,
    }),
  );

  const provenance =
    status === "answered"
      ? `${question.id} · owner · ${note ? "estimate" : "stated"}`
      : status === "unknown"
        ? `${question.id} · gap · will revisit`
        : `${question.id} · skipped · will return`;

  const chip: IntakeChip = {
    question_id: question.id,
    prompt: ((question.prompt as Record<string, string> | null)?.en ?? "").trim(),
    display,
    provenance,
    dot: status === "answered" ? "solid" : "hollow",
  };
  return { chip, state: await getIntakeState(accountId, profileId) };
}

const ENTITY_TABLES: Record<string, typeof suppliers> = {
  supplier: suppliers,
  channel: channels as unknown as typeof suppliers,
  competitor: competitors as unknown as typeof suppliers,
  staff_role: staffRoles as unknown as typeof suppliers,
  cost_item: costItems as unknown as typeof suppliers,
  customer_segment: customerSegments as unknown as typeof suppliers,
  goal: goals as unknown as typeof suppliers,
};

/**
 * The real entity sub-form handler — Session O (P0-68..70). Rows of
 * { fieldKey: wire } become spine records + per-entity field records; the
 * chip collapses to "4 products · 3 with costs" with expandable detail.
 */
export async function submitEntities(
  accountId: string,
  profileId: string,
  questionId: string,
  rows: readonly Record<string, unknown>[],
): Promise<AnswerResponse> {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) {
    throw new IntakeError("between 1 and 20 rows required", 422);
  }
  const applicable = await applicableQuestions(profileId);
  const view = await loadRecords(profileId);
  const skippedIds = new Set(
    applicable.filter((q) => view.skippedKeys.has(q.writes_to)).map((q) => q.id),
  );
  const selection = selectCandidates(applicable, view.responded, skippedIds);
  const question = selection.candidates.find((q) => q.id === questionId);
  if (!question) throw new IntakeError(`question ${questionId} is not currently askable`, 409);
  const spec = question.input as InputSpec;
  if (spec.type !== "entity_list" || !spec.entity_schema) {
    throw new IntakeError("not an entity question", 422);
  }
  const currency = await reportingCurrency(profileId);
  const fields = await loadEntityFields(
    spec.entity_schema,
    (s) => optionsFor(profileId, s),
    currency,
  );
  try {
    const result = await writeEntityRows({
      profileId,
      question,
      schemaKey: spec.entity_schema,
      fields,
      rows,
      currency,
    });
    const chip: IntakeChip = {
      question_id: question.id,
      prompt: ((question.prompt as Record<string, string> | null)?.en ?? "").trim(),
      display: entityChipDisplay(result),
      provenance: `${question.id} · owner · stated`,
      dot: "solid",
      detail: result.detail,
    };
    return { chip, state: await getIntakeState(accountId, profileId) };
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 422) throw new IntakeError((error as Error).message, 422);
    throw error;
  }
}

/**
 * Interim entity_list handler for Session N: create `count` entities and
 * the marker record. Session O replaces this with the real sub-form
 * (P0-68) — names, per-row fields, "Add detail".
 */
export async function submitEntityCount(
  accountId: string,
  profileId: string,
  questionId: string,
  count: number,
): Promise<AnswerResponse> {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new IntakeError("count must be between 1 and 20", 422);
  }
  const applicable = await applicableQuestions(profileId);
  const question = applicable.find((q) => q.id === questionId);
  if (!question) throw new IntakeError(`question ${questionId} is not applicable`, 409);
  const spec = question.input as InputSpec;
  if (spec.type !== "entity_list" || !spec.entity_schema) {
    throw new IntakeError("not an entity question", 422);
  }

  let ids: string[];
  if (spec.entity_schema === "offer") {
    const view = await loadRecords(profileId);
    const sells = (view.byKey.get("identity.sells")?.value as { code: string }[] | undefined) ?? [];
    const kindOf: Record<
      string,
      "physical" | "service" | "digital" | "subscription" | "marketplace_access"
    > = {
      physical_products: "physical",
      services: "service",
      software: "digital",
      digital_products: "digital",
      subscriptions: "subscription",
      marketplace_access: "marketplace_access",
    };
    const kinds = Array.from(
      { length: count },
      (_, i) => kindOf[sells[i % Math.max(1, sells.length)]?.code ?? ""] ?? "physical",
    );
    const rows = await db
      .insert(offers)
      .values(kinds.map((kind) => ({ profile_id: profileId, kind })))
      .returning({ id: offers.id });
    ids = rows.map((r) => r.id);
  } else {
    const table = ENTITY_TABLES[spec.entity_schema];
    if (!table) throw new IntakeError(`unknown entity schema ${spec.entity_schema}`, 422);
    const base = { profile_id: profileId } as Record<string, unknown>;
    if (spec.entity_schema === "cost_item") base.bucket = "fixed";
    if (spec.entity_schema === "competitor") base.source = { kind: "owner_input" };
    const rows = await db
      .insert(table)
      .values(Array.from({ length: count }, () => ({ ...base }) as typeof table.$inferInsert))
      .returning({ id: table.id });
    ids = rows.map((r) => r.id);
  }

  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(question.writes_to),
      value: { entity_ids: ids },
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );

  const chip: IntakeChip = {
    question_id: question.id,
    prompt: ((question.prompt as Record<string, string> | null)?.en ?? "").trim(),
    display: `${count} recorded — details next session`,
    provenance: `${question.id} · owner · stated`,
    dot: "solid",
  };
  return { chip, state: await getIntakeState(accountId, profileId) };
}
