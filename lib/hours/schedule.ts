// Opening schedule — P2-26 (Phase 2 Session F, trading hours).
//
// The owner answers 2.1.1.7 in their own words ("Mon–Thu 8pm–1am,
// Fri–Sat 6pm–2am, Sun closed"). It is parsed ONCE — Haiku, the
// extraction workload, the hard-limits pattern (P3-03) — into a weekly
// schedule stored as the derived fact presence.opening_schedule, with
// derived_from and method on the source (rule 6). Re-parse happens only
// when the owner's answer changes.
//
// Code, not the model, decides what a valid period is. A day the model
// returns with an impossible time is not repaired: the owner's phrase for
// it goes to `unparsed`, which is shown, never dropped — the schedule
// says what it could not read rather than quietly narrowing it.
//
// A period whose close is at or before its open crosses midnight: 20:00
// to 01:00 is one evening that ends the next calendar day.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles } from "../../db/schema";
import type { Confidence } from "../core/confidence";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import { readCurrentField, writeField } from "../profile/field-store";

export const HOURS_KEY = "presence.opening_hours";
export const SCHEDULE_KEY = "presence.opening_schedule";
export const SCHEDULE_METHOD = "haiku-opening-hours-v1";
export const SCHEDULE_MODEL = "claude-haiku-4-5";
/** An interpretation of the owner's own words — the hard-limits level. */
export const SCHEDULE_CONFIDENCE: Confidence = confidence(0.7);

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface OpenPeriod {
  /** "HH:MM", 24-hour. */
  open: string;
  /** "HH:MM"; at or before `open` means it closes after midnight. */
  close: string;
}

export interface OpeningSchedule {
  /** Every weekday present; [] = closed that day. */
  days: Record<Weekday, OpenPeriod[]>;
  /** Days the answer did not mention — unknown, not closed. */
  unstated: Weekday[];
  /** The owner's phrases the parse could not turn into periods. */
  unparsed: string[];
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`not a time: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes the period is open; a close at or before the open runs past midnight. */
export function periodMinutes(p: OpenPeriod): number {
  const open = minutesOf(p.open);
  const close = minutesOf(p.close);
  return close > open ? close - open : close + 24 * 60 - open;
}

export type ScheduleLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

const SCHEDULE_SCHEMA = {
  type: "object" as const,
  properties: {
    days: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          day: { type: "string" as const, enum: [...WEEKDAYS] },
          closed: { type: "boolean" as const },
          periods: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                open: { type: "string" as const },
                close: { type: "string" as const },
              },
              required: ["open", "close"],
              additionalProperties: false,
            },
          },
          quote: { type: "string" as const },
        },
        required: ["day", "closed", "periods", "quote"],
        additionalProperties: false,
      },
    },
    unparsed: { type: "array" as const, items: { type: "string" as const } },
  },
  required: ["days", "unparsed"],
  additionalProperties: false,
};

export const SCHEDULE_SYSTEM = `You turn a small business owner's description of their opening hours into a weekly schedule.

For each weekday the answer covers, return:
- day: one of ${WEEKDAYS.join(", ")}
- closed: true only when the owner says that day is closed
- periods: the open intervals as 24-hour "HH:MM" times. "8pm" is "20:00", "midnight" is "00:00". A close time after midnight stays as written ("01:00") — do not add 24 hours. Two intervals on one day (lunch and dinner) are two periods.
- quote: the owner's own words that gave you this day, verbatim

Rules: expand ranges ("Mon–Thu" is four days). Never invent a day the answer does not cover — leave it out. Anything you cannot turn into days and times ("bank holidays vary", "later in summer"), put verbatim in unparsed. Return JSON only.`;

export const liveScheduleLlm: ScheduleLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: SCHEDULE_MODEL,
    max_tokens: 1_200,
    system,
    output_config: { format: { type: "json_schema", schema: SCHEDULE_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: "parser",
    account_id: accountId,
    model: SCHEDULE_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  await recordLlmCall(record);
  const block = response.content[0];
  const text = block && block.type === "text" ? block.text : "";
  return { text, calls: [record] };
};

/** Validate the model's JSON. Code decides what a period is; the rest is shown as unparsed. */
export function coerceSchedule(text: string): OpeningSchedule {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("schedule extraction returned non-JSON");
  }
  const body = parsed as { days?: unknown; unparsed?: unknown };
  if (!Array.isArray(body.days)) throw new Error("schedule extraction returned no days array");

  const days = Object.fromEntries(WEEKDAYS.map((d) => [d, [] as OpenPeriod[]])) as Record<
    Weekday,
    OpenPeriod[]
  >;
  const seen = new Set<Weekday>();
  const unparsed: string[] = Array.isArray(body.unparsed)
    ? body.unparsed.filter((u): u is string => typeof u === "string" && u.trim() !== "")
    : [];

  for (const entry of body.days) {
    const e = entry as { day?: unknown; closed?: unknown; periods?: unknown; quote?: unknown };
    if (typeof e.day !== "string" || !(WEEKDAYS as readonly string[]).includes(e.day)) continue;
    const day = e.day as Weekday;
    const quote = typeof e.quote === "string" ? e.quote.trim() : "";
    const periods = Array.isArray(e.periods) ? e.periods : [];
    if (e.closed === true && periods.length === 0) {
      seen.add(day);
      continue;
    }
    const valid: OpenPeriod[] = [];
    let broken = false;
    for (const p of periods) {
      const q = p as { open?: unknown; close?: unknown };
      if (
        typeof q.open === "string" &&
        typeof q.close === "string" &&
        HHMM.test(q.open) &&
        HHMM.test(q.close) &&
        q.open !== q.close
      ) {
        valid.push({ open: q.open, close: q.close });
      } else {
        broken = true;
      }
    }
    if (broken || valid.length === 0) {
      // Not repaired: the owner's words for this day are shown as unread.
      if (quote && !unparsed.includes(quote)) unparsed.push(quote);
      continue;
    }
    days[day] = [...days[day], ...valid].sort((a, b) => minutesOf(a.open) - minutesOf(b.open));
    seen.add(day);
  }

  return { days, unstated: WEEKDAYS.filter((d) => !seen.has(d)), unparsed };
}

async function accountIdOf(profileId: string): Promise<string> {
  const [row] = await db
    .select({ account_id: businessProfiles.account_id })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) throw new Error(`no such profile ${profileId}`);
  return row.account_id;
}

export interface ScheduleOutcome {
  schedule: OpeningSchedule | null;
  via: "reused" | "parsed" | "no_hours";
}

/**
 * The parse-once contract. Hours unanswered → no schedule and nothing
 * written (a gap is a finding). A schedule recorded after the current
 * answer → reused, no model call. Otherwise one Haiku extraction, written
 * as an inferred fact naming the answer and the method (rule 6).
 */
export async function ensureOpeningSchedule(
  profileId: string,
  llm: ScheduleLlm = liveScheduleLlm,
): Promise<ScheduleOutcome> {
  const hours = await readCurrentField<string>(profileId, HOURS_KEY);
  if (!hours || hours.status !== "answered" || typeof hours.value !== "string") {
    return { schedule: null, via: "no_hours" };
  }
  const existing = await readCurrentField<OpeningSchedule>(profileId, SCHEDULE_KEY);
  if (existing && existing.status === "inferred" && existing.recorded_at >= hours.recorded_at) {
    return { schedule: existing.value, via: "reused" };
  }

  const { text } = await llm({
    system: SCHEDULE_SYSTEM,
    user: hours.value,
    accountId: await accountIdOf(profileId),
  });
  const schedule = coerceSchedule(text);
  await writeField(
    profileId,
    createField<OpeningSchedule>({
      id: fieldId(SCHEDULE_KEY),
      value: schedule,
      status: "inferred",
      confidence: SCHEDULE_CONFIDENCE,
      source: { kind: "inferred", derived_from: [fieldId(HOURS_KEY)], method: SCHEDULE_METHOD },
      observed_at: hours.observed_at,
      recorded_at: isoDateTime(new Date().toISOString()),
      note: null,
    }),
  );
  return { schedule, via: "parsed" };
}
