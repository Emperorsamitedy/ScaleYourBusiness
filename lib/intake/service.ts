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

import { englishLabel } from "../bank/english-labels";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  bankQuestions,
  bankVersions,
  businessProfiles,
  fieldRecords,
  offers,
} from "../../db/schema";
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
import { currencyForCountry } from "../core/country-currency";
import { isIsoCurrency } from "../core/currencies";
import type { AppLocale } from "../i18n/locales";
import { isAppLocale } from "../i18n/locales";
import { trFor } from "../i18n/server-tr";
import { findingWords } from "../validation/words";
import type { CoerceCode } from "../parser/coerce";
import { coerceParsedValue } from "../parser/coerce";
import type { BankWords } from "../bank/words";
import { ENGLISH_WORDS, loadBankWords } from "../bank/words";
import { factWords } from "../bank/fact-words";
import { dynamicVocabularyOptions, isDynamicVocabulary } from "../profile/dynamic-vocab";
import { writeField } from "../profile/field-store";
import { recordFunnelEvent } from "./telemetry";
import { openFindings, resolveFinding } from "../validation/engine";
import type { ConditionExpr } from "../conditions/evaluate";
import { getProvider } from "../connectors/registry";
import type { ProviderId } from "../connectors/scopes";
import { PROVIDER_IDS } from "../connectors/scopes";
import type { ProfileSection } from "../profile/sections";
import { isProfileSection } from "../profile/sections";
import type { ApplicableQuestion } from "../resolver/applicability";
import { applicableQuestions, buildConditionContext } from "../resolver/applicability";
import type { AreaQuestion, ResponseKind } from "./areas";
import { computeAreas, naturalIdCompare, responseKindOf } from "./areas";
import type { CurrentRow } from "./record-view";
import { alreadyRead, areaRecord, buildRecord, listFacts } from "./record-view";
import { computeCompleteness, scoreQuestions } from "../scorer/completeness";
import { computeEconomics } from "../economics/unit-economics";
import { displaySourceKind } from "../connectors/measured";
import { VALUE_BEARING_STATUSES } from "../core/field-status";
import type { ConditionContext } from "../conditions/evaluate";
import type { FieldRecordRow } from "../profile/field-codec";
import type { SnapshotEntity } from "../profile/snapshot";
import { sectionOfFieldKey } from "../profile/sections";
import { currentRecordsView, liveReadingOf } from "./live-reading";
import { vocabularyCodes } from "../vocab/validate";
import { costBucketFor, entityChipDisplay, loadEntityFields, writeEntityRows } from "./entities";
import type {
  AnswerAction,
  AnswerResponse,
  IntakeChip,
  IntakeFinding,
  IntakeOption,
  IntakeProgress,
  IntakeQuestion,
  IntakeState,
  IntakeUnlock,
  LiveReading,
  ReconcileResponse,
  RecordFact,
} from "./types";

/**
 * Why the intake refused something, as a code the screen words in the
 * person's language (messages/*.json intake.error.*). The English message
 * stays for logs and for any caller without a catalogue.
 */
export type IntakeErrorCode =
  | CoerceCode
  | "needs_answer"
  | "reason_needed"
  | "not_askable"
  | "no_answer_to_reopen"
  | "rows_range"
  | "not_entity"
  | "unknown_field"
  | "finding_not_open"
  | "invalid";

export class IntakeError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code: IntakeErrorCode = "invalid",
    /** The figures or names the message mentions, for the translated line. */
    public readonly values: Record<string, string | number> = {},
  ) {
    super(message);
    this.name = "IntakeError";
  }
}

export function interviewerMode(): "llm" | "deterministic" {
  return process.env.INTERVIEWER_MODE === "llm" ? "llm" : "deterministic";
}

export { naturalIdCompare };

/** "physical_products" → "Physical products". */
export function humanizeCode(code: string): string {
  const words = code.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A LocalizedText's English, trimmed: the bank's own words. */
function englishOf(text: unknown): string {
  return ((text as Record<string, string> | null)?.en ?? "").trim();
}

/** A question's prompt in the person's language (the bank's English underneath). */
function promptOf(q: { id: string; prompt: unknown }, words: BankWords): string {
  return words.prompt(q.id, englishOf(q.prompt));
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
  /** The current records in full, for the record sheet. */
  rows: CurrentRow[];
  /** The same rows as Field codec rows, for the live economics view. */
  fieldRows: FieldRecordRow[];
  /** Every entity row alive on the profile, with the kind the economics engine reads. */
  entities: SnapshotEntity[];
  /** writes_to → what its current response is, for the tile bars. */
  responseKinds: Map<string, ResponseKind>;
}

async function loadRecords(profileId: string): Promise<RecordsView> {
  const rows = await db
    .select({
      profile_id: fieldRecords.profile_id,
      section: fieldRecords.section,
      field_key: fieldRecords.field_key,
      status: fieldRecords.status,
      value: fieldRecords.value,
      source: fieldRecords.source,
      note: fieldRecords.note,
      confidence: fieldRecords.confidence,
      observed_at: fieldRecords.observed_at,
      recorded_at: fieldRecords.recorded_at,
    })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  const responded = new Set<string>();
  const skippedKeys = new Set<string>();
  const byKey = new Map<string, { status: FieldStatus; value: unknown }>();
  const responseKinds = new Map<string, ResponseKind>();
  for (const r of rows) {
    byKey.set(r.field_key, { status: r.status, value: r.value });
    const kind = responseKindOf(r.status, displaySourceKind(r.source));
    if (kind !== null) responseKinds.set(r.field_key, kind);
    if (r.status === "answered" || r.status === "inferred" || r.status === "unknown") {
      responded.add(r.field_key);
    }
    if (r.status === "skipped") skippedKeys.add(r.field_key);
  }
  const entities: SnapshotEntity[] = [];
  for (const [key, table] of SPINES) {
    // Offers carry a kind and cost items a fixed/variable bucket — the
    // entity kind the economics engine reads (as lib/profile/snapshot does).
    const spine: { id: string; kind: string | null }[] =
      key === "offers"
        ? await db
            .select({ id: offers.id, kind: offers.kind })
            .from(offers)
            .where(eq(offers.profile_id, profileId))
        : key === "cost_items"
          ? await db
              .select({ id: costItems.id, kind: costItems.bucket })
              .from(costItems)
              .where(eq(costItems.profile_id, profileId))
          : (
              await db.select({ id: table.id }).from(table).where(eq(table.profile_id, profileId))
            ).map((r) => ({ id: r.id, kind: null }));
    if (spine.length > 0) responded.add(key);
    entities.push(...spine.map((r) => ({ spine: key, id: r.id, kind: r.kind ?? null })));
  }
  const fieldRows: FieldRecordRow[] = rows.map((r) => ({
    profile_id: r.profile_id,
    section: r.section,
    field_key: r.field_key,
    value: r.value,
    status: r.status,
    confidence: String(r.confidence),
    source: r.source,
    observed_at: r.observed_at,
    recorded_at: r.recorded_at,
    note: r.note,
  }));
  return { responded, skippedKeys, byKey, rows, fieldRows, entities, responseKinds };
}

/** Report readiness: the completeness scorer's own arithmetic over what is already loaded. */
function readinessOf(applicable: readonly ApplicableQuestion[], ctx: ConditionContext): number {
  return scoreQuestions(
    applicable.map((q) => {
      const view = ctx.get(q.writes_to);
      return {
        priority: q.priority,
        section: q.section,
        writes_to: q.writes_to,
        responded:
          view !== undefined &&
          (VALUE_BEARING_STATUSES.has(view.status) || view.status === "unknown"),
      };
    }),
    isoDateTime(new Date().toISOString()),
  ).overall;
}

/** The live reading on the current records; null when the engine refuses. */
function liveReading(
  profileId: string,
  view: RecordsView,
  currency: string,
  locale: AppLocale = "en",
): LiveReading | null {
  try {
    const records = currentRecordsView(
      profileId,
      view.fieldRows,
      view.entities,
      new Date().toISOString(),
    );
    // L-4a: the label and formula in the reader's language (lib/economics/words).
    return liveReadingOf(computeEconomics(records, currency), {
      tr: trFor(locale, "econWords"),
      locale,
    });
  } catch {
    // A figure the engine cannot compute is not a reason to fail the intake.
    return null;
  }
}

/** The bank's `unlocks` for one question, each with whether it applies yet. */
function unlocksOf(
  q: ApplicableQuestion,
  bank: readonly BankQuestion[],
  applicable: readonly ApplicableQuestion[],
): IntakeUnlock[] {
  const ids = Array.isArray(q.unlocks)
    ? q.unlocks.filter((x): x is string => typeof x === "string")
    : [];
  return ids.flatMap((id) => {
    const target = bank.find((b) => b.id === id);
    if (!target) return [];
    return [
      {
        id,
        section: target.section,
        prompt: target.prompt,
        open: applicable.some((a) => a.id === id),
      },
    ];
  });
}

/** A bank question as the tiles and the unlock list read it. */
interface BankQuestion extends AreaQuestion {
  prompt: string;
}

/** Every question of the current bank with its condition — what the area tiles read. */
async function areaQuestions(words: BankWords): Promise<BankQuestion[]> {
  const rows = await db
    .select({
      id: bankQuestions.id,
      section: bankQuestions.section,
      writes_to: bankQuestions.writes_to,
      condition: bankQuestions.condition,
      prompt: bankQuestions.prompt,
    })
    .from(bankQuestions)
    .innerJoin(bankVersions, eq(bankQuestions.bank_version, bankVersions.version))
    .where(eq(bankVersions.is_current, true));
  return rows.map((r) => ({
    id: r.id,
    section: r.section,
    writes_to: r.writes_to,
    condition: (r.condition as ConditionExpr | null) ?? null,
    prompt: words.prompt(r.id, englishOf(r.prompt)),
  }));
}

/** "shopify" → "Shopify", from the connector registry; the id itself when unregistered. */
function providerLabel(id: string): string {
  if ((PROVIDER_IDS as readonly string[]).includes(id)) {
    return getProvider(id as ProviderId).label;
  }
  return id;
}

/** A preferred area from the wire: a real profile section, or nothing. */
export function parseSection(raw: unknown): ProfileSection | undefined {
  return typeof raw === "string" && isProfileSection(raw) ? raw : undefined;
}

async function optionsFor(
  profileId: string,
  spec: InputSpec,
  words: BankWords = ENGLISH_WORDS,
  questionId?: string,
): Promise<IntakeOption[]> {
  if (spec.type !== "single_select" && spec.type !== "multi_select") return [];
  if (!spec.vocabulary_id) return [];
  // Dynamic vocabularies are the owner's own entities, not bank codes.
  if (isDynamicVocabulary(spec.vocabulary_id)) {
    return dynamicVocabularyOptions(profileId, spec.vocabulary_id);
  }
  const vocabularyId = spec.vocabulary_id;
  const codes = await vocabularyCodes(vocabularyId);
  // The bank's own words for a code when it carries them ("solo" reads "Just me"),
  // in the person's language when an overlay has them (L-2). The code stays the answer.
  return codes.map((code) => ({
    code,
    label: words.option(
      vocabularyId,
      code,
      spec.option_labels?.[code]?.en?.trim() ||
        englishLabel(vocabularyId, code) ||
        humanizeCode(code),
      questionId,
    ),
  }));
}

async function toIntakeQuestion(
  profileId: string,
  q: ApplicableQuestion,
  currency: string,
  area: { position: number; alreadyRead: RecordFact | null; unlocks: IntakeUnlock[] } = {
    position: 1,
    alreadyRead: null,
    unlocks: [],
  },
  words: BankWords = ENGLISH_WORDS,
): Promise<IntakeQuestion> {
  const spec = q.input as InputSpec;
  const base: IntakeQuestion = {
    id: q.id,
    priority: q.priority,
    cost: q.cost,
    prompt: promptOf(q, words),
    help: words.help(q.id, englishOf(q.help_text) || null),
    input_type: spec.type,
    options: await optionsFor(profileId, spec, words, q.id),
    allow_unknown: spec.allow_unknown !== false,
    currency,
    entity_schema: spec.entity_schema ?? null,
    writes_to: q.writes_to,
    section: q.section,
    area_position: area.position,
    already_read: area.alreadyRead,
    missing_piece: area.alreadyRead !== null && area.alreadyRead.key !== q.writes_to,
    unlocks: area.unlocks,
  };
  if (spec.type === "entity_list" && spec.entity_schema) {
    base.entity_fields = await loadEntityFields(
      spec.entity_schema,
      (s) => optionsFor(profileId, s, words),
      currency,
      words,
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

/**
 * Create a fresh account+profile for an intake session (no auth in Phase 0).
 * L-1: with the first step's choices (lib/i18n/server pendingChoices), the
 * business starts in the person's language and the currency they chose;
 * without them, English and the default the country may later replace.
 */
export async function bootstrapIntake(
  choices: { language?: AppLocale | null; currency?: string | null } = {},
): Promise<{ account_id: string; profile_id: string }> {
  const currency = choices.currency && isIsoCurrency(choices.currency) ? choices.currency : null;
  const [account] = await db
    .insert(accounts)
    .values({
      reporting_currency: currency ?? "HUF",
      reporting_currency_chosen_at: currency ? new Date().toISOString() : null,
      locale: "en-GB",
    })
    .returning();
  if (!account) throw new IntakeError("account creation failed", 500);
  const [profile] = await db
    .insert(businessProfiles)
    .values({
      account_id: account.id,
      schema_version: "1.0.0",
      language: isAppLocale(choices.language) ? choices.language : "en",
    })
    .returning();
  if (!profile) throw new IntakeError("profile creation failed", 500);
  await recordFunnelEvent(profile.id, "funnel_intake_started");
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

/**
 * Map a finding's field_keys to the applicable questions that wrote them —
 * exact key or the key's sub-tree (so "costs" reaches 5.1 and 5.2).
 */
function findingQuestionIds(fieldKeys: string[], applicable: ApplicableQuestion[]): string[] {
  const ids = new Set<string>();
  for (const key of fieldKeys) {
    for (const q of applicable) {
      if (q.writes_to === key || q.writes_to.startsWith(`${key}.`)) ids.add(q.id);
    }
  }
  return [...ids].sort(naturalIdCompare);
}

/** Open findings shaped for the wire (P0-82). */
async function intakeFindings(
  profileId: string,
  applicable: ApplicableQuestion[],
  locale: AppLocale = "en",
): Promise<IntakeFinding[]> {
  const rows = await openFindings(profileId);
  const tr = trFor(locale, "validationWords");
  return rows.map((row) => ({
    id: row.id,
    rule_id: row.rule_id,
    kind: row.kind,
    // L-4a: the stored sentence in the reader's language (lib/validation/words).
    message: findingWords(row.rule_id, row.message as { en?: unknown }, tr, locale),
    question_ids: findingQuestionIds(row.field_keys as string[], applicable),
  }));
}

/** Open questions in one area in bank order, then that area's skips. */
function pickInSection(
  applicable: readonly ApplicableQuestion[],
  view: RecordsView,
  section: ProfileSection,
): ApplicableQuestion | undefined {
  const inArea = applicable
    .filter((q) => q.section === section && !view.responded.has(q.writes_to))
    .sort((a, b) => naturalIdCompare(a.id, b.id));
  return inArea.find((q) => !view.skippedKeys.has(q.writes_to)) ?? inArea[0];
}

/**
 * The masthead's business name: identity.legal_name (bank 1.1) when it
 * holds a value, else an identity.business_name a test seed or an older
 * path recorded. Null when neither does — the masthead then names none.
 */
function legalName(view: RecordsView): string | null {
  for (const key of ["identity.legal_name", "identity.business_name"]) {
    const record = view.byKey.get(key);
    if (!record || (record.status !== "answered" && record.status !== "inferred")) continue;
    if (typeof record.value === "string" && record.value.trim() !== "") return record.value.trim();
  }
  return null;
}

/** The current intake state: what to ask now, what's next, honest progress. */
export async function getIntakeState(
  accountId: string,
  profileId: string,
  preferId?: string,
  preferSection?: ProfileSection,
  locale: AppLocale = "en",
): Promise<IntakeState> {
  const words = await loadBankWords(locale);
  const [applicable, view, currency, bank, ctx, profileRow] = await Promise.all([
    applicableQuestions(profileId),
    loadRecords(profileId),
    reportingCurrency(profileId),
    areaQuestions(words),
    buildConditionContext(profileId),
    db
      .select({ next_question_id: businessProfiles.next_question_id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId))
      .then((rows) => rows[0]),
  ]);

  // A skipped question was asked this session — never re-surfaced here.
  const skippedIds = new Set(
    applicable.filter((q) => view.skippedKeys.has(q.writes_to)).map((q) => q.id),
  );
  const selection = selectCandidates(applicable, view.responded, skippedIds);
  const progress = progressOf(applicable, view.responded);
  // P1-52: the core-complete funnel stage, recorded the first time the
  // fraction reaches 1 (recordFunnelEvent deduplicates). Read-side on
  // purpose: completion is a property of the profile's state, not of
  // whichever write happened to tip it over.
  if (progress.core_total > 0 && progress.core_done >= progress.core_total) {
    await recordFunnelEvent(profileId, "funnel_core_completed");
  }

  const findings = await intakeFindings(profileId, applicable, locale);

  // An explicit ask names the question the owner wants — a gap on the
  // fact sheet or a reopen. It resolves against everything applicable
  // and unanswered, NOT the auto-selection candidates, for two reasons
  // the candidates cannot cover. Skipped questions: auto-selection never
  // re-surfaces a skip, but the owner pressing "Answer now" on that gap
  // is the owner changing their mind. Finished interviews: once tier is
  // null there are no candidates at all, yet a finished interview is
  // exactly where the gaps view matters — it is the only state with a
  // report. Found live: every "Answer now" on a completed profile landed
  // on the done screen with no question.
  const preferred = preferId
    ? applicable.find((q) => q.id === preferId && !view.responded.has(q.writes_to))
    : undefined;

  const ordered = [...selection.candidates].sort((a, b) => naturalIdCompare(a.id, b.id));

  // An area tile names a section the owner wants to work on. Within it:
  // the auto-selection candidates first (the tier gate still orders the
  // area), then anything open there, then — the owner having chosen the
  // area — what they skipped in it earlier, as a gap link would.
  const sectionPick =
    !preferred && preferSection
      ? (ordered.find((q) => q.section === preferSection) ??
        pickInSection(applicable, view, preferSection))
      : undefined;

  // The record sheet, the masthead name and the area tiles, for every state.
  const questionIdByKey = new Map(applicable.map((q) => [q.writes_to, q.id]));
  const listed = listFacts({
    rows: view.rows,
    questionIdByKey,
    providerLabel,
    factWords: factWords(words),
  });
  const record = buildRecord(listed);
  const businessName = legalName(view);
  const areasFor = (activeSection: string | null, activeQuestionId: string | null) =>
    computeAreas({
      questions: bank,
      ctx,
      responded: view.responded,
      skippedKeys: view.skippedKeys,
      activeSection,
      activeQuestionId,
      responseKinds: view.responseKinds,
    });
  const readiness = readinessOf(applicable, ctx);
  const live = liveReading(profileId, view, currency, locale);
  // A fact's area: the section of the question that writes it, else its key's home.
  const sectionByQuestion = new Map<string, string>(applicable.map((q) => [q.id, q.section]));
  const sectionOfFact = (f: RecordFact): string | null => {
    const byQuestion = f.question_id ? sectionByQuestion.get(f.question_id) : undefined;
    if (byQuestion) return byQuestion;
    try {
      return sectionOfFieldKey(f.key);
    } catch {
      return null;
    }
  };

  if (selection.tier === null && !preferred && !sectionPick) {
    const score = await computeCompleteness(profileId);
    const answered = [...view.responded].length;
    return {
      profile_id: profileId,
      business_name: businessName,
      areas: areasFor(null, null),
      record,
      readiness,
      live_reading: live,
      area_record: null,
      done: true,
      question: null,
      on_deck: null,
      progress,
      findings,
      readout: {
        answered,
        gaps: score.blocking_gaps.length + view.skippedKeys.size,
        completeness: score.overall,
      },
    };
  }

  // A preferred question (reopen, gap link) goes straight to the centre
  // (P0-75, §4.1) — even when it is not an auto-selection candidate. An
  // area pick is the owner's choice too, so the interviewer is not asked.
  let chosen = preferred ?? sectionPick ?? ordered[0];
  if (!preferred && !sectionPick && interviewerMode() === "llm") {
    // Reuse the last pick when it is still an open candidate.
    //
    // This function runs on every read of the intake state — every page
    // load, every poll, and again after each answer — and the interviewer
    // is a Sonnet call. Re-picking each time meant an owner who refreshed
    // the page five times paid for five calls to be shown the question
    // already on their screen. Measured on a live run: 192 calls for ~50
    // answers, ~3.8x what the interview actually needs, against a €50/month
    // budget.
    //
    // The stored id is a cache, not a fact, so it is honoured only while it
    // is still in the candidate set. That makes it self-invalidating —
    // answering the question removes it from the candidates and forces
    // exactly one fresh pick — with no explicit invalidation to keep in
    // sync with the write path.
    const cached = profileRow?.next_question_id
      ? ordered.find((q) => q.id === profileRow.next_question_id)
      : undefined;
    if (cached) {
      chosen = cached;
    } else {
      const picked = await pickNextQuestion({
        accountId,
        profileId,
        asked: await askedEntries(applicable, view),
        locale: words.locale,
      });
      if (picked) chosen = picked.question;
    }
  }
  if (!chosen) throw new IntakeError("no candidate despite open tier", 500);
  if (chosen.id !== profileRow?.next_question_id) {
    await db
      .update(businessProfiles)
      .set({ next_question_id: chosen.id })
      .where(eq(businessProfiles.id, profileId));
  }

  const onDeck = ordered.find((q) => q.id !== chosen.id);
  const earlierInArea = applicable.filter(
    (q) =>
      q.section === chosen.section &&
      q.id !== chosen.id &&
      (view.responded.has(q.writes_to) || view.skippedKeys.has(q.writes_to)),
  ).length;
  return {
    profile_id: profileId,
    business_name: businessName,
    areas: areasFor(chosen.section, chosen.id),
    record,
    readiness,
    live_reading: live,
    area_record: areaRecord(listed, chosen.section, sectionOfFact),
    done: false,
    question: await toIntakeQuestion(
      profileId,
      chosen,
      currency,
      {
        position: earlierInArea + 1,
        alreadyRead: alreadyRead(chosen.writes_to, listed),
        unlocks: unlocksOf(chosen, bank, applicable),
      },
      words,
    ),
    on_deck: onDeck ? promptOf(onDeck, words) || null : null,
    progress,
    findings,
    readout: null,
  };
}

/**
 * Resolve a finding the owner has looked at (P0-83, §4.5). "Both are
 * right" records a confirmation and clears the flag. "Let me fix one"
 * records a correction and returns the involved questions to the centre
 * in sequence — the same supersede-to-unasked mechanic as reopen, so
 * both original values stay in history.
 */
export async function reconcileFinding(
  accountId: string,
  profileId: string,
  findingId: string,
  choice: "confirm" | "fix",
  locale: AppLocale = "en",
): Promise<ReconcileResponse> {
  const findings = await openFindings(profileId);
  const finding = findings.find((f) => f.id === findingId);
  if (!finding) {
    throw new IntakeError(
      `finding ${findingId} is not open on this profile`,
      404,
      "finding_not_open",
    );
  }

  if (choice === "confirm") {
    await resolveFinding(findingId, "owner_confirmed", "both are right");
    return {
      reopened: [],
      state: await getIntakeState(accountId, profileId, undefined, undefined, locale),
    };
  }

  await resolveFinding(findingId, "owner_corrected", "let me fix one");
  const [applicable, view] = await Promise.all([
    applicableQuestions(profileId),
    loadRecords(profileId),
  ]);
  const involved = findingQuestionIds(finding.field_keys as string[], applicable);
  const reopened: string[] = [];
  for (const id of involved) {
    const q = applicable.find((c) => c.id === id);
    if (!q || !view.responded.has(q.writes_to)) continue;
    const at = isoDateTime(new Date().toISOString());
    await writeField(
      profileId,
      createField<unknown>({
        id: fieldId(q.writes_to),
        value: null,
        status: "unasked",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
        note: `reconcile: ${finding.rule_id}`,
      }),
    );
    reopened.push(q.id);
  }
  return {
    reopened,
    state: await getIntakeState(accountId, profileId, reopened[0], undefined, locale),
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
  preferSection?: ProfileSection,
  locale: AppLocale = "en",
): Promise<AnswerResponse> {
  const words = await loadBankWords(locale);
  const [applicable, view, currency] = await Promise.all([
    applicableQuestions(profileId),
    loadRecords(profileId),
    reportingCurrency(profileId),
  ]);
  // P0-75: reopen has the inverse gate — the question must already be
  // responded. The old value stays in history (supersession); the new
  // current record is `unasked` carrying the owner's reason, which makes
  // the question a candidate again and returns it to the centre.
  if (action.kind === "reopen") {
    // The reason arrives from an HTTP body the route only casts, never
    // checks, so a missing one used to reach .trim() and 500 — an input
    // mistake reported as our fault. It is the same 422 as an empty one.
    const reason = typeof action.reason === "string" ? action.reason.trim() : "";
    if (reason === "") {
      throw new IntakeError("a reason is needed to change an answer", 422, "reason_needed");
    }
    const target = applicable.find((q) => q.id === questionId);
    if (!target || !view.responded.has(target.writes_to)) {
      throw new IntakeError(
        `question ${questionId} has no answer to reopen`,
        409,
        "no_answer_to_reopen",
      );
    }
    const reopenAt = isoDateTime(new Date().toISOString());
    await writeField(
      profileId,
      createField<unknown>({
        id: fieldId(target.writes_to),
        value: null,
        status: "unasked",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: reopenAt,
        recorded_at: reopenAt,
        note: `reopened: ${reason}`,
      }),
    );
    return {
      chip: {
        question_id: target.id,
        prompt: promptOf(target, words),
        display: "Reopened",
        provenance: `${target.id} · reopened`,
        dot: "hollow",
      },
      state: await getIntakeState(accountId, profileId, target.id, undefined, locale),
    };
  }

  const skippedIds = new Set(
    applicable.filter((q) => view.skippedKeys.has(q.writes_to)).map((q) => q.id),
  );
  const selection = selectCandidates(applicable, view.responded, skippedIds);
  // Candidates first; then anything applicable and unanswered, so a
  // question reached through a gap link — skipped earlier, or after the
  // interview finished — can actually be answered. Answered questions
  // still 409 here: changing an answer goes through reopen, with a
  // reason, so the supersession trail says why.
  const question =
    selection.candidates.find((q) => q.id === questionId) ??
    applicable.find((q) => q.id === questionId && !view.responded.has(q.writes_to));
  if (!question) {
    throw new IntakeError(`question ${questionId} is not currently askable`, 409, "not_askable");
  }
  const spec = question.input as InputSpec;
  const options = await optionsFor(profileId, spec, words, question.id);
  const at = isoDateTime(new Date().toISOString());

  let status: FieldStatus;
  let value: unknown = null;
  let confidence = 0.75;
  let note: string | null = null;
  let display: string;

  if (action.kind === "unknown") {
    if (spec.allow_unknown === false) {
      throw new IntakeError("this question needs an answer", 422, "needs_answer");
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
    if (!coerced.ok) {
      throw new IntakeError(coerced.reason, 422, coerced.code, coerced.values ?? {});
    }
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

  // The reporting currency follows the country, because nothing in the
  // bank ever asks for it and the account is created with a default.
  // Without this, an owner outside that default's country gets every
  // figure in their report labelled in the wrong currency — found live,
  // where a US candle maker's $18 printed as "18 HUF". Only ever set
  // from a recognised country; an unrecognised answer leaves it alone.
  // Money records carry their own currency, so anything already written
  // keeps its label and the economics layer still refuses to blend.
  // L-1: a currency the owner chose themselves (at sign-up or in settings)
  // is never replaced by the country's.
  if (question.writes_to === "legal.country" && status === "answered") {
    const resolved = currencyForCountry(value);
    if (resolved !== null && resolved !== currency) {
      await db
        .update(accounts)
        .set({ reporting_currency: resolved })
        .where(and(eq(accounts.id, accountId), isNull(accounts.reporting_currency_chosen_at)));
    }
  }

  const provenance =
    status === "answered"
      ? `${question.id} · owner · ${note ? "estimate" : "stated"}`
      : status === "unknown"
        ? `${question.id} · gap · will revisit`
        : `${question.id} · skipped · will return`;

  const chip: IntakeChip = {
    question_id: question.id,
    prompt: promptOf(question, words),
    display,
    provenance,
    dot: status === "answered" ? "solid" : "hollow",
  };
  return {
    chip,
    state: await getIntakeState(accountId, profileId, undefined, preferSection, locale),
  };
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
  preferSection?: ProfileSection,
  locale: AppLocale = "en",
): Promise<AnswerResponse> {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 20) {
    throw new IntakeError("between 1 and 20 rows required", 422, "rows_range", {
      min: 1,
      max: 20,
    });
  }
  const words = await loadBankWords(locale);
  const applicable = await applicableQuestions(profileId);
  const view = await loadRecords(profileId);
  const skippedIds = new Set(
    applicable.filter((q) => view.skippedKeys.has(q.writes_to)).map((q) => q.id),
  );
  const selection = selectCandidates(applicable, view.responded, skippedIds);
  // Same widening as submitAnswer: a gap link may point at an entity
  // question that was skipped or that outlived the interview.
  const question =
    selection.candidates.find((q) => q.id === questionId) ??
    applicable.find((q) => q.id === questionId && !view.responded.has(q.writes_to));
  if (!question) {
    throw new IntakeError(`question ${questionId} is not currently askable`, 409, "not_askable");
  }
  const spec = question.input as InputSpec;
  if (spec.type !== "entity_list" || !spec.entity_schema) {
    throw new IntakeError("not an entity question", 422, "not_entity");
  }
  const currency = await reportingCurrency(profileId);
  const fields = await loadEntityFields(
    spec.entity_schema,
    (s) => optionsFor(profileId, s, words),
    currency,
    words,
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
      prompt: promptOf(question, words),
      display: entityChipDisplay(result),
      provenance: `${question.id} · owner · stated`,
      dot: "solid",
      detail: result.detail,
    };
    return {
      chip,
      state: await getIntakeState(accountId, profileId, undefined, preferSection, locale),
    };
  } catch (error) {
    const e = error as {
      status?: number;
      code?: IntakeErrorCode;
      values?: Record<string, string | number>;
    };
    if (e.status === 422) {
      throw new IntakeError((error as Error).message, 422, e.code ?? "invalid", e.values ?? {});
    }
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
    throw new IntakeError("count must be between 1 and 20", 422, "rows_range", { min: 1, max: 20 });
  }
  const applicable = await applicableQuestions(profileId);
  const question = applicable.find((q) => q.id === questionId);
  if (!question) {
    throw new IntakeError(`question ${questionId} is not applicable`, 409, "not_askable");
  }
  const spec = question.input as InputSpec;
  if (spec.type !== "entity_list" || !spec.entity_schema) {
    throw new IntakeError("not an entity question", 422, "not_entity");
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
    if (!table) {
      throw new IntakeError(`unknown entity schema ${spec.entity_schema}`, 422, "not_entity");
    }
    const base = { profile_id: profileId } as Record<string, unknown>;
    if (spec.entity_schema === "cost_item") {
      base.bucket = costBucketFor(question.writes_to);
      base.scales_with_sales = base.bucket === "variable";
    }
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
    prompt: englishOf(question.prompt),
    display: `${count} recorded — details next session`,
    provenance: `${question.id} · owner · stated`,
    dot: "solid",
  };
  return { chip, state: await getIntakeState(accountId, profileId) };
}
