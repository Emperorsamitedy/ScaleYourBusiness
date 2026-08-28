// Competitor research — P1-15..21 / build-sequence steps 38-39.
//
// The first time this product looks at the outside world. Four rules
// govern it, and they are the whole design:
//
//   1. READ SCOPE ONLY, forever. This module fetches and parses. It has
//      no capacity to post, submit, or authenticate anywhere (CLAUDE.md).
//   2. HARD CAPS on everything — pages, per-page timeout, characters fed
//      to the model, and a per-profile run budget. An unbounded crawl is
//      an unbounded bill.
//   3. NOTHING IS INVENTED. A field the page did not support is written
//      as `unknown`, never as a plausible guess. Research confidence is
//      0.5 (§8.1) and it can never overwrite something the owner said.
//   4. HONEST PROGRESS. Every progress event carries the real elapsed
//      milliseconds of work actually completed. There is no artificial
//      delay anywhere in this file, and there never may be.
//
// The search, fetch and extraction boundaries are injectable so every
// behaviour above is provable offline.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { competitors, fieldRecords } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { anthropicClient } from "../llm/client";
import type { LlmCallRecord } from "../llm/cost-log";
import { buildCallRecord, logLlmCall } from "../llm/cost-log";
import { writeField } from "../profile/field-store";

export const RESEARCH_MODEL = "claude-haiku-4-5";

/** §8.1 — a competitor's website is weaker evidence than the owner. */
export const RESEARCH_CONFIDENCE = 0.5;

/** Rule 2. Every one of these is a spend ceiling, not a preference. */
export const CAPS = {
  /** Search hits considered. */
  max_results: 5,
  /** Pages actually fetched and read. */
  max_pages: 3,
  /** Per page. A slow site is skipped, never waited on. */
  page_timeout_ms: 8_000,
  /** Characters of page text handed to the model, per page. */
  max_page_chars: 12_000,
  /** Research runs allowed per profile, ever. */
  max_runs_per_profile: 25,
} as const;

export class ResearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchError";
  }
}

/* ── the injectable outside world ── */

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}
export interface FetchedPage {
  url: string;
  title: string;
  /** Visible text, already stripped of markup by the fetcher. */
  text: string;
}

export type SearchProvider = (query: string, limit: number) => Promise<SearchHit[]>;
export type PageFetcher = (url: string, timeoutMs: number) => Promise<FetchedPage | null>;
export type ResearchLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string; calls: LlmCallRecord[] }>;

/* ── progress: real work, real timings (rule 4) ── */

export type ResearchStep = "search" | "fetch" | "read" | "write" | "done";

export interface ProgressEvent {
  step: ResearchStep;
  /** What was actually completed — never a prediction. */
  detail: string;
  /** Milliseconds since the run started. Measured, never simulated. */
  elapsed_ms: number;
}

export type ProgressSink = (event: ProgressEvent) => void;

/* ── what the model may return ── */

/** The competitor fields the bank defines (entity schema "competitor"). */
const FIELDS = [
  "name",
  "url",
  "what_they_sell",
  "price_points",
  "delivery_promise",
  "strengths",
  "weaknesses",
  "why_customers_choose_them",
] as const;
type CompetitorField = (typeof FIELDS)[number];

const EXTRACTION_SCHEMA = {
  type: "object" as const,
  properties: {
    fields: {
      type: "object" as const,
      properties: Object.fromEntries(
        FIELDS.map((f) => [f, { type: ["string", "null"] as unknown as "string" }]),
      ),
      required: [...FIELDS],
      additionalProperties: false,
    },
  },
  required: ["fields"],
  additionalProperties: false,
};

const SYSTEM = `You read a competitor's own web pages and record only what they actually say.

Return one value per field, or null. Null is the correct answer whenever the pages do not support a value — a competitor with no prices listed has null price_points. Never infer, never generalise from the industry, never fill a field because it looks empty.

Quote or closely paraphrase the pages. Keep each value under 240 characters.

Fields:
- name: the business's own name for itself
- url: their main page
- what_they_sell: their offering, in their words
- price_points: prices actually shown, with currency; null if none are published
- delivery_promise: what they promise on delivery or fulfilment — speed, cost, area covered; null if the pages say nothing
- strengths: what they visibly do well
- weaknesses: gaps visible on the page — thin range, no delivery, no prices shown
- why_customers_choose_them: the reason they themselves give`;

/* ── the live implementations ── */

export const liveResearchLlm: ResearchLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: RESEARCH_MODEL,
    max_tokens: 1200,
    system,
    output_config: { format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  const record = buildCallRecord({
    workload: "research",
    account_id: accountId,
    model: RESEARCH_MODEL,
    duration_ms: Date.now() - started,
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
    },
  });
  logLlmCall(record);
  if (response.stop_reason !== "end_turn") {
    throw new ResearchError(`unexpected stop_reason "${response.stop_reason}"`);
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  return { text, calls: [record] };
};

/* ── the run ── */

export interface ResearchResult {
  competitor_id: string;
  /** Pages that were actually read, in the order they were read. */
  pages_read: string[];
  /** Fields written as answered, from the pages. */
  written: CompetitorField[];
  /** Fields the pages did not support — recorded as unknown, not guessed. */
  unknown: CompetitorField[];
  /** Fields left alone because the owner had already answered them. */
  preserved_owner_facts: CompetitorField[];
  researched_at: string;
  calls: readonly LlmCallRecord[];
  events: ProgressEvent[];
}

interface RunArgs {
  accountId: string;
  profileId: string;
  /** What the owner called them. */
  competitorName: string;
  /** Enrich an existing competitor row instead of creating one. */
  competitorId?: string;
  search: SearchProvider;
  fetchPage: PageFetcher;
  llm?: ResearchLlm;
  onProgress?: ProgressSink;
}

/** Rule 2's ceiling: refuse a profile that has already spent its budget. */
async function assertBudget(profileId: string): Promise<void> {
  const rows = await db
    .select({ id: competitors.id })
    .from(competitors)
    .where(eq(competitors.profile_id, profileId));
  if (rows.length >= CAPS.max_runs_per_profile) {
    throw new ResearchError(
      `profile has ${rows.length} competitors, at the cap of ${CAPS.max_runs_per_profile}`,
    );
  }
}

/**
 * Rule 3, second half: research may fill a blank, never contradict the
 * owner. A field they answered themselves is left exactly as it is.
 */
async function ownerAnsweredKeys(
  profileId: string,
  competitorId: string,
): Promise<Set<CompetitorField>> {
  const rows = await db
    .select({ key: fieldRecords.field_key, source: fieldRecords.source, status: fieldRecords.status })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));

  const held = new Set<CompetitorField>();
  const prefix = `competitors.${competitorId}.`;
  for (const row of rows) {
    if (!row.key.startsWith(prefix) || row.status !== "answered") continue;
    const kind = (row.source as { kind?: string } | null)?.kind;
    if (kind !== "owner_input" && kind !== "conversation") continue;
    const field = row.key.slice(prefix.length) as CompetitorField;
    if (FIELDS.includes(field)) held.add(field);
  }
  return held;
}

/**
 * Search, read, extract, record. Every step reports the real time it
 * took; nothing here sleeps, pads, or pretends.
 */
export async function researchCompetitor(args: RunArgs): Promise<ResearchResult> {
  const t0 = Date.now();
  const events: ProgressEvent[] = [];
  const emit = (step: ResearchStep, detail: string): void => {
    const event: ProgressEvent = { step, detail, elapsed_ms: Date.now() - t0 };
    events.push(event);
    args.onProgress?.(event);
  };

  if (!args.competitorId) await assertBudget(args.profileId);

  // 1 · search, capped
  const hits = (await args.search(args.competitorName, CAPS.max_results)).slice(
    0,
    CAPS.max_results,
  );
  emit("search", `searched for “${args.competitorName}” · ${hits.length} results`);
  if (hits.length === 0) throw new ResearchError(`nothing found for "${args.competitorName}"`);

  // 2 · fetch, capped and timeout-bounded. A slow page is skipped.
  const pages: FetchedPage[] = [];
  for (const hit of hits) {
    if (pages.length >= CAPS.max_pages) break;
    const page = await args.fetchPage(hit.url, CAPS.page_timeout_ms);
    if (!page) {
      emit("fetch", `skipped ${hit.url} · no response inside ${CAPS.page_timeout_ms} ms`);
      continue;
    }
    pages.push({ ...page, text: page.text.slice(0, CAPS.max_page_chars) });
    emit("fetch", `read ${page.url} · ${page.text.length.toLocaleString("en-US")} characters`);
  }
  if (pages.length === 0) throw new ResearchError("every candidate page failed to load");

  // 3 · extract — the only model call in the run
  const llm = args.llm ?? liveResearchLlm;
  const user = [
    `COMPETITOR AS THE OWNER NAMED THEM: ${args.competitorName}`,
    "",
    ...pages.map((p) => `--- PAGE ${p.url} (${p.title}) ---\n${p.text}`),
  ].join("\n");
  const { text, calls } = await llm({ system: SYSTEM, user, accountId: args.accountId });
  emit("read", `read ${pages.length} page${pages.length === 1 ? "" : "s"}`);

  let payload: { fields: Record<string, string | null> };
  try {
    payload = JSON.parse(text) as { fields: Record<string, string | null> };
  } catch {
    throw new ResearchError(`extractor returned non-JSON: ${text.slice(0, 160)}`);
  }

  // 4 · record
  const at = isoDateTime(new Date().toISOString());
  let competitorId = args.competitorId;
  if (!competitorId) {
    const [row] = await db
      .insert(competitors)
      .values({
        profile_id: args.profileId,
        source: { kind: "web_research", researched_url: pages[0]!.url },
        researched_at: at,
      })
      .returning();
    if (!row) throw new ResearchError("competitor insert failed");
    competitorId = row.id;
  } else {
    await db
      .update(competitors)
      .set({ researched_at: at })
      .where(eq(competitors.id, competitorId));
  }

  const ownerHeld = args.competitorId
    ? await ownerAnsweredKeys(args.profileId, competitorId)
    : new Set<CompetitorField>();

  const written: CompetitorField[] = [];
  const unknown: CompetitorField[] = [];
  const preserved: CompetitorField[] = [];

  for (const field of FIELDS) {
    if (ownerHeld.has(field)) {
      preserved.push(field);
      continue;
    }
    const raw = payload.fields?.[field];
    const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim().slice(0, 240) : null;
    // Rule 3: no value on the page means unknown, recorded as such.
    await writeField(
      args.profileId,
      createField<unknown>({
        id: fieldId(`competitors.${competitorId}.${field}`),
        value,
        status: value === null ? "unknown" : "answered",
        confidence: RESEARCH_CONFIDENCE,
        source: { kind: "web_research", researched_url: pages[0]!.url },
        observed_at: at,
        recorded_at: at,
        note: value === null ? "not stated on the pages read" : null,
      }),
    );
    (value === null ? unknown : written).push(field);
  }

  emit(
    "write",
    `recorded ${written.length} fact${written.length === 1 ? "" : "s"}` +
      (unknown.length > 0 ? `, ${unknown.length} not stated on their site` : "") +
      (preserved.length > 0 ? `, kept ${preserved.length} of your own answers` : ""),
  );
  emit("done", `finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  return {
    competitor_id: competitorId,
    pages_read: pages.map((p) => p.url),
    written,
    unknown,
    preserved_owner_facts: preserved,
    researched_at: at,
    calls,
    events,
  };
}
