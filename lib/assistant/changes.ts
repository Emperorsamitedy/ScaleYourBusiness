// Prepare, and confirm — feature 33, "the assistant acts".
//
// One owner message maps to ONE catalogue row (lib/assistant/intent.ts).
// This module turns that into one of three things, stored as an
// assistant_changes row beside the reply that carries it:
//
//   asked      the request is ambiguous or incomplete ("Which day?");
//              nothing is drafted, the owner's next message answers it
//   prepared   the exact change, drafted: the current value read and
//              quoted, the new one validated by the same code the screen
//              uses. NOTHING is written until the owner clicks.
//   link_only  the change needs the owner's own hands (a login, the
//              explicit settings path) — the deep link and what is set now
//
// confirmChange() is the click. It claims the row once (a double click
// changes nothing), refuses if what the change was drafted against has
// moved since (stale — the owner sees the new value, nothing is
// overwritten unseen), then writes through the existing path:
//
//   a fact / hours / size / a rule / a goal → the supersession store,
//     source "conversation" naming the owner's message, 0.70 (confirmed,
//     conversation-channel §2.3); writeField logs profile_change (rule 7)
//   reply time / ticket emails → the support settings service
//   the stop → haltExecutions, the same call the stop button makes
//   a knowledge answer / a calendar item → a PROPOSAL in the queue,
//     never an action (rule 12); hard limits checked as for every source
//
// Every confirmed change also lands in the decision log as
// "assistant_change", hashing what was confirmed and what it wrote.
//
// Dispatch is a table keyed by catalogue kind — no if-chain on kinds.

import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  accounts,
  assistantChanges,
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  utterances,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import type { Field } from "../core/field";
import { fieldId, utteranceId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { isIsoCurrency, readAmount } from "../core/money";
import type { SizeBand } from "../core/size-features";
import { addGoal, listGoals, setGoalAttr } from "../content/goals";
import { contentQueue } from "../content/produce";
import { proposeCustomKnowledge, listKnowledge } from "../crm/knowledge";
import { setNotifyOwner, setReplyHours } from "../crm/support-settings";
import { haltExecutions, haltState } from "../execution/engine";
import type { OpenPeriod, OpeningSchedule, ScheduleLlm, Weekday } from "../hours/schedule";
import {
  HOURS_KEY,
  SCHEDULE_KEY,
  SCHEDULE_SYSTEM,
  WEEKDAYS,
  coerceSchedule,
  liveScheduleLlm,
} from "../hours/schedule";
import type { InputSpec } from "../interviewer/harness/answers";
import { latestDecision } from "../mode/service";
import { coerceParsedValue } from "../parser/coerce";
import { isDynamicVocabulary } from "../profile/dynamic-vocab";
import type { FieldRecordRow } from "../profile/field-codec";
import { rowToField } from "../profile/field-codec";
import { buildFactSheet, repr } from "../profile/factsheet";
import { readCurrentField, writeField } from "../profile/field-store";
import { SIZE_BAND_KEY, TEAM_SIZE_KEY, resolveSizeBand } from "../profile/size-band";
import type { LimitLlm } from "../proposals/hard-limits";
import { BOUNDARIES_KEY } from "../proposals/hard-limits";
import { applicableQuestions } from "../resolver/applicability";
import { overlapScore, tokenize } from "../support/knowledge";
import { settingsForProfile } from "../support/settings";
import { vocabularyCodes } from "../vocab/validate";
import type { CatalogueEntry } from "./catalogue";
import { deepLink, entryFor, entryOwningField } from "./catalogue";
import type { ChangeParams, DetectedChange } from "./intent";
import { parseBand, parseDays, parseTimeRange } from "./intent";
import type { ChangeKind } from "./kinds";
import { proposeFromChat } from "./proposal";

export class ChangeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ChangeError";
    this.status = status;
  }
}

export type AssistantChangeRow = typeof assistantChanges.$inferSelect;

/** Conversation, confirmed by the owner — conversation-channel §2.3. */
export const CONFIRMED_CONVERSATION = 0.7;

export interface ChangeSeams {
  scheduleLlm?: ScheduleLlm;
  limitLlm?: LimitLlm;
}

interface Ctx {
  profileId: string;
  accountId: string;
  /** The signed-in user confirming, when there is one — the stop records who. */
  userId?: string | null;
  ownerUtteranceId: string;
  ownerText: string;
  seams: ChangeSeams;
}

export type Prepared =
  | { status: "asked"; reply: string; summary: string; link: string }
  | {
      status: "link_only";
      reply: string;
      summary: string;
      current: string | null;
      link: string;
    }
  | {
      status: "prepared";
      reply: string;
      summary: string;
      current: string | null;
      proposed: string;
      link: string;
      payload: Record<string, unknown>;
      basis: string | null;
    };

interface Applied {
  status: "applied" | "queued";
  result_text: string;
  result_ref: string;
}

interface Handler {
  prepare(ctx: Ctx, change: DetectedChange, entry: CatalogueEntry): Promise<Prepared>;
  /** What the row was drafted against, read again now, and its words. */
  basisNow?(ctx: Ctx, row: AssistantChangeRow): Promise<{ basis: string | null; now: string }>;
  apply?(ctx: Ctx, row: AssistantChangeRow): Promise<Applied>;
}

/* ── shared reading and writing ── */

const DAY_NAME: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const DAY_SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

const quote = (s: string) => `“${s}”`;

/** The current record of a field and its storage id — the basis a change is drafted against. */
async function currentRecord(
  profileId: string,
  key: string,
): Promise<{ id: string; field: Field<unknown> } | null> {
  const [row] = await db
    .select()
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        eq(fieldRecords.field_key, key),
        isNull(fieldRecords.superseded_at),
      ),
    );
  return row ? { id: row.id, field: rowToField<unknown>(row as unknown as FieldRecordRow) } : null;
}

/** The one fact write: superseding, conversation-sourced, naming the owner's message. */
async function writeConversationFact(ctx: Ctx, key: string, value: unknown): Promise<string> {
  const at = isoDateTime(new Date().toISOString());
  const recordId = await writeField(
    ctx.profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(CONFIRMED_CONVERSATION),
      source: { kind: "conversation", utterance_id: utteranceId(ctx.ownerUtteranceId) },
      observed_at: at,
      recorded_at: at,
      note: "confirmed in chat",
    }),
  );
  // The owner's message now wrote something: say so on it (§2.2).
  await db
    .update(utterances)
    .set({
      confirmed: true,
      extracted_fields: sql`${utterances.extracted_fields} || ${JSON.stringify([key])}::jsonb`,
    })
    .where(eq(utterances.id, ctx.ownerUtteranceId));
  return recordId;
}

function factBasis(rec: { id: string } | null): string {
  return rec ? rec.id : "none";
}

function factNow(rec: { field: Field<unknown> } | null): string {
  if (!rec) return "not in your profile";
  if (rec.field.status === "unknown") return "not known";
  if (rec.field.status === "skipped") return "skipped";
  return repr(rec.field.value) ?? "not in your profile";
}

const asked = (entry: CatalogueEntry, question: string, slot?: string | null): Prepared => ({
  status: "asked",
  reply: question,
  summary: question,
  link: deepLink(entry, slot),
});

const linkOnly = (
  entry: CatalogueEntry,
  lead: string,
  current: string | null,
  slot?: string | null,
): Prepared => ({
  status: "link_only",
  reply: `${lead} ${entry.note}`.trim(),
  summary: lead,
  current,
  link: deepLink(entry, slot),
});

const already = (entry: CatalogueEntry, lead: string, current: string, slot?: string | null) =>
  linkOnly(entry, `${lead} — so there's nothing to change.`, current, slot);

function prepared(
  entry: CatalogueEntry,
  args: {
    nowLine: string;
    summary: string;
    current: string | null;
    proposed: string;
    payload: Record<string, unknown>;
    basis: string | null;
    slot?: string | null;
    extra?: string;
  },
): Prepared {
  const how =
    entry.prepare === "proposal"
      ? `I've drafted it below: “${entry.confirm}” sends it to your approval queue, and nothing happens until you approve it there.`
      : `I've drafted the change below — nothing changes until you press “${entry.confirm}”.`;
  return {
    status: "prepared",
    reply: [
      args.nowLine,
      args.extra,
      how,
      `Or open the ${entry.screen} page and change it yourself.`,
    ]
      .filter((s): s is string => typeof s === "string" && s !== "")
      .join(" "),
    summary: args.summary,
    current: args.current,
    proposed: args.proposed,
    link: deepLink(entry, args.slot),
    payload: args.payload,
    basis: args.basis,
  };
}

/* ── opening hours ── */

function periodsWords(periods: readonly OpenPeriod[] | null | undefined): string {
  if (periods === null || periods === undefined) return "not stated";
  if (periods.length === 0) return "closed";
  return periods.map((p) => `${p.open}–${p.close}`).join(", ");
}

/** A schedule back into the words the hours answer is written in — deterministic, readable on the door. */
export function scheduleText(schedule: OpeningSchedule): string {
  const parts = WEEKDAYS.filter((d) => !schedule.unstated.includes(d)).map(
    (d) => `${DAY_SHORT[d]} ${periodsWords(schedule.days[d])}`,
  );
  return [...parts, ...schedule.unparsed].join("; ");
}

/**
 * The schedule as the hours screen reads it — but READ-ONLY: drafting a
 * change writes nothing (rule 12's spirit), so where the parse-once cache
 * is stale the owner's answer is parsed in memory and not stored. The
 * cost is one Haiku call, logged like every other.
 */
async function readSchedule(ctx: Ctx): Promise<OpeningSchedule | null> {
  const hours = await readCurrentField<string>(ctx.profileId, HOURS_KEY);
  if (!hours || hours.status !== "answered" || typeof hours.value !== "string") return null;
  const cached = await readCurrentField<OpeningSchedule>(ctx.profileId, SCHEDULE_KEY);
  if (cached && cached.status === "inferred" && cached.recorded_at >= hours.recorded_at) {
    return cached.value;
  }
  try {
    const llm = ctx.seams.scheduleLlm ?? liveScheduleLlm;
    const { text } = await llm({
      system: SCHEDULE_SYSTEM,
      user: hours.value,
      accountId: ctx.accountId,
    });
    return coerceSchedule(text);
  } catch {
    return null;
  }
}

const hoursHandler: Handler = {
  async prepare(ctx, change, entry) {
    const days = change.params.days ?? [];
    if (days.length === 0) return asked(entry, "Which day?");
    if (days.length > 1) {
      return asked(
        entry,
        `One day at a time, so nothing changes that you didn't mean — which first: ${days
          .map((d) => DAY_NAME[d])
          .join(" or ")}?`,
      );
    }
    const day = days[0] as Weekday;
    const { open, close, closed } = change.params;
    if (!closed && (!open || !close)) {
      return asked(entry, `What hours on ${DAY_NAME[day]}? For example 10:00–16:00, or closed.`);
    }
    const schedule = await readSchedule(ctx);
    const known = schedule !== null && !schedule.unstated.includes(day);
    const before = known ? schedule.days[day] : null;
    const after: OpenPeriod[] = closed ? [] : [{ open: open as string, close: close as string }];
    const currentWords = periodsWords(before);
    const proposed = periodsWords(after);
    const nowLine =
      schedule === null
        ? "There are no opening hours in your profile yet."
        : `Your ${DAY_NAME[day]} hours are ${known ? currentWords : "not stated"} now.`;
    if (known && currentWords === proposed) {
      return already(entry, `${DAY_NAME[day]} is already ${currentWords}`, currentWords);
    }
    const base: OpeningSchedule = schedule ?? {
      days: Object.fromEntries(WEEKDAYS.map((d) => [d, []])) as unknown as Record<
        Weekday,
        OpenPeriod[]
      >,
      unstated: [...WEEKDAYS],
      unparsed: [],
    };
    const next: OpeningSchedule = {
      days: { ...base.days, [day]: after },
      unstated: base.unstated.filter((d) => d !== day),
      unparsed: base.unparsed,
    };
    const text = scheduleText(next);
    const rec = await currentRecord(ctx.profileId, HOURS_KEY);
    return prepared(entry, {
      nowLine,
      extra: `Your hours answer will then read ${quote(text)}.`,
      summary: closed
        ? `Mark ${DAY_NAME[day]} as closed`
        : `Set your ${DAY_NAME[day]} opening hours to ${proposed}`,
      current: schedule === null ? "no hours stated" : known ? currentWords : "not stated",
      proposed,
      payload: { key: HOURS_KEY, value: text, day },
      basis: factBasis(rec),
    });
  },
  basisNow: factBasisNow,
  apply: applyFact("Changed. Your hours answer is updated; the old one stays in its history."),
};

async function factBasisNow(ctx: Ctx, row: AssistantChangeRow) {
  const key = String(row.payload.key ?? "");
  const rec = await currentRecord(ctx.profileId, key);
  return { basis: factBasis(rec), now: factNow(rec) };
}

function applyFact(words: string) {
  return async (ctx: Ctx, row: AssistantChangeRow): Promise<Applied> => {
    const key = String(row.payload.key ?? "");
    if (key === "") throw new ChangeError("the drafted change names no fact", 500);
    const recordId = await writeConversationFact(ctx, key, row.payload.value);
    return { status: "applied", result_text: words, result_ref: `field_record:${recordId}` };
  };
}

/* ── any single-value fact (and size, which is one) ── */

const isEqualValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function keyLabel(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/_/g, " ");
}

function optionLabel(spec: InputSpec, code: string): string {
  return spec.option_labels?.[code]?.en ?? code.replace(/_/g, " ");
}

const CURRENCY_WORDS: readonly [RegExp, string][] = [
  [/€|\beuros?\b/i, "EUR"],
  [/\$|\bdollars?\b/i, "USD"],
  [/£|\bpounds?\b/i, "GBP"],
  [/\bforints?\b|\bft\b/i, "HUF"],
];

/** A question back to the owner instead of a value: the words can be read two ways. */
export interface AskBack {
  ask: string;
}

export function isAskBack(v: unknown): v is AskBack {
  return typeof v === "object" && v !== null && typeof (v as { ask?: unknown }).ask === "string";
}

/** The first amount in the owner's words, as they wrote it ("1 500", "12,50", "1.234,56"). */
function amountToken(text: string): string | null {
  const m = /-?\d{1,3}(?:[   ]\d{3})+(?:[.,]\d+)?|-?\d[\d.,]*/.exec(text);
  return m ? m[0].replace(/[.,]+$/, "") : null;
}

/**
 * The owner's amount, read by the one exact reader (lib/core/money.ts): a
 * canonical decimal string ("1234.5"), or a question back when "1.500"
 * could be fifteen hundred or one and a half (review 2026-10-23, #4).
 */
function readOwnerAmount(text: string): string | AskBack | null {
  const token = amountToken(text);
  if (token === null) return null;
  const read = readAmount(token, null);
  if (!read.ok) {
    if (read.reason !== "ambiguous") return null;
    const [lead = "", tail = ""] = token.replace(/^-/, "").split(/[.,]/);
    const thousands = `${lead}${tail}`;
    const fraction = tail.replace(/0+$/, "");
    const decimal = fraction === "" ? lead : `${lead}.${fraction}`;
    return {
      ask: `Did you mean ${thousands} or ${decimal}? Write it as ${thousands} or ${decimal} and I'll take it exactly.`,
    };
  }
  return `${read.negative ? "-" : ""}${read.whole}${read.fraction === "" ? "" : `.${read.fraction}`}`;
}

/** The first ISO 4217 code the owner wrote ("incl VAT 27 EUR" is EUR, never "VAT"). */
function isoCodeIn(text: string): string | undefined {
  for (const m of text.matchAll(/\b([A-Z]{3})\b/g)) {
    if (m[1] !== undefined && isIsoCurrency(m[1])) return m[1];
  }
  return undefined;
}

/**
 * The owner's words → the parser's neutral wire value for this input type,
 * null when there is none, or an AskBack when the words read two ways.
 */
export function wireFor(
  spec: InputSpec,
  raw: string,
  codes: readonly string[],
  currentCurrency: string | null,
): unknown {
  const text = raw.trim();
  switch (spec.type) {
    case "text":
    case "long_text":
      return text.replace(/^["“']|["”']$/g, "");
    case "number": {
      const amount = readOwnerAmount(text);
      return typeof amount === "string" ? Number(amount) : amount;
    }
    case "money": {
      const amount = readOwnerAmount(text);
      if (amount === null || isAskBack(amount)) return amount;
      const code =
        isoCodeIn(text) ??
        CURRENCY_WORDS.find(([re]) => re.test(text))?.[1] ??
        currentCurrency ??
        undefined;
      return { amount_major: amount, ...(code ? { currency: code } : {}) };
    }
    case "boolean":
      if (/^(yes|yep|true|we do|it is|on)\b/i.test(text)) return true;
      if (/^(no|nope|false|we don'?t|it isn'?t|off)\b/i.test(text)) return false;
      return null;
    case "date":
      return /\d{4}-\d{2}-\d{2}/.exec(text)?.[0] ?? null;
    case "single_select": {
      const t = text.toLowerCase().replace(/^(a|an|the)\s+/, "");
      const exact = codes.find(
        (c) => c === t || optionLabel(spec, c).toLowerCase() === t || c.replace(/_/g, " ") === t,
      );
      if (exact) return exact;
      const contained = codes.filter(
        (c) => t.includes(optionLabel(spec, c).toLowerCase()) || t.includes(c.replace(/_/g, " ")),
      );
      return contained.length === 1 ? contained[0] : null;
    }
    default:
      return null;
  }
}

/** A bank question that asks a percent: a number bounded by 100 (0–100, or −100–100 for a change). */
export function isPercentSpec(spec: InputSpec): boolean {
  return spec.type === "number" && spec.max === 100 && (spec.min === 0 || spec.min === -100);
}

const TYPE_WORD: Partial<Record<InputSpec["type"], string>> = {
  number: "a number",
  money: "an amount",
  boolean: "a yes or a no",
  date: "a date like 2026-11-01",
  single_select: "one of the listed options",
};

async function prepareFact(
  ctx: Ctx,
  entry: CatalogueEntry,
  key: string,
  rawValue: string | undefined,
): Promise<Prepared> {
  const slot = key;
  const label = keyLabel(key);
  const question = (await applicableQuestions(ctx.profileId)).find((q) => q.writes_to === key);
  const rec = await currentRecord(ctx.profileId, key);
  const now = factNow(rec);
  if (!question) {
    return linkOnly(
      entry,
      `Your ${label} is ${now}. That one isn't an answer I can change from chat — the page shows where it comes from.`,
      now,
      slot,
    );
  }
  const spec = question.input as InputSpec;
  const vocab = spec.vocabulary_id ?? null;
  if (
    !["text", "long_text", "number", "money", "boolean", "date", "single_select"].includes(
      spec.type,
    ) ||
    (vocab !== null && isDynamicVocabulary(vocab))
  ) {
    return linkOnly(
      entry,
      `Your ${label} is ${now}. It's a list, not one value, so it's changed on the page where you can see every entry.`,
      now,
      slot,
    );
  }
  if (rec && rec.field.source.kind === "connector") {
    return linkOnly(
      entry,
      `Your ${label} is ${now}, measured from your connection. I don't overwrite a measurement from chat — the page shows it beside what you told me.`,
      now,
      slot,
    );
  }
  if (rec && rec.field.status === "inferred") {
    return linkOnly(
      entry,
      `Your ${label} is ${now}, which I worked out from other answers. Change those, and it follows.`,
      now,
      slot,
    );
  }
  if (rawValue === undefined || rawValue.trim() === "") {
    return asked(entry, `Your ${label} is ${now} now. What should it be?`, slot);
  }
  const codes = vocab !== null ? await vocabularyCodes(vocab) : [];
  const currentCurrency =
    rec && typeof rec.field.value === "object" && rec.field.value !== null
      ? (((rec.field.value as { currency?: unknown }).currency as string | undefined) ?? null)
      : null;
  const wire = wireFor(spec, rawValue, codes, currentCurrency);
  if (isAskBack(wire)) return asked(entry, wire.ask, slot);
  // A share asked as a percent, answered as a fraction: "0.35" is 35 %, or a
  // typo for 0.35 % — ask, never store 0.35 points (review 2026-10-23, #13).
  if (
    typeof wire === "number" &&
    isPercentSpec(spec) &&
    wire !== 0 &&
    Math.abs(wire) <= 1 &&
    !/%/.test(rawValue)
  ) {
    const pct = Math.round(wire * 100 * 1000) / 1000;
    return asked(
      entry,
      `Did you mean ${pct} %? I keep your ${label} as the number of percent — ${pct} for ${pct} %. Say ${pct} %, or ${wire} % if it really is that small.`,
      slot,
    );
  }
  const [account] = await db
    .select({ currency: accounts.reporting_currency })
    .from(accounts)
    .innerJoin(businessProfiles, eq(businessProfiles.account_id, accounts.id))
    .where(eq(businessProfiles.id, ctx.profileId));
  const coerced =
    wire === null
      ? ({ ok: false, reason: "" } as const)
      : coerceParsedValue(spec, wire, codes, account?.currency ?? "EUR");
  if (!coerced.ok) {
    const want =
      spec.type === "single_select"
        ? `one of: ${codes.map((c) => optionLabel(spec, c)).join(", ")}`
        : spec.type === "number" && (spec.min !== undefined || spec.max !== undefined)
          ? `a number${spec.min !== undefined ? ` from ${spec.min}` : ""}${spec.max !== undefined ? ` ${spec.min !== undefined ? "to" : "up to"} ${spec.max}` : ""}`
          : (TYPE_WORD[spec.type] ?? "a value");
    return asked(entry, `I need ${want} for your ${label} — what should it be?`, slot);
  }
  const value = coerced.value;
  const proposed =
    spec.type === "single_select"
      ? optionLabel(spec, (value as { code: string }).code)
      : (repr(value) ?? String(value));
  const current =
    rec && spec.type === "single_select" && typeof rec.field.value === "object" && rec.field.value
      ? optionLabel(spec, String((rec.field.value as { code?: unknown }).code ?? now))
      : now;
  if (rec && rec.field.status === "answered" && isEqualValue(rec.field.value, value)) {
    return already(entry, `Your ${label} is already ${current}`, current, slot);
  }
  return prepared(entry, {
    nowLine: `Your ${label} is ${current} now.`,
    summary: `Set your ${label} to ${proposed}`,
    current,
    proposed,
    payload: { key, value, question_id: question.id },
    basis: factBasis(rec),
    slot,
  });
}

/** Score the profile's facts against the owner's name for one; the best unique match wins. */
async function matchFact(
  profileId: string,
  subject: string,
): Promise<{ key: string } | { ambiguous: string[] } | null> {
  const sheet = await buildFactSheet(profileId);
  const asked = new Set(tokenize(subject));
  if (asked.size === 0) return null;
  const scored = sheet.sections
    .flatMap((s) => s.facts)
    .map((f) => {
      const words = new Set(tokenize(f.key.replace(/[._]/g, " ")));
      let score = 0;
      for (const w of asked) if (words.has(w) || words.has(w.replace(/s$/, ""))) score += 1;
      return { key: f.key, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  const top = scored[0] as { key: string; score: number };
  const tied = scored.filter((s) => s.score === top.score);
  return tied.length === 1 ? { key: top.key } : { ambiguous: tied.slice(0, 3).map((t) => t.key) };
}

const factHandler: Handler = {
  async prepare(ctx, change, entry) {
    const subject = change.params.subject;
    if (!subject) {
      return asked(
        entry,
        "Which fact do you mean? Name it as the fact sheet does — for example “average order value”.",
      );
    }
    const match = await matchFact(ctx.profileId, subject);
    if (match === null) {
      return linkOnly(
        entry,
        `I couldn't find ${quote(subject)} among the facts I hold. The fact sheet lists every one.`,
        null,
      );
    }
    if ("ambiguous" in match) {
      return asked(
        entry,
        `Which one — ${match.ambiguous.map((k) => quote(keyLabel(k))).join(" or ")}?`,
      );
    }
    // A fact another row owns is changed by that row's rules (the hours by the day).
    const owner = entryOwningField(match.key);
    if (owner) {
      const value = change.params.value ?? "";
      const band = parseBand(value);
      const params: ChangeParams = {
        days: parseDays(value),
        ...(parseTimeRange(value) ?? {}),
        ...(band ? { band } : {}),
        value,
      };
      return HANDLERS[owner.kind].prepare(ctx, { ...change, kind: owner.kind, params }, owner);
    }
    return prepareFact(ctx, entry, match.key, change.params.value);
  },
  basisNow: factBasisNow,
  apply: applyFact("Changed. The old value stays in its history, with your message as the source."),
};

const BAND_WORDS: Record<SizeBand, string> = {
  solo: "just you",
  small: "a small team",
  medium: "a medium-sized business",
  large: "a larger business",
};

const sizeHandler: Handler = {
  async prepare(ctx, change, entry) {
    const band = change.params.band;
    const [stated, team] = await Promise.all([
      currentRecord(ctx.profileId, SIZE_BAND_KEY),
      currentRecord(ctx.profileId, TEAM_SIZE_KEY),
    ]);
    const resolved = resolveSizeBand(stated?.field ?? null, team?.field ?? null);
    const nowWords = resolved
      ? `${BAND_WORDS[resolved.band]}${resolved.via === "inferred" ? " (worked out from your headcount)" : ""}`
      : "not stated";
    if (!band) {
      return asked(
        entry,
        `Your size is ${nowWords} now. Which describes it: just you, a small team, medium-sized or larger?`,
      );
    }
    if (resolved?.via === "stated" && resolved.band === band) {
      return already(entry, `Your size is already ${BAND_WORDS[band]}`, BAND_WORDS[band]);
    }
    const prep = await prepareFact(ctx, entry, SIZE_BAND_KEY, band);
    if (prep.status !== "prepared") return prep;
    return {
      ...prep,
      summary: `Set the size of your business to ${BAND_WORDS[band]}`,
      current: nowWords,
      proposed: BAND_WORDS[band],
      reply: prep.reply.replace(/^Your [^.]+ now\./, `Your size is ${nowWords} now.`),
    };
  },
  basisNow: factBasisNow,
  apply: applyFact("Changed. The menu shows what fits that size from your next page."),
};

/* ── standing rules ── */

const ruleHandler: Handler = {
  async prepare(ctx, change, entry) {
    const rule = (change.params.value ?? "").trim();
    if (rule === "") return asked(entry, "What should the rule say, in your words?");
    const rec = await currentRecord(ctx.profileId, BOUNDARIES_KEY);
    const existing =
      rec && rec.field.status === "answered" && typeof rec.field.value === "string"
        ? rec.field.value
        : "";
    if (existing.toLowerCase().includes(rule.toLowerCase())) {
      return already(entry, `That's already one of your rules`, existing);
    }
    return prepared(entry, {
      nowLine:
        existing === ""
          ? "You have no standing rules yet."
          : `Your standing rules now read ${quote(existing.replace(/\n/g, " · "))}.`,
      extra: "Once added, a rule can't be removed from chat — limits exist to survive a bad day.",
      summary: `Add the standing rule ${quote(rule)}`,
      current: existing === "" ? "no standing rules" : existing.replace(/\n/g, " · "),
      proposed: rule,
      payload: { key: BOUNDARIES_KEY, value: existing === "" ? rule : `${existing}\n${rule}` },
      basis: factBasis(rec),
    });
  },
  basisNow: factBasisNow,
  apply: applyFact(
    "Added. I'll hold every future proposal against it; anything it blocks shows in the queue's held-back section.",
  ),
};

const ruleRemoveHandler: Handler = {
  async prepare(ctx, _change, entry) {
    const rec = await currentRecord(ctx.profileId, BOUNDARIES_KEY);
    const existing =
      rec && rec.field.status === "answered" && typeof rec.field.value === "string"
        ? rec.field.value.replace(/\n/g, " · ")
        : null;
    return linkOnly(
      entry,
      existing ? `Your standing rules read ${quote(existing)}.` : "You have no standing rules.",
      existing,
    );
  },
};

/* ── goals ── */

const goalHandler: Handler = {
  async prepare(ctx, change, entry) {
    const goals = (await listGoals(ctx.profileId)).filter((g) => g.statement !== null);
    const value = change.params.value?.trim();
    const wantsNew = /\b(add|another)\b[^.?!]{0,20}\b(goal|target)\b|\bnew (goal|target)\b/i.test(
      ctx.ownerText,
    );
    if (goals.length === 0 || wantsNew) {
      if (!value) return asked(entry, "What's the goal, in your words?");
      return prepared(entry, {
        nowLine:
          goals.length === 0
            ? "You have no goals yet."
            : `You have ${goals.length} goal${goals.length === 1 ? "" : "s"} now.`,
        summary: `Add the goal ${quote(value)}`,
        current: goals.length === 0 ? "no goals" : null,
        proposed: value,
        payload: { op: "add", statement: value },
        basis: `goals:${goals.length}`,
      });
    }
    let goal = goals.length === 1 ? goals[0] : undefined;
    if (change.params.subject) {
      const scored = goals
        .map((g) => ({
          g,
          score: overlapScore(change.params.subject as string, {
            question: g.statement ?? "",
            answer: g.target_value ?? "",
          }),
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored[0] && (scored.length === 1 || (scored[1] && scored[1].score < scored[0].score))) {
        goal = scored[0].g;
      }
    }
    if (!goal) {
      return asked(
        entry,
        `Which goal — ${goals
          .slice(0, 3)
          .map((g) => quote(g.statement ?? ""))
          .join(" or ")}?`,
      );
    }
    const attr = /\btarget\b/i.test(ctx.ownerText) ? "target_value" : "statement";
    const now = (attr === "target_value" ? goal.target_value : goal.statement) ?? "not set";
    if (!value) {
      return asked(
        entry,
        `That goal's ${attr === "target_value" ? "target" : "wording"} is ${quote(now)} now. What should it be?`,
        goal.goal_id,
      );
    }
    if (now === value)
      return already(entry, `That goal already says ${quote(now)}`, now, goal.goal_id);
    const rec = await currentRecord(ctx.profileId, `goals.${goal.goal_id}.${attr}`);
    return prepared(entry, {
      nowLine: `That goal's ${attr === "target_value" ? "target" : "wording"} is ${quote(now)} now.`,
      summary:
        attr === "target_value"
          ? `Set the target of ${quote(goal.statement ?? "")} to ${value}`
          : `Reword the goal to ${quote(value)}`,
      current: now,
      proposed: value,
      payload: {
        op: "update",
        goal_id: goal.goal_id,
        attr,
        value,
        key: `goals.${goal.goal_id}.${attr}`,
      },
      basis: factBasis(rec),
      slot: goal.goal_id,
    });
  },
  async basisNow(ctx, row) {
    if (row.payload.op === "add") {
      const goals = (await listGoals(ctx.profileId)).filter((g) => g.statement !== null);
      return { basis: `goals:${goals.length}`, now: `${goals.length} goals` };
    }
    return factBasisNow(ctx, row);
  },
  async apply(ctx, row) {
    const by = {
      source: { kind: "conversation" as const, utterance_id: utteranceId(ctx.ownerUtteranceId) },
      confidence: CONFIRMED_CONVERSATION,
    };
    if (row.payload.op === "add") {
      const goal = await addGoal(ctx.profileId, { statement: String(row.payload.statement) }, by);
      await markUtterance(ctx, `goals.${goal.goal_id}.statement`);
      return {
        status: "applied",
        result_text: "Added. It's on your Goals page; content and proposals will name it.",
        result_ref: `goal:${goal.goal_id}`,
      };
    }
    const attr = row.payload.attr === "target_value" ? "target_value" : "statement";
    const recordId = await setGoalAttr(
      ctx.profileId,
      String(row.payload.goal_id),
      attr,
      String(row.payload.value),
      by,
    );
    await markUtterance(ctx, `goals.${String(row.payload.goal_id)}.${attr}`);
    return {
      status: "applied",
      result_text: "Changed. The goal's earlier wording stays in its history.",
      result_ref: `field_record:${recordId}`,
    };
  },
};

async function markUtterance(ctx: Ctx, key: string): Promise<void> {
  await db
    .update(utterances)
    .set({
      confirmed: true,
      extracted_fields: sql`${utterances.extracted_fields} || ${JSON.stringify([key])}::jsonb`,
    })
    .where(eq(utterances.id, ctx.ownerUtteranceId));
}

/* ── support settings ── */

const hoursWords = (h: number | null) =>
  h === null
    ? "no reply time set"
    : h % 24 === 0 && h >= 24
      ? `${h / 24} day${h === 24 ? "" : "s"} (${h} hours)`
      : `${h} hour${h === 1 ? "" : "s"}`;

const replyTimeHandler: Handler = {
  async prepare(ctx, change, entry) {
    const settings = await settingsForProfile(ctx.profileId);
    const current = settings?.reply_hours ?? null;
    if (change.params.hours === undefined) {
      return asked(
        entry,
        `Your reply time is ${hoursWords(current)} now. How many hours should a customer wait at most?`,
      );
    }
    const hours = change.params.hours;
    if (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 720)) {
      return asked(entry, "A reply time is a whole number of hours, from 1 to 720 — how many?");
    }
    if (hours === current)
      return already(entry, `It's already ${hoursWords(current)}`, hoursWords(current));
    return prepared(entry, {
      nowLine: `Your reply time is ${hoursWords(current)} now.`,
      summary:
        hours === null ? "Remove your reply time" : `Set your reply time to ${hoursWords(hours)}`,
      current: hoursWords(current),
      proposed: hoursWords(hours),
      payload: { hours },
      basis: String(current ?? "none"),
    });
  },
  async basisNow(ctx) {
    const current = (await settingsForProfile(ctx.profileId))?.reply_hours ?? null;
    return { basis: String(current ?? "none"), now: hoursWords(current) };
  },
  async apply(ctx, row) {
    const hours = row.payload.hours === null ? null : Number(row.payload.hours);
    const settings = await setReplyHours(ctx.profileId, hours);
    return {
      status: "applied",
      result_text:
        hours === null
          ? "Removed. Support no longer marks tickets overdue."
          : `Changed. Support marks a ticket overdue after ${hoursWords(hours)}.`,
      result_ref: `support_settings:${settings.profile_id}`,
    };
  },
};

const notifyHandler: Handler = {
  async prepare(ctx, change, entry) {
    const settings = await settingsForProfile(ctx.profileId);
    const current = settings?.notify_owner ?? true;
    const words = (on: boolean) => (on ? "on — you're emailed" : "off — no email");
    if (change.params.on === undefined) {
      return asked(entry, `Ticket emails are ${words(current)} now. On or off?`);
    }
    const on = change.params.on;
    if (on === current) return already(entry, `They're already ${words(on)}`, words(on));
    return prepared(entry, {
      nowLine: `Ticket emails are ${words(current)} now.`,
      summary: on
        ? "Email me when a new support ticket arrives"
        : "Stop emailing me about new tickets",
      current: words(current),
      proposed: words(on),
      payload: { on },
      basis: String(current),
    });
  },
  async basisNow(ctx) {
    const current = (await settingsForProfile(ctx.profileId))?.notify_owner ?? true;
    return { basis: String(current), now: current ? "on" : "off" };
  },
  async apply(ctx, row) {
    const on = row.payload.on === true;
    const settings = await setNotifyOwner(ctx.profileId, on);
    return {
      status: "applied",
      result_text: on
        ? "Changed. A new email ticket also lands in your inbox."
        : "Changed. New tickets wait on the Support page; no email.",
      result_ref: `support_settings:${settings.profile_id}`,
    };
  },
};

/* ── the stop ── */

const stopHandler: Handler = {
  async prepare(ctx, _change, entry) {
    const state = await haltState(ctx.accountId);
    if (state.halted) {
      return already(
        entry,
        `Everything is already stopped, since ${(state.halted_at ?? "").slice(0, 10)}`,
        "stopped",
      );
    }
    return prepared(entry, {
      nowLine: "Everything is running now.",
      summary: "Stop everything I do for you — anything queued or scheduled is held",
      current: "running",
      proposed: "stopped",
      payload: {},
      basis: "running",
    });
  },
  async basisNow(ctx) {
    const state = await haltState(ctx.accountId);
    return {
      basis: state.halted ? "stopped" : "running",
      now: state.halted ? "stopped" : "running",
    };
  },
  async apply(ctx, row) {
    void row;
    await haltExecutions({
      accountId: ctx.accountId,
      userId: ctx.userId ?? null,
      reason: "stopped from chat",
    });
    return {
      status: "applied",
      result_text:
        "Stopped. Nothing I do runs until you start it again on the stop itself, signed in.",
      result_ref: `execution_halts:${ctx.accountId}`,
    };
  },
};

const resumeHandler: Handler = {
  async prepare(ctx, _change, entry) {
    const state = await haltState(ctx.accountId);
    return state.halted
      ? linkOnly(
          entry,
          `Everything is stopped, since ${(state.halted_at ?? "").slice(0, 10)}.`,
          "stopped",
        )
      : linkOnly(entry, "Nothing is stopped right now — everything is running.", "running");
  },
};

/* ── connections ── */

const PROVIDER_LABEL: Record<string, string> = {
  stripe: "Stripe",
  shopify: "Shopify",
  square: "Square",
  woocommerce: "WooCommerce",
  ga4: "Google Analytics",
  search_console: "Google Search Console",
  meta_ads: "Meta",
};

const connectionHandler: Handler = {
  async prepare(ctx, change, entry) {
    const provider = change.params.provider ?? null;
    const rows = await db
      .select({
        provider: connections.provider,
        status: connections.status,
        last_sync_at: connections.last_sync_at,
      })
      .from(connections)
      .where(and(eq(connections.account_id, ctx.accountId), isNull(connections.disconnected_at)));
    if (provider === null) {
      const live = rows.map((r) => PROVIDER_LABEL[r.provider] ?? r.provider);
      const now = live.length === 0 ? "nothing connected" : live.join(", ");
      return linkOnly(
        entry,
        live.length === 0 ? "Nothing is connected yet." : `Connected now: ${now}.`,
        now,
      );
    }
    const label = PROVIDER_LABEL[provider] ?? provider;
    const row = rows.find((r) => r.provider === provider);
    const now = row
      ? `${row.status}${row.last_sync_at ? `, last read ${row.last_sync_at.slice(0, 10)}` : ""}`
      : "not connected";
    return linkOnly(entry, `${label} is ${now}.`, now, provider);
  },
};

/* ── the two that become proposals ── */

async function watchingLink(ctx: Ctx, entry: CatalogueEntry): Promise<Prepared | null> {
  const decision = await latestDecision(ctx.profileId);
  if (decision?.mode !== "watching") return null;
  return linkOnly(
    entry,
    `I can't queue anything while I'm watching — the watch runs to ${decision.review_at.slice(0, 10)} and blocks every request, however it's phrased. The page shows what's there now.`,
    null,
  );
}

const knowledgeHandler: Handler = {
  async prepare(ctx, change, entry) {
    const watching = await watchingLink(ctx, entry);
    if (watching) return watching;
    const answer = change.params.value?.trim();
    const subject = change.params.subject?.trim();
    const entries = (await listKnowledge(ctx.profileId)).filter((e) => e.status === "public");
    const match = subject
      ? entries
          .map((e) => ({ e, score: overlapScore(subject, { question: e.question, answer: "" }) }))
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)[0]?.e
      : undefined;
    if (!subject && !answer) {
      return asked(entry, "Which customer question, and what should the assistant answer?");
    }
    if (!subject) return asked(entry, "Which customer question is that the answer to?");
    if (!answer) {
      return asked(
        entry,
        match
          ? `The assistant answers ${quote(match.question)} with ${quote(match.answer)} now. What should it say instead?`
          : `What should the assistant answer to ${quote(subject)}?`,
      );
    }
    const question = match?.question ?? subject;
    return prepared(entry, {
      nowLine: match
        ? `The assistant answers ${quote(match.question)} with ${quote(match.answer)} now.`
        : `The assistant has no answer for ${quote(subject)} yet.`,
      summary: match
        ? `Change the assistant's answer to ${quote(question)}`
        : `Add an answer for ${quote(question)}`,
      current: match ? match.answer : "no answer",
      proposed: answer,
      payload: { question, answer },
      basis: match ? `entry:${match.id}` : "entry:none",
    });
  },
  async basisNow(ctx, row) {
    const question = String(row.payload.question ?? "");
    const live = (await listKnowledge(ctx.profileId)).find(
      (e) => e.status === "public" && e.question === question,
    );
    return {
      basis: live ? `entry:${live.id}` : "entry:none",
      now: live ? live.answer : "no answer",
    };
  },
  async apply(ctx, row) {
    const proposal = await proposeCustomKnowledge(
      ctx.profileId,
      { question: String(row.payload.question), answer: String(row.payload.answer) },
      ctx.seams.limitLlm ? { limitLlm: ctx.seams.limitLlm } : {},
    );
    return {
      status: "queued",
      result_text:
        proposal.status === "blocked"
          ? "Held back: one of your standing rules forbids it. It's in the queue's held-back section so you can see why."
          : "It's in your approval queue. The assistant starts giving this answer once you approve it there.",
      result_ref: `proposal:${proposal.id}`,
    };
  },
};

const dayOf = (iso: string | null) =>
  iso ? (WEEKDAYS[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7] as Weekday) : null;

const contentHandler: Handler = {
  async prepare(ctx, change, entry) {
    const watching = await watchingLink(ctx, entry);
    if (watching) return watching;
    const items = (await contentQueue(ctx.profileId)).filter(
      (i) => i.status !== "published" && i.status !== "withdrawn",
    );
    if (items.length === 0) {
      return linkOnly(entry, "There's nothing on your content calendar yet.", "nothing scheduled");
    }
    const days = parseDays(`${change.params.subject ?? ""} ${ctx.ownerText}`);
    const subject = change.params.subject ?? "";
    let pool = items;
    if (days.length > 0) {
      const onDay = items.filter((i) => {
        const d = dayOf(i.scheduled_for);
        return d !== null && d === days[0];
      });
      if (onDay.length > 0) pool = onDay;
    }
    if (pool.length > 1 && subject !== "") {
      const scored = pool
        .map((i) => ({ i, score: overlapScore(subject, { question: i.title, answer: "" }) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored[0] && (scored.length === 1 || (scored[1]?.score ?? 0) < scored[0].score)) {
        pool = [scored[0].i];
      }
    }
    const describe = (i: (typeof items)[number]) =>
      `${quote(i.title)}${i.scheduled_for ? ` on ${i.scheduled_for}` : ""}`;
    if (pool.length > 1) {
      return asked(entry, `Which one — ${pool.slice(0, 3).map(describe).join(" or ")}?`);
    }
    const item = pool[0] as (typeof items)[number];
    const what = change.params.value ?? ctx.ownerText;
    return prepared(entry, {
      nowLine: `On your calendar now: ${describe(item)}.`,
      summary: `Change ${describe(item)}: ${what}`,
      current: describe(item),
      proposed: what,
      payload: { item_id: item.id, title: item.title, what },
      basis: `item:${item.id}:${item.status}:${item.scheduled_for ?? "unscheduled"}`,
    });
  },
  async basisNow(ctx, row) {
    const item = (await contentQueue(ctx.profileId)).find((i) => i.id === row.payload.item_id);
    return {
      basis: item
        ? `item:${item.id}:${item.status}:${item.scheduled_for ?? "unscheduled"}`
        : "gone",
      now: item
        ? `${quote(item.title)}${item.scheduled_for ? ` on ${item.scheduled_for}` : ""}`
        : "no longer on the calendar",
    };
  },
  async apply(ctx, row) {
    const { proposal } = await proposeFromChat({
      profileId: ctx.profileId,
      ownerUtteranceId: ctx.ownerUtteranceId,
      kind: "content_publishing",
      summary: row.summary,
      extra: { content_item_id: row.payload.item_id, requested_change: row.payload.what },
      ...(ctx.seams.limitLlm ? { limitLlm: ctx.seams.limitLlm } : {}),
    });
    return {
      status: "queued",
      result_text:
        proposal.status === "blocked"
          ? "Held back: one of your standing rules forbids it. It's in the queue's held-back section."
          : "It's in your approval queue. Nothing on the calendar changes until you approve it there.",
      result_ref: `proposal:${proposal.id}`,
    };
  },
};

/** The dispatch table: one handler per catalogue kind (rule 4 — data, not an if-chain). */
const HANDLERS: Record<ChangeKind, Handler> = {
  stop: stopHandler,
  resume: resumeHandler,
  reply_time: replyTimeHandler,
  support_notify: notifyHandler,
  opening_hours: hoursHandler,
  size_band: sizeHandler,
  standing_rule_remove: ruleRemoveHandler,
  standing_rule: ruleHandler,
  goal: goalHandler,
  knowledge_answer: knowledgeHandler,
  content_item: contentHandler,
  connection: connectionHandler,
  fact_value: factHandler,
};

/* ── the public half ── */

/** Draft one change — reads only. More than one change named is a question, never a chain. */
export async function prepareChange(
  args: { profileId: string; accountId: string; ownerUtteranceId: string; ownerText: string },
  change: DetectedChange,
  seams: ChangeSeams = {},
): Promise<Prepared> {
  const entry = entryFor(change.kind);
  if (change.count > 1) {
    return asked(
      entry,
      "That's more than one change. I make one at a time, so nothing changes that you didn't mean — which should I do first?",
    );
  }
  const ctx: Ctx = { ...args, seams };
  return HANDLERS[change.kind].prepare(ctx, change, entry);
}

/** Store the drafted change beside the reply that carries it. */
export async function recordPrepared(args: {
  profileId: string;
  ownerUtteranceId: string;
  replyUtteranceId: string;
  kind: ChangeKind;
  prepared: Prepared;
}): Promise<AssistantChangeRow> {
  const p = args.prepared;
  const [row] = await db
    .insert(assistantChanges)
    .values({
      profile_id: args.profileId,
      owner_utterance_id: args.ownerUtteranceId,
      reply_utterance_id: args.replyUtteranceId,
      kind: args.kind,
      status: p.status,
      summary: p.summary,
      current_text: p.status === "asked" ? null : p.current,
      proposed_text: p.status === "prepared" ? p.proposed : null,
      link: p.link,
      payload: p.status === "prepared" ? p.payload : {},
      basis: p.status === "prepared" ? p.basis : null,
    })
    .returning();
  return row as AssistantChangeRow;
}

/** The question the assistant last asked, if the owner's next message may be answering it. */
export async function openQuestion(
  profileId: string,
): Promise<{ row: AssistantChangeRow; ownerText: string } | null> {
  const [last] = await db
    .select()
    .from(utterances)
    .where(eq(utterances.thread_id, profileId))
    .orderBy(desc(utterances.at))
    .limit(1);
  if (!last || last.role !== "system") return null;
  const [row] = await db
    .select()
    .from(assistantChanges)
    .where(
      and(eq(assistantChanges.reply_utterance_id, last.id), eq(assistantChanges.status, "asked")),
    );
  if (!row) return null;
  const [owner] = await db
    .select({ text: utterances.text })
    .from(utterances)
    .where(eq(utterances.id, row.owner_utterance_id));
  return owner ? { row, ownerText: owner.text } : null;
}

export async function supersede(rowId: string): Promise<void> {
  await db
    .update(assistantChanges)
    .set({ status: "superseded", decided_at: new Date().toISOString() })
    .where(and(eq(assistantChanges.id, rowId), eq(assistantChanges.status, "asked")));
}

export async function listChanges(profileId: string): Promise<AssistantChangeRow[]> {
  return db
    .select()
    .from(assistantChanges)
    .where(eq(assistantChanges.profile_id, profileId))
    .orderBy(assistantChanges.created_at);
}

function hashConfirmed(row: AssistantChangeRow, ref: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profile_id: row.profile_id,
        change_id: row.id,
        kind: row.kind,
        summary: row.summary,
        payload: row.payload,
        result_ref: ref,
      }),
    )
    .digest("hex");
}

/**
 * The click. Idempotent (a second click returns the first click's row),
 * stale-safe (a moved basis writes nothing), and logged (rule 7).
 */
export async function confirmChange(args: {
  profileId: string;
  accountId: string;
  changeId: string;
  signedIn: boolean;
  userId?: string | null;
  seams?: ChangeSeams;
}): Promise<AssistantChangeRow> {
  const [row] = await db
    .select()
    .from(assistantChanges)
    .where(
      and(eq(assistantChanges.id, args.changeId), eq(assistantChanges.profile_id, args.profileId)),
    );
  if (!row) throw new ChangeError("no such change", 404);
  if (row.status !== "prepared") {
    if (row.status === "applied" || row.status === "queued" || row.status === "stale") return row;
    throw new ChangeError("there's nothing to confirm on that one", 409);
  }
  if (!isKind(row.kind)) throw new ChangeError("not a change I know", 409);
  const entry = entryFor(row.kind);
  if (entry.signed_in && !args.signedIn) {
    throw new ChangeError(
      `changing ${entry.thing} needs you signed in — the ${entry.screen} page asks the same`,
      401,
    );
  }
  const handler = HANDLERS[row.kind];
  const ctx: Ctx = {
    profileId: args.profileId,
    accountId: args.accountId,
    userId: args.userId ?? null,
    ownerUtteranceId: row.owner_utterance_id,
    ownerText: "",
    seams: args.seams ?? {},
  };

  // Claim it once: a double click finds it claimed and changes nothing.
  const [claimed] = await db
    .update(assistantChanges)
    .set({ decided_at: new Date().toISOString() })
    .where(
      and(
        eq(assistantChanges.id, row.id),
        eq(assistantChanges.status, "prepared"),
        isNull(assistantChanges.decided_at),
      ),
    )
    .returning();
  if (!claimed) {
    const [now] = await db.select().from(assistantChanges).where(eq(assistantChanges.id, row.id));
    return now as AssistantChangeRow;
  }

  try {
    if (handler.basisNow && row.basis !== null) {
      const live = await handler.basisNow(ctx, row);
      if (live.basis !== row.basis) {
        const [stale] = await db
          .update(assistantChanges)
          .set({
            status: "stale",
            result_text: `Not changed: it moved since I drafted this — it's ${live.now} now. Ask me again if you still want it.`,
          })
          .where(eq(assistantChanges.id, row.id))
          .returning();
        return stale as AssistantChangeRow;
      }
    }
    if (!handler.apply) throw new ChangeError("that one is changed on its own page", 409);
    const applied = await handler.apply(ctx, row);
    await db.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "assistant_change",
      ref_id: row.id,
      payload_hash: hashConfirmed(row, applied.result_ref),
    });
    const [done] = await db
      .update(assistantChanges)
      .set({
        status: applied.status,
        result_text: applied.result_text,
        result_ref: applied.result_ref,
      })
      .where(eq(assistantChanges.id, row.id))
      .returning();
    return done as AssistantChangeRow;
  } catch (error) {
    // Nothing landed: release the claim so the owner can try again.
    await db
      .update(assistantChanges)
      .set({ decided_at: null })
      .where(and(eq(assistantChanges.id, row.id), eq(assistantChanges.status, "prepared")));
    throw error;
  }
}

function isKind(v: string): v is ChangeKind {
  return Object.hasOwn(HANDLERS, v);
}

/** Every kind the dispatch table handles — the catalogue test holds it to the catalogue. */
export const HANDLED_KINDS: readonly string[] = Object.keys(HANDLERS);
