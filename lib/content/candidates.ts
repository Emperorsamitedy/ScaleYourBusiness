// Three AI video candidates per brief, the owner picks one — P6-03
// (Phase 6, rules 33 and 34; the owner's choice on 2026-11-08: "AI video:
// Higgsfield, three candidates per brief, the owner picks one").
//
// The path, end to end:
//
//   1. PROPOSE (proposeCandidates, through proposeGeneration). Only for a
//      shot list made from a creative brief's hook, with no footage — real
//      footage first, always (generationRefusal). The three prompts are
//      built from the business's profile facts with their provenance and
//      the brief's hook (./video-prompt), never from typed free text; the
//      likeness and brand screen runs on each. The proposal states the
//      price of the set and the caps, and generates nothing (rule 12).
//   2. GENERATE (generateCandidatesFromProposal), once approved: the caps
//      are checked BEFORE anything is submitted, the claim is taken (one
//      run per proposal, ever), and the three are SUBMITTED side by side —
//      the request answers at once (the owner's decision of 2026-11-09).
//      COLLECT (collectCandidates: the studio while it is open, and the
//      collect-video cron) asks after each one, retries a failed attempt
//      (at most MAX_GENERATION_ATTEMPTS, the caps re-checked before every
//      retry), and closes what runs out of time. Each finished clip is
//      labelled in the file (rule 33 — before it is stored anywhere),
//      stored through the media store (Vercel Blob in production), and kept
//      as a candidate row with its own cost line, tagged by workload (rule 34).
//   3. PICK (pickCandidate): the owner chooses one in the studio. It goes on
//      the shot list's video item through placeMedia — labelled as
//      generated in the caption and the record — and is offered for
//      publishing like anything else: nothing is posted without that yes.
//      The other two are KEPT, marked not_chosen. The pick is a decision,
//      in the append-only decision log with who made it.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import {
  contentItems,
  decisionLog,
  mediaCandidates,
  mediaGenerations,
  proposals,
} from "../../db/schema";
import type { Money } from "../core/money";
import { format, money } from "../core/money";
import { logSafeError } from "../core/log-safe";
import type { LimitLlm } from "../proposals/hard-limits";
import {
  checkHardLimits,
  ensureHardLimits,
  limitCaption,
  liveLimitLlm,
} from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal, recordExecution } from "../proposals/service";
import { briefForItem, briefRefOf } from "./brief-links";
import { mediaDisclosureLabel } from "./disclosure";
import { readVideoComment, stampVideo, videoLabellingAvailable } from "./generate/label";
import { BriefError, requireGenerationBrief } from "../growth/brief";
import { recordLabelling } from "../growth/library";
import type { GenerationOutput, MediaJobs, MediaProvider, SubmittedJob } from "./generate/provider";
import { FIXED_INSTRUCTION, GENERATED_CLIP_SECONDS, ProviderError } from "./generate/provider";
import { screenPrompt } from "./generate/guard";
import type { GenerationCaps, GenerationOutcome, GenerationSetup } from "./generation";
import {
  GENERATION_EXPIRY_DAYS,
  GENERATION_KIND,
  GENERATION_OFF,
  MAX_GENERATION_ATTEMPTS,
  accountOf,
  capRefusal,
  capRoom,
  capsOf,
  competitorNames,
  generationRefusal,
  generationSetup,
  generationView,
  lockCaps,
  ownedItem,
  promptHash,
  setupView,
} from "./generation";
import type { GenerationSetupView } from "./generation";
import type { MediaStore } from "./media";
import { configuredMediaStore, renderPath } from "./media";
import type { ContentItemRow } from "./media-item";
import { placeMedia } from "./media-item";
import { ContentError } from "./plan";
import { buildVideoPrompts, readVideoFacts } from "./video-prompt";

/** Rule 34: the budget line every candidate's cost is tagged with. */
export const AI_VIDEO_WORKLOAD = "ai_video";
/*
 * The owner's decision of 2026-11-09 ("the best solution top businesses are
 * currently doing"): a set is SUBMITTED and the request answers at once;
 * the clips are collected later (collectCandidates), so no request waits
 * minutes for them and no platform time limit can strand a set.
 */
/** A candidate that never finished this long after its set started is closed as failed. */
export const CANDIDATE_DEADLINE_MS = 2 * 60 * 60 * 1000;
/** A clip that finished but couldn't be collected (no FFmpeg here, say): Higgsfield keeps it at least seven days. */
export const COLLECT_DEADLINE_MS = 6 * 24 * 60 * 60 * 1000;
/** One run holds a candidate this long: a download, a label and a store fit inside it. */
export const COLLECT_LEASE_MS = 5 * 60 * 1000;
/** A candidate is asked after no more often than this, however often the studio polls. */
export const MIN_CHECK_GAP_MS = 10_000;
/** Hard caps on one collecting run. */
export const COLLECT_LIMITS = {
  /** Candidates taken per run. */
  candidates: 12,
  /** Finished clips downloaded, labelled and stored per run. */
  downloads: 6,
  /** Nothing new is started past this, inside a 300 s function. */
  budget_ms: 200_000,
};
/** A stored candidate read back for placing: refused past this. */
export const CANDIDATE_MAX_BYTES = 150 * 1024 * 1024;

export const DIRECTION_REFUSED =
  "An AI video's words come from your profile facts and the creative brief, not from typed directions: change those facts, or film it yourself";
export const NEEDS_BRIEF =
  "AI video is made from a creative brief's hook: make this shot list from a brief in the studio first";
export const NEEDS_FACTS =
  "ScaleX doesn't know yet what the business sells, so there is nothing true to film: answer that in the interview first";

/** sha256 of a set's exact prompts, the fixed instruction included — what the approval covers. */
export function promptsHash(prompts: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: 2, prompts, instruction: FIXED_INSTRUCTION }))
    .digest("hex");
}

/* ── 1. proposing ── */

export async function proposeCandidates(args: {
  profileId: string;
  item: ContentItemRow;
  provider: MediaProvider;
  caps: GenerationCaps;
  candidates: number;
  direction: string;
  now: Date;
  limitLlm?: LimitLlm;
}): Promise<ProposalRow> {
  const { item, provider } = args;
  if (args.direction !== "") throw new ContentError(DIRECTION_REFUSED, 422);
  const found = await briefForItem(args.profileId, item.provenance);
  const ref = briefRefOf(item.provenance);
  if (!found?.hook || !ref || ref.hook_index === null) throw new ContentError(NEEDS_BRIEF, 409);

  const facts = await readVideoFacts(args.profileId);
  const built = buildVideoPrompts({ facts, hook: found.hook, seconds: GENERATED_CLIP_SECONDS });
  if (!built) throw new ContentError(NEEDS_FACTS, 409);
  const prompts = built.slice(0, args.candidates);
  const brands = await competitorNames(args.profileId);
  for (const prompt of prompts) {
    const verdict = screenPrompt(prompt, brands);
    if (!verdict.ok) {
      throw new ContentError(
        `ScaleX won't propose that: ${verdict.reason} ("${verdict.matched}"), from your profile facts or the brief. Change that fact, or film it.`,
        422,
      );
    }
  }

  const seconds = GENERATED_CLIP_SECONDS;
  const each = provider.estimate({ media: "video", seconds });
  const total = money(each.amount_minor * prompts.length, each.currency);
  const accountId = await accountOf(args.profileId);
  const room = await capRoom({ accountId, targetItemId: item.id, now: args.now, caps: args.caps });
  const over = capRefusal(room, total);
  if (over) throw new ContentError(`ScaleX won't propose that: ${over}`, 409);

  const { limits } = await ensureHardLimits(args.profileId, args.limitLlm ?? liveLimitLlm);
  const limit = checkHardLimits(limits, "content_publishing");
  const label = mediaDisclosureLabel("video", "generated_video");
  const n = prompts.length;
  const cost = format(total);
  return createProposal({
    profile_id: args.profileId,
    module: "content",
    originating_finding: `generate:${item.id}`,
    action: {
      kind: GENERATION_KIND,
      summary: `Generate ${n} AI video candidates (${seconds} seconds each) for "${item.title}": about ${cost} in all; you pick one, because there's no footage for it`,
      detail: {
        target_item_id: item.id,
        media: "video",
        seconds,
        candidates: n,
        provider: provider.id,
        prompts,
        instruction: FIXED_INSTRUCTION,
        prompt_sha256: promptsHash(prompts),
        estimate: total,
        estimate_each: each,
        caps: {
          item: room.item_cap,
          item_spent: room.item_spent,
          month: room.month_cap,
          month_spent: room.month_spent,
          max_attempts: MAX_GENERATION_ATTEMPTS,
        },
        label,
        brief: {
          brief_id: found.brief.id,
          hook_index: ref.hook_index,
          hook: found.hook.hook,
          cites: found.hook.cites.map((c) => c.id),
        },
        // Rule 33: every fact the prompts rest on, with its provenance.
        facts: facts.map((f) => ({
          key: f.key,
          record_id: f.record_id,
          status: f.status,
          source: f.source_kind,
          recorded_at: f.recorded_at,
        })),
        manual_limits: limit.manual.map((l) => l.quote),
        rationale:
          "Real footage first: this is the fallback for a shot list with none. The prompts are built from your profile facts and the brief, never from anyone's typed words. Every clip is labelled as AI-generated from the moment it exists, you pick one, and it still needs its own yes before it is published.",
      },
    },
    scenario: {
      assumptions: [
        {
          statement: `Each candidate costs about ${format(each)} at ${provider.id}'s published price; at most ${MAX_GENERATION_ATTEMPTS} attempts each`,
          value: null,
          source_field: null,
          sensitivity: "low",
        },
      ],
      base_case: {
        case: "base",
        statement: `${n} labelled ${seconds}-second clips for "${item.title}" to choose from in the studio; the one you pick is offered for publishing.`,
        profit_delta_monthly: null,
        formula: null,
      },
      downside_case: {
        case: "downside",
        statement: `None is usable and about ${cost} (at most ${format(money(total.amount_minor * MAX_GENERATION_ATTEMPTS, total.currency))} with every retry) is spent. Nothing is published without your yes.`,
        profit_delta_monthly: null,
        formula: null,
      },
      upside_case: {
        case: "upside",
        statement:
          "The item goes out on time, and your own footage replaces it whenever you film it.",
        profit_delta_monthly: null,
        formula: null,
      },
      breakeven_condition: `costs about ${cost}, under a ${format(room.item_cap)} per-item and ${format(room.month_cap)} per-month cap`,
    } as never,
    reversibility: {
      level: "moderate",
      if_you_change_your_mind:
        "The money spent on generating isn't refundable. Nothing publishes until you pick a clip and approve it separately, and your own footage replaces it whenever you upload it.",
    },
    expires_at: new Date(args.now.getTime() + GENERATION_EXPIRY_DAYS * 86_400_000).toISOString(),
    blocked_by_limit: limit.verdict === "blocked" ? limitCaption(limit.limit) : null,
  });
}

/* ── 2. generating, once approved: submit now, collect in the background ── */

interface CandidateDetail {
  target_item_id?: unknown;
  candidates?: unknown;
  seconds?: unknown;
  prompts?: unknown;
  prompt_sha256?: unknown;
  brief?: { brief_id?: unknown; hook_index?: unknown };
}

type CandidateRow = typeof mediaCandidates.$inferSelect;

/** Enough to close a candidate and write its cost line, even with its provider gone. */
interface SetLog {
  generationId: string;
  accountId: string;
  providerId: string;
  currency: string;
  now: Date;
}

/** What every submit, check and settlement of one set needs. */
interface SetContext extends SetLog {
  profileId: string;
  proposalId: string;
  targetItemId: string;
  provider: MediaProvider;
  jobs: MediaJobs;
  caps: GenerationCaps;
  /** The price of one attempt (one clip), in the caps' currency. */
  each: Money;
  seconds: number;
  /** The set's approved prompts, by ordinal - 1. */
  prompts: string[];
}

/** Pure: the approved prompts of a candidate proposal, or null when it doesn't say what to make. */
function promptsOf(d: CandidateDetail): string[] | null {
  const prompts = Array.isArray(d.prompts)
    ? d.prompts.filter((p): p is string => typeof p === "string")
    : [];
  if (prompts.length === 0 || prompts.length !== d.candidates || prompts.length > 3) return null;
  return prompts;
}

/**
 * What a set holds against the caps while it runs: every charge so far,
 * plus one attempt's price for each candidate still being made (in flight,
 * or about to be retried). The claim's estimate is kept at this figure, so
 * capRoom sees it.
 */
const HOLD_SQL = sql`coalesce(sum(CASE WHEN ${mediaCandidates.status} = 'generating' THEN coalesce(${mediaCandidates.cost_minor}, 0) + ${mediaCandidates.estimate_minor} ELSE coalesce(${mediaCandidates.cost_minor}, 0) END), 0)`;

/** Bring the claim's estimate down to what the set still holds (lowering needs no lock). */
async function rehold(generationId: string, exec: DbOrTx = db): Promise<void> {
  await exec
    .update(mediaGenerations)
    .set({
      estimate_minor: sql`(SELECT ${HOLD_SQL} FROM ${mediaCandidates} WHERE ${mediaCandidates.generation_id} = ${generationId})`,
    })
    .where(and(eq(mediaGenerations.id, generationId), eq(mediaGenerations.status, "generating")));
}

/**
 * Room for one more attempt of a candidate, taken from the ledger under
 * the account's lock: every other run's claims are read again, this set's
 * own estimate is swapped for what it will hold with the retry in it, and
 * both the candidate's charges so far and the claim's estimate are written
 * before anything is submitted, so a run started meanwhile sees them.
 */
function reserveRetry(
  ctx: SetContext,
  candidateId: string,
  charged: number,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await lockCaps(tx, ctx.accountId);
    const [own] = await tx
      .select({ estimate_minor: mediaGenerations.estimate_minor })
      .from(mediaGenerations)
      .where(eq(mediaGenerations.id, ctx.generationId));
    const rows = await tx
      .select({
        id: mediaCandidates.id,
        status: mediaCandidates.status,
        cost_minor: mediaCandidates.cost_minor,
        estimate_minor: mediaCandidates.estimate_minor,
      })
      .from(mediaCandidates)
      .where(eq(mediaCandidates.generation_id, ctx.generationId));
    const hold = rows.reduce((sum, r) => {
      const cost = r.id === candidateId ? charged : (r.cost_minor ?? 0);
      return sum + cost + (r.status === "generating" ? r.estimate_minor : 0);
    }, 0);
    const r = await capRoom({
      accountId: ctx.accountId,
      targetItemId: ctx.targetItemId,
      now: ctx.now,
      caps: ctx.caps,
      exec: tx,
    });
    const before = (spent: Money) =>
      money(
        spent.amount_minor - (own?.estimate_minor ?? 0) + hold - ctx.each.amount_minor,
        ctx.caps.currency,
      );
    const stop = capRefusal(
      { ...r, item_spent: before(r.item_spent), month_spent: before(r.month_spent) },
      ctx.each,
    );
    if (stop) return stop;
    await tx
      .update(mediaCandidates)
      .set({ cost_minor: charged })
      .where(eq(mediaCandidates.id, candidateId));
    await tx
      .update(mediaGenerations)
      .set({ estimate_minor: hold })
      .where(eq(mediaGenerations.id, ctx.generationId));
    return null;
  });
}

/** Rule 34: one cost line per candidate, tagged by workload, when it settles. */
function costLine(
  ctx: SetLog,
  c: Pick<CandidateRow, "id" | "ordinal" | "request_id">,
  costMinor: number,
  status: "ready" | "failed",
  model: string | null = null,
): void {
  console.log(
    JSON.stringify({
      event: "media_generation_cost",
      workload: AI_VIDEO_WORKLOAD,
      account_id: ctx.accountId,
      generation_id: ctx.generationId,
      candidate_id: c.id,
      ordinal: c.ordinal,
      provider: ctx.providerId,
      ...(model ? { model } : {}),
      request_id: c.request_id ?? null,
      cost_minor: costMinor,
      currency: ctx.currency,
      status,
    }),
  );
}

/** Close a candidate as failed with its reason and what it cost. False when another run settled it first. */
async function failCandidate(
  ctx: SetLog,
  c: Pick<CandidateRow, "id" | "ordinal" | "request_id">,
  sentence: string,
  charged: number,
): Promise<boolean> {
  const [row] = await db
    .update(mediaCandidates)
    .set({
      status: "failed",
      error: sentence,
      waiting: null,
      cost_minor: charged,
      lease_until: null,
      finished_at: ctx.now.toISOString(),
    })
    .where(and(eq(mediaCandidates.id, c.id), eq(mediaCandidates.status, "generating")))
    .returning({ id: mediaCandidates.id });
  if (!row) return false;
  costLine(ctx, c, charged, "failed");
  return true;
}

/** Leave a candidate for a later run, saying why when there is a reason the owner should see. */
async function release(candidateId: string, waiting?: string | null): Promise<void> {
  await db
    .update(mediaCandidates)
    .set({ lease_until: null, ...(waiting !== undefined ? { waiting } : {}) })
    .where(eq(mediaCandidates.id, candidateId));
}

/**
 * Submit one candidate's attempt, and another after a retryable refusal
 * (each attempt its own Idempotency-Key, at most MAX_GENERATION_ATTEMPTS),
 * then return: nothing here waits for the clip. A recovery passes the
 * attempt it lost the answer to, with that attempt's own key, so
 * Higgsfield hands back the first request instead of charging twice.
 */
async function submitCandidate(
  ctx: SetContext,
  c: Pick<CandidateRow, "id" | "ordinal" | "request_id">,
  opts: { attempt: number; charged: number; reserveFirst: boolean },
): Promise<"submitted" | "failed"> {
  const prompt = ctx.prompts[c.ordinal - 1];
  if (!prompt) {
    await failCandidate(ctx, c, "the approved prompt for this candidate is missing", opts.charged);
    return "failed";
  }
  let charged = opts.charged;
  for (let attempt = opts.attempt; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    if (attempt > opts.attempt || opts.reserveFirst) {
      const stop = await reserveRetry(ctx, c.id, charged);
      if (stop) {
        await failCandidate(ctx, c, `a retry ${stop}`, charged);
        return "failed";
      }
    }
    await db
      .update(mediaCandidates)
      .set({
        attempts: attempt,
        request_id: null,
        status_url: null,
        cancel_url: null,
        completed_at: null,
        waiting: null,
      })
      .where(and(eq(mediaCandidates.id, c.id), eq(mediaCandidates.status, "generating")));
    try {
      const job = await ctx.jobs.submit({
        media: "video",
        prompt,
        instruction: FIXED_INSTRUCTION,
        aspect: "9:16",
        seconds: ctx.seconds,
        account_id: ctx.accountId,
        idempotency_key: `syb-${ctx.generationId}-${c.ordinal}-${attempt}`,
      });
      await db
        .update(mediaCandidates)
        .set({
          request_id: job.request_id,
          status_url: job.status_url,
          cancel_url: job.cancel_url,
          submitted_at: ctx.now.toISOString(),
          ...(charged > 0 ? { cost_minor: charged } : {}),
        })
        .where(and(eq(mediaCandidates.id, c.id), eq(mediaCandidates.status, "generating")));
      return "submitted";
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.cost && error.cost.currency === ctx.caps.currency) {
        charged += error.cost.amount_minor;
      }
      if (!error.retryable || attempt === MAX_GENERATION_ATTEMPTS) {
        await failCandidate(ctx, c, error.message, charged);
        return "failed";
      }
    }
  }
  await failCandidate(ctx, c, "the provider took nothing", charged);
  return "failed";
}

/**
 * Settle a set once none of its candidates is still being made: its cost,
 * its status, and the proposal's execution with every candidate's outcome
 * (so a set that failed, or was swept, no longer holds its proposal open).
 * Null while candidates remain, or when another run settled it first.
 */
async function settleSet(generationId: string, now: Date): Promise<GenerationOutcome | null> {
  const rows = await db
    .select()
    .from(mediaCandidates)
    .where(eq(mediaCandidates.generation_id, generationId))
    .orderBy(mediaCandidates.ordinal);
  if (rows.length === 0 || rows.some((r) => r.status === "generating")) return null;
  const charged = rows.reduce((s, r) => s + (r.cost_minor ?? 0), 0);
  const made = rows.filter((r) => r.status !== "failed");
  const firstError = rows.find((r) => r.error)?.error ?? null;
  const [gen] = await db
    .update(mediaGenerations)
    .set({
      status: made.length > 0 ? "generated" : "failed",
      cost_minor: charged,
      attempts: Math.max(...rows.map((r) => r.attempts)),
      finished_at: now.toISOString(),
      ...(made.length === 0 ? { error: firstError ?? "nothing was made" } : {}),
    })
    .where(and(eq(mediaGenerations.id, generationId), eq(mediaGenerations.status, "generating")))
    .returning();
  if (!gen) return null;
  const cost = money(charged, gen.currency);
  try {
    await recordExecution({
      proposalId: gen.proposal_id,
      result: {
        generated: made.length > 0,
        candidates: rows.map((r) => ({ id: r.id, ordinal: r.ordinal, status: r.status })),
        cost,
      },
    });
  } catch (error) {
    // Not approved any more (expired, say): the set is settled all the same.
    console.error(
      JSON.stringify({
        event: "media_candidates_execution_not_recorded",
        account_id: gen.account_id,
        generation_id: gen.id,
        ...logSafeError(error),
      }),
    );
  }
  console.log(
    JSON.stringify({
      event: "media_candidates_settled",
      account_id: gen.account_id,
      generation_id: gen.id,
      made: made.length,
      of: rows.length,
      cost_minor: charged,
      currency: gen.currency,
    }),
  );
  if (made.length === 0) {
    return {
      status: "failed",
      cost,
      candidate_ids: rows.map((r) => r.id),
      note: `Generating failed: ${firstError ?? "nothing was made"}. ${format(cost)} was charged.`,
    };
  }
  return {
    status: "generated",
    cost,
    candidate_ids: made.map((r) => r.id),
    note: `${made.length} of ${rows.length} AI video candidates are ready for ${format(cost)}, each labelled as AI-generated. Pick one in the studio; nothing is published without your yes.`,
  };
}

export async function generateCandidatesFromProposal(args: {
  proposal: ProposalRow;
  setup: GenerationSetup;
  store?: MediaStore;
  now: Date;
  /** Whether FFmpeg and ffprobe are here to label the clips (tests inject it). */
  labelling?: () => boolean;
}): Promise<GenerationOutcome> {
  const { proposal, setup, now } = args;
  const d = ((proposal.action as { detail?: CandidateDetail }).detail ?? {}) as CandidateDetail;
  const prompts = promptsOf(d);
  if (typeof d.target_item_id !== "string" || !prompts) {
    throw new ContentError("the proposal doesn't say what to generate", 422);
  }
  if (d.prompt_sha256 !== promptsHash(prompts)) {
    throw new ContentError("the prompts aren't the ones you approved: nothing was generated", 409);
  }
  const seconds = GENERATED_CLIP_SECONDS;
  if (!setup.provider) {
    throw new ContentError(`${setup.reason ?? GENERATION_OFF} It stays approved.`, 503);
  }
  const provider = setup.provider;
  if (!provider.jobs) {
    throw new ContentError(
      `the ${provider.id} provider can't make a set of candidates in the background. It stays approved.`,
      409,
    );
  }
  const store = args.store ?? configuredMediaStore();
  if (!store) {
    throw new ContentError("media storage isn't set up on this server. It stays approved.", 503);
  }
  // Rule 33: a clip that can't be labelled is never kept, so nothing is paid for until it can be.
  if (!(args.labelling ?? videoLabellingAvailable)()) {
    throw new ContentError(
      "AI video can't be labelled on this server (FFmpeg isn't here), so nothing was generated or charged. It stays approved.",
      503,
    );
  }
  const caps = capsOf(setup);
  const accountId = await accountOf(proposal.profile_id);
  const target = await ownedItem(proposal.profile_id, d.target_item_id);
  const zero = money(0, caps.currency);

  // The v1 spec §10.2: no evidence-cited brief, no generation (also held by the database).
  let evidenceBriefId: string;
  try {
    evidenceBriefId = await requireGenerationBrief(proposal.profile_id, target.provenance);
  } catch (error) {
    if (error instanceof BriefError)
      throw new ContentError(`Nothing was generated: ${error.message}.`, error.status);
    throw error;
  }

  // Footage arrived while this waited: real footage wins, nothing generated, nothing charged.
  const refusal = await generationRefusal(target);
  if (refusal) {
    await recordExecution({
      proposalId: proposal.id,
      result: { generated: false, reason: refusal, cost: zero },
    });
    return {
      status: "not_needed",
      cost: zero,
      note: `Nothing was generated and nothing was charged: ${refusal}.`,
    };
  }
  const brands = await competitorNames(proposal.profile_id);
  for (const prompt of prompts) {
    const verdict = screenPrompt(prompt, brands);
    if (!verdict.ok) {
      throw new ContentError(
        `Nothing was generated: ${verdict.reason} ("${verdict.matched}").`,
        422,
      );
    }
  }

  // The caps, BEFORE anything is submitted: the whole set must fit.
  const each = provider.estimate({ media: "video", seconds });
  if (each.currency !== caps.currency) {
    throw new ContentError(
      `Nothing was generated: the provider prices in ${each.currency} and the caps are in ${caps.currency}. It stays approved.`,
      409,
    );
  }
  const setPrice = money(each.amount_minor * prompts.length, each.currency);
  const label = mediaDisclosureLabel("video", "generated_video");
  const briefId = typeof d.brief?.brief_id === "string" ? d.brief.brief_id : null;
  const hookIndex = Number.isInteger(d.brief?.hook_index) ? (d.brief!.hook_index as number) : null;

  // The claim: one run per approved proposal, ever. The caps are read and
  // the claim and its candidates written under the account's lock, so two
  // sets started at once can't both fit into room for one; the claim's
  // estimate holds the room. The candidates are leased to this run while it
  // submits, so the collector doesn't take them meanwhile.
  let claimId: string;
  let rows: Pick<CandidateRow, "id" | "ordinal" | "request_id">[];
  try {
    ({ claimId, rows } = await db.transaction(async (tx) => {
      await lockCaps(tx, accountId);
      const room = await capRoom({ accountId, targetItemId: target.id, now, caps, exec: tx });
      const over = capRefusal(room, setPrice);
      if (over) throw new ContentError(`Nothing was generated: ${over}. It stays approved.`, 409);
      const [claim] = await tx
        .insert(mediaGenerations)
        .values({
          profile_id: proposal.profile_id,
          account_id: accountId,
          proposal_id: proposal.id,
          target_item_id: target.id,
          media: "video",
          provider: provider.id,
          estimate_minor: setPrice.amount_minor,
          currency: caps.currency,
          prompt_sha256: promptsHash(prompts),
          creative_brief_id: evidenceBriefId,
          created_at: now.toISOString(),
        })
        .returning({ id: mediaGenerations.id });
      // Rule 33: the label is on the row from the moment the candidate exists.
      const inserted = await tx
        .insert(mediaCandidates)
        .values(
          prompts.map((prompt, i) => ({
            generation_id: claim!.id,
            profile_id: proposal.profile_id,
            proposal_id: proposal.id,
            target_item_id: target.id,
            brief_id: briefId,
            hook_index: hookIndex,
            ordinal: i + 1,
            provider: provider.id,
            prompt_sha256: promptHash(prompt),
            label,
            workload: AI_VIDEO_WORKLOAD,
            estimate_minor: each.amount_minor,
            currency: caps.currency,
            created_at: now.toISOString(),
            lease_until: new Date(now.getTime() + COLLECT_LEASE_MS).toISOString(),
          })),
        )
        .returning({
          id: mediaCandidates.id,
          ordinal: mediaCandidates.ordinal,
          request_id: mediaCandidates.request_id,
        });
      return { claimId: claim!.id, rows: inserted.sort((a, b) => a.ordinal - b.ordinal) };
    }));
  } catch (error) {
    if (
      /media_generations_proposal_uq/.test(String((error as { cause?: unknown }).cause ?? error))
    ) {
      throw new ContentError("this has already been generated, or is being generated now", 409);
    }
    throw error;
  }

  const ctx: SetContext = {
    generationId: claimId,
    profileId: proposal.profile_id,
    proposalId: proposal.id,
    accountId,
    providerId: provider.id,
    currency: caps.currency,
    targetItemId: target.id,
    provider,
    jobs: provider.jobs,
    caps,
    each,
    seconds,
    prompts,
    now,
  };
  // Submitted side by side; nothing here waits for a clip.
  const results = await Promise.all(
    rows.map(async (c) => {
      try {
        const out = await submitCandidate(ctx, c, { attempt: 1, charged: 0, reserveFirst: false });
        await release(c.id);
        return out;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "media_candidate_error",
            account_id: accountId,
            generation_id: claimId,
            candidate_id: c.id,
            ...logSafeError(error),
          }),
        );
        // Unknown whether it reached the provider: the lease lapses and the
        // collector asks again with the same Idempotency-Key.
        return "unknown" as const;
      }
    }),
  );
  await rehold(claimId);
  const settled = await settleSet(claimId, now);
  if (settled) return settled;
  const sent = results.filter((r) => r === "submitted").length;
  const [held] = await db
    .select({ estimate_minor: mediaGenerations.estimate_minor })
    .from(mediaGenerations)
    .where(eq(mediaGenerations.id, claimId));
  console.log(
    JSON.stringify({
      event: "media_candidates_submitted",
      account_id: accountId,
      generation_id: claimId,
      provider: provider.id,
      submitted: sent,
      of: rows.length,
      held_minor: held?.estimate_minor ?? null,
      currency: caps.currency,
    }),
  );
  return {
    status: "generating",
    cost: money(held?.estimate_minor ?? setPrice.amount_minor, caps.currency),
    candidate_ids: rows.map((r) => r.id),
    note: `${sent} of ${rows.length} AI video candidates were sent to ${provider.id}. They arrive in the studio over the next few minutes, each labelled as AI-generated; up to ${format(setPrice)} is held against your caps until then.`,
  };
}

/* ── 2b. collecting in the background, and the sweeper ── */

export interface CollectOutcome {
  /** Candidates this run took. */
  taken: number;
  checked: number;
  ready: number;
  failed: number;
  /** Closed at the deadline. */
  swept: number;
  retried: number;
  /** Finished at the provider, waiting here (no FFmpeg to label it, a download that dropped). */
  waiting: number;
  sets_settled: number;
  /** Left for the next run (its cap or its time budget). */
  left: number;
}

const DAY_MS = 86_400_000;

/** Pure: why a candidate is past its time, or null. */
export function candidateOverdue(
  c: Pick<CandidateRow, "created_at" | "completed_at">,
  now: Date,
): "never_finished" | "never_collected" | null {
  if (c.completed_at) {
    return now.getTime() - Date.parse(c.completed_at) > COLLECT_DEADLINE_MS
      ? "never_collected"
      : null;
  }
  return now.getTime() - Date.parse(c.created_at) > CANDIDATE_DEADLINE_MS ? "never_finished" : null;
}

const HOURS = CANDIDATE_DEADLINE_MS / 3_600_000;
const COLLECT_DAYS = COLLECT_DEADLINE_MS / DAY_MS;

/** The owner's words for a candidate waiting on FFmpeg (rule 33: nothing unlabelled is kept). */
export const WAITING_FOR_LABEL =
  "Finished at Higgsfield and paid for; it waits for a server with FFmpeg to label it as AI-generated before it is kept";

/**
 * Ask after every candidate still being made, collect what finished, and
 * close what ran out of time. Polling is the source of truth (Higgsfield's
 * webhook isn't documented); each run takes at most `limits.candidates`
 * candidates, downloads at most `limits.downloads` and starts nothing past
 * `limits.budget_ms`. Each candidate is leased to one run at a time, so a
 * clip is never downloaded twice. Called by the collect-video cron for
 * everyone and by the studio, while a set is being made, for its business.
 */
export async function collectCandidates(
  args: {
    setup?: GenerationSetup;
    store?: MediaStore | null;
    now?: Date;
    labelling?: () => boolean;
    profileId?: string;
    limits?: Partial<typeof COLLECT_LIMITS>;
  } = {},
): Promise<CollectOutcome> {
  const now = args.now ?? new Date();
  const started = Date.now();
  const limits = { ...COLLECT_LIMITS, ...args.limits };
  const setup = args.setup ?? generationSetup();
  const store = args.store === undefined ? configuredMediaStore() : args.store;
  const labelling = args.labelling ?? videoLabellingAvailable;
  const out: CollectOutcome = {
    taken: 0,
    checked: 0,
    ready: 0,
    failed: 0,
    swept: 0,
    retried: 0,
    waiting: 0,
    sets_settled: 0,
    left: 0,
  };
  const nowIso = now.toISOString();
  const deadlineIso = new Date(now.getTime() - CANDIDATE_DEADLINE_MS).toISOString();
  const gapIso = new Date(now.getTime() - MIN_CHECK_GAP_MS).toISOString();
  const leaseIso = new Date(now.getTime() + COLLECT_LEASE_MS).toISOString();
  const mine = args.profileId ? sql`AND profile_id = ${args.profileId}` : sql``;

  // Take this run's candidates: free of any other run's lease, and not asked about just now.
  const taken = await db.execute<{ id: string }>(sql`
    UPDATE media_candidates SET lease_until = ${leaseIso}
    WHERE id IN (
      SELECT id FROM media_candidates
      WHERE status = 'generating'
        AND (lease_until IS NULL OR lease_until < ${nowIso})
        AND (checked_at IS NULL OR checked_at < ${gapIso} OR created_at < ${deadlineIso})
        ${mine}
      ORDER BY checked_at ASC NULLS FIRST, created_at ASC
      LIMIT ${limits.candidates}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`);
  const ids = taken.rows.map((r) => r.id);
  out.taken = ids.length;
  const rows =
    ids.length === 0
      ? []
      : await db
          .select()
          .from(mediaCandidates)
          .where(inArray(mediaCandidates.id, ids))
          .orderBy(mediaCandidates.created_at, mediaCandidates.ordinal);

  type Found = { ctx: SetContext } | { log: SetLog; reason: string };
  const contexts = new Map<string, Found>();
  const contextFor = async (c: CandidateRow): Promise<Found> => {
    const known = contexts.get(c.generation_id);
    if (known) return known;
    const [gen] = await db
      .select({ account_id: mediaGenerations.account_id })
      .from(mediaGenerations)
      .where(eq(mediaGenerations.id, c.generation_id));
    const log: SetLog = {
      generationId: c.generation_id,
      accountId: gen?.account_id ?? "",
      providerId: c.provider,
      currency: c.currency,
      now,
    };
    const provider = setup.provider;
    const caps = capsOf(setup);
    const each = provider?.jobs
      ? provider.estimate({ media: "video", seconds: GENERATED_CLIP_SECONDS })
      : null;
    let found: Found;
    if (!provider?.jobs || !each || provider.id !== c.provider) {
      found = { log, reason: `AI video through ${c.provider} isn't set up on this server now` };
    } else if (caps.currency !== c.currency || each.currency !== c.currency) {
      found = {
        log,
        reason: `the provider's prices aren't in ${c.currency} any more, and ScaleX doesn't convert money`,
      };
    } else {
      const [proposal] = await db
        .select({ action: proposals.action })
        .from(proposals)
        .where(eq(proposals.id, c.proposal_id));
      const d = ((proposal?.action as { detail?: CandidateDetail } | undefined)?.detail ??
        {}) as CandidateDetail;
      found = {
        ctx: {
          ...log,
          profileId: c.profile_id,
          proposalId: c.proposal_id,
          targetItemId: c.target_item_id,
          provider,
          jobs: provider.jobs,
          caps,
          each,
          seconds: GENERATED_CLIP_SECONDS,
          prompts: promptsOf(d) ?? [],
        },
      };
    }
    contexts.set(c.generation_id, found);
    return found;
  };

  let downloads = 0;
  const dir = path.join(os.tmpdir(), `syb-collect-${randomBytes(8).toString("hex")}`);

  const collectOne = async (
    c: CandidateRow,
  ): Promise<"checked" | "ready" | "failed" | "swept" | "retried" | "waiting" | "left"> => {
    const overdue = candidateOverdue(c, now);
    const charged = c.cost_minor ?? 0;
    const found = await contextFor(c);
    if (!("ctx" in found)) {
      if (!overdue) {
        await release(c.id, `${found.reason}, so it waits`);
        return "waiting";
      }
      // Nobody can ask after it: counted as spent if it was ever sent.
      const lost = c.attempts > 0 ? c.estimate_minor : 0;
      await failCandidate(
        found.log,
        c,
        `${found.reason}, and it wasn't collected in time${lost > 0 ? "; it may have been billed, so it is counted as spent" : ""}`,
        charged + lost,
      );
      return "swept";
    }
    const { ctx } = found;

    // Submitted, but the answer was lost: ask again with the same key, or close it.
    if (!c.request_id) {
      if (overdue) {
        const lost = c.attempts > 0 ? ctx.each.amount_minor : 0;
        await failCandidate(
          ctx,
          c,
          `ScaleX never heard back from ${ctx.provider.id} about this request within ${HOURS} hours${lost > 0 ? "; it may have been billed, so it is counted as spent" : ""}`,
          charged + lost,
        );
        return "swept";
      }
      const res = await submitCandidate(ctx, c, {
        attempt: Math.max(1, c.attempts),
        charged,
        reserveFirst: false,
      });
      await release(c.id);
      return res === "submitted" ? "retried" : "failed";
    }

    const job: SubmittedJob = {
      request_id: c.request_id,
      status_url: c.status_url ?? "",
      cancel_url: c.cancel_url,
    };
    const check = await ctx.jobs.check(job);
    await db
      .update(mediaCandidates)
      .set({ checks: sql`${mediaCandidates.checks} + 1`, checked_at: nowIso })
      .where(eq(mediaCandidates.id, c.id));

    if (check.state === "pending") {
      if (overdue !== "never_finished") {
        await release(c.id, null);
        return "checked";
      }
      // The sweeper: never finished in time. Canceled while queued is free; otherwise counted as spent.
      const canceled = await ctx.jobs.cancel(job);
      await failCandidate(
        ctx,
        c,
        canceled
          ? `${ctx.provider.id} hadn't started this clip after ${HOURS} hours, so it was canceled: nothing was billed`
          : `${ctx.provider.id} didn't finish this clip within ${HOURS} hours; it may still finish and be billed, so it is counted as spent`,
        charged + (canceled ? 0 : ctx.each.amount_minor),
      );
      return "swept";
    }

    if (check.state === "failed") {
      const cost =
        charged +
        (check.charged && check.charged.currency === ctx.caps.currency
          ? check.charged.amount_minor
          : 0);
      if (check.retryable && c.attempts < MAX_GENERATION_ATTEMPTS && !overdue) {
        const res = await submitCandidate(ctx, c, {
          attempt: c.attempts + 1,
          charged: cost,
          reserveFirst: true,
        });
        await release(c.id);
        return res === "submitted" ? "retried" : "failed";
      }
      await failCandidate(ctx, c, check.message, cost);
      return "failed";
    }

    // Finished at the provider, and billed from here.
    if (!c.completed_at) {
      await db
        .update(mediaCandidates)
        .set({ completed_at: nowIso })
        .where(eq(mediaCandidates.id, c.id));
    }
    if (overdue === "never_collected") {
      await failCandidate(
        ctx,
        c,
        `it finished at ${ctx.provider.id} but couldn't be collected and labelled here within ${COLLECT_DAYS} days; it was billed, so it is counted as spent`,
        charged + ctx.each.amount_minor,
      );
      return "swept";
    }
    // Rule 33: never kept unlabelled — without FFmpeg it stays where it is, paid for and waiting.
    if (!labelling()) {
      await release(c.id, WAITING_FOR_LABEL);
      return "waiting";
    }
    if (!store) {
      await release(c.id, "Finished and paid for; it waits for media storage to be set up here");
      return "waiting";
    }
    if (downloads >= limits.downloads) {
      await release(c.id);
      return "left";
    }
    downloads += 1;
    let output: GenerationOutput;
    try {
      output = await ctx.jobs.fetchResult(job, check.result_url);
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      if (error.retryable) {
        await release(c.id, `${error.message}; ScaleX tries again on its next check`);
        return "waiting";
      }
      const cost = error.cost?.currency === ctx.caps.currency ? error.cost.amount_minor : 0;
      await failCandidate(ctx, c, error.message, charged + cost);
      return "failed";
    }
    if (output.cost.currency !== ctx.caps.currency) {
      await failCandidate(
        ctx,
        c,
        `the provider charged in ${output.cost.currency}, not ${ctx.caps.currency}`,
        charged + ctx.each.amount_minor,
      );
      return "failed";
    }
    const cost = charged + output.cost.amount_minor;
    if (output.content_type !== "video/mp4" || output.bytes.byteLength === 0) {
      await failCandidate(
        ctx,
        c,
        `the provider returned ${output.content_type}, not video/mp4`,
        cost,
      );
      return "failed";
    }

    // Rule 33, in the file: stamped and read back before it is stored anywhere.
    const raw = path.join(dir, `raw-${c.id}.mp4`);
    await fs.writeFile(raw, output.bytes);
    const file = await stampVideo(raw, path.join(dir, `candidate-${c.id}.mp4`), c.label);
    if ((await readVideoComment(file)) !== c.label) {
      await failCandidate(ctx, c, "the clip couldn't be labelled as generated", cost);
      return "failed";
    }
    const bytes = new Uint8Array(await fs.readFile(file));
    const stored = await store.put(
      renderPath(ctx.profileId, ctx.targetItemId, file),
      bytes,
      "video/mp4",
    );
    // A clip that lands after the owner picked another is kept, as not chosen.
    const [picked] = await db
      .select({ id: mediaCandidates.id })
      .from(mediaCandidates)
      .where(
        and(
          eq(mediaCandidates.generation_id, c.generation_id),
          eq(mediaCandidates.status, "chosen"),
        ),
      )
      .limit(1);
    const [row] = await db
      .update(mediaCandidates)
      .set({
        status: picked ? "not_chosen" : "ready",
        model: output.model,
        request_id: output.request_id ?? c.request_id,
        media_url: stored.url,
        pathname: stored.pathname,
        bytes: stored.bytes,
        cost_minor: cost,
        waiting: null,
        lease_until: null,
        finished_at: nowIso,
      })
      .where(and(eq(mediaCandidates.id, c.id), eq(mediaCandidates.status, "generating")))
      .returning({ id: mediaCandidates.id });
    if (row) costLine(ctx, c, cost, "ready", output.model);
    return "ready";
  };

  const touched = new Set<string>();
  await fs.mkdir(dir, { recursive: true });
  try {
    for (const c of rows) {
      touched.add(c.generation_id);
      if (Date.now() - started > limits.budget_ms) {
        await release(c.id);
        out.left += 1;
        continue;
      }
      try {
        const step = await collectOne(c);
        out[step] += 1;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "media_candidate_collect_error",
            candidate_id: c.id,
            generation_id: c.generation_id,
            ...logSafeError(error),
          }),
        );
        await release(c.id);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // Bring every touched set's hold down, and settle the ones that are done.
  for (const g of touched) {
    await rehold(g);
    if (await settleSet(g, now)) out.sets_settled += 1;
  }
  // A set whose run stopped before settling (every candidate over, the set still "generating").
  const stranded = await db
    .select({ id: mediaGenerations.id })
    .from(mediaGenerations)
    .where(
      and(
        eq(mediaGenerations.status, "generating"),
        ...(args.profileId ? [eq(mediaGenerations.profile_id, args.profileId)] : []),
        sql`EXISTS (SELECT 1 FROM media_candidates mc WHERE mc.generation_id = ${mediaGenerations.id})`,
        sql`NOT EXISTS (SELECT 1 FROM media_candidates mc WHERE mc.generation_id = ${mediaGenerations.id} AND mc.status = 'generating')`,
      ),
    )
    .limit(limits.candidates);
  for (const g of stranded) {
    if (touched.has(g.id)) continue;
    await rehold(g.id);
    if (await settleSet(g.id, now)) out.sets_settled += 1;
  }
  console.log(JSON.stringify({ event: "media_candidates_collected", ...out }));
  return out;
}

/** How many candidates of this business are still being made (the studio polls while any are). */
export async function pendingCandidates(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<string>`count(*)` })
    .from(mediaCandidates)
    .where(
      and(eq(mediaCandidates.profile_id, profileId), eq(mediaCandidates.status, "generating")),
    );
  return Number(row?.n ?? 0);
}

/* ── 3. the owner picks one ── */

export interface PickOutcome {
  candidate_id: string;
  item_id: string;
  publish_proposed: boolean;
  note: string;
}

export async function pickCandidate(args: {
  profileId: string;
  candidateId: string;
  userId: string | null;
  store?: MediaStore;
  now?: Date;
  limitLlm?: LimitLlm;
}): Promise<PickOutcome> {
  const now = args.now ?? new Date();
  if (!/^[0-9a-f-]{36}$/i.test(args.candidateId)) throw new ContentError("no such candidate", 404);
  const [c] = await db
    .select()
    .from(mediaCandidates)
    .where(
      and(eq(mediaCandidates.id, args.candidateId), eq(mediaCandidates.profile_id, args.profileId)),
    );
  if (!c) throw new ContentError("no such candidate", 404);
  if (c.status === "chosen") throw new ContentError("you've already picked this one", 409);
  if (c.status !== "ready" || !c.media_url) {
    throw new ContentError(
      c.status === "not_chosen"
        ? "you picked another clip from this set"
        : `this candidate is ${c.status}, so it can't be picked`,
      409,
    );
  }
  const store = args.store ?? configuredMediaStore();
  if (!store?.get) throw new ContentError("media storage isn't set up on this server", 503);
  const target = await ownedItem(args.profileId, c.target_item_id);
  const refusal = await generationRefusal(target);
  if (refusal) throw new ContentError(`It wasn't placed: ${refusal}.`, 409);

  // The pick, held by the database: one chosen per set.
  try {
    const [claimed] = await db
      .update(mediaCandidates)
      .set({ status: "chosen", chosen_at: now.toISOString(), chosen_by: args.userId })
      .where(and(eq(mediaCandidates.id, c.id), eq(mediaCandidates.status, "ready")))
      .returning({ id: mediaCandidates.id });
    if (!claimed) throw new ContentError("this candidate changed while you looked: reload", 409);
  } catch (error) {
    if (
      /media_candidates_one_chosen_uq/.test(String((error as { cause?: unknown }).cause ?? error))
    ) {
      throw new ContentError("you've already picked a clip from this set", 409);
    }
    throw error;
  }

  const dir = path.join(os.tmpdir(), `syb-pick-${randomBytes(8).toString("hex")}`);
  let itemId: string;
  let proposed: boolean;
  try {
    const bytes = await store.get(c.media_url, CANDIDATE_MAX_BYTES);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "chosen.mp4");
    await fs.writeFile(file, bytes);
    // Rule 33 again: the stored file still says what it is, or it isn't placed.
    if ((await readVideoComment(file)) !== c.label) {
      throw new ContentError("the stored clip has lost its AI label, so it wasn't placed", 409);
    }
    const placed = await placeMedia({
      target,
      file,
      source: {
        kind: "generated",
        media: "video",
        generation_id: c.generation_id,
        proposal_id: c.proposal_id,
        provider: c.provider,
        model: c.model ?? c.provider,
        cost: money(c.cost_minor ?? 0, c.currency),
        prompt_sha256: c.prompt_sha256,
      },
      store,
      ...(args.limitLlm ? { limitLlm: args.limitLlm } : {}),
      now,
    });
    itemId = placed.item.id;
    proposed = placed.publishing.created.length > 0;
    // §10.6: the item's labelling record, from the stamp read back above.
    const [fresh] = await db
      .select({ media_path: contentItems.media_path })
      .from(contentItems)
      .where(eq(contentItems.id, itemId));
    await recordLabelling({
      profileId: args.profileId,
      mediaUrl: fresh?.media_path ?? c.media_url ?? "",
      label: c.label,
      media: "video",
      contentItemId: itemId,
      generationId: c.generation_id,
      candidateId: c.id,
      at: now,
    });
  } catch (error) {
    // Not placed: the pick is undone, so the owner can try again.
    await db
      .update(mediaCandidates)
      .set({ status: "ready", chosen_at: null, chosen_by: null })
      .where(eq(mediaCandidates.id, c.id));
    throw error;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(mediaCandidates)
      .set({ result_item_id: itemId })
      .where(eq(mediaCandidates.id, c.id));
    // The others are kept — marked, never deleted.
    await tx
      .update(mediaCandidates)
      .set({ status: "not_chosen" })
      .where(
        and(
          eq(mediaCandidates.generation_id, c.generation_id),
          eq(mediaCandidates.status, "ready"),
        ),
      );
    await tx
      .update(mediaGenerations)
      .set({ result_item_id: itemId })
      .where(eq(mediaGenerations.id, c.generation_id));
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "media_pick",
      ref_id: c.id,
      user_id: args.userId,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            candidate_id: c.id,
            generation_id: c.generation_id,
            proposal_id: c.proposal_id,
            ordinal: c.ordinal,
            prompt_sha256: c.prompt_sha256,
            item_id: itemId,
          }),
        )
        .digest("hex"),
    });
  });
  console.log(
    JSON.stringify({
      event: "media_candidate_picked",
      profile_id: args.profileId,
      candidate_id: c.id,
      generation_id: c.generation_id,
      item_id: itemId,
    }),
  );
  return {
    candidate_id: c.id,
    item_id: itemId,
    publish_proposed: proposed,
    note: proposed
      ? "Picked. It's on the video item, labelled as AI-generated, and its publish proposal is in your queue."
      : "Picked. It's on the video item, labelled as AI-generated.",
  };
}

/* ── what the studio shows ── */

export interface CandidateView {
  id: string;
  ordinal: number;
  status: string;
  url: string | null;
  label: string;
  cost: Money | null;
  error: string | null;
  /** Still being made, and why it waits (no FFmpeg here to label it, say), or null. */
  waiting: string | null;
  model: string | null;
  result_item_id: string | null;
}

export interface CandidateSetView {
  generation_id: string;
  proposal_id: string;
  target_item_id: string;
  brief_id: string | null;
  hook_index: number | null;
  created_at: string;
  status: string;
  cost: Money | null;
  chosen_id: string | null;
  /** P6-03 (2026-11-09): how many have arrived — the pick works from the first one. */
  ready: number;
  /** How many are still being made. */
  pending: number;
  candidates: CandidateView[];
}

export interface VideoTargetView {
  item_id: string;
  title: string;
  brief_id: string;
  hook_index: number | null;
  refusal: string | null;
  estimate: Money | null;
  pending_proposal_id: string | null;
  approved_proposal_id: string | null;
  /** The set being made for this item right now (its approved proposal already started), or null. */
  making_generation_id: string | null;
}

export interface StudioVideoView {
  setup: GenerationSetupView;
  month: { cap: Money; spent: Money } | null;
  targets: VideoTargetView[];
  sets: CandidateSetView[];
}

const MAX_TARGETS = 20;
const MAX_SETS = 10;

/** The studio's AI video panel: the shot lists from briefs, and every set of candidates. */
export async function studioVideoView(
  profileId: string,
  setup: GenerationSetup,
  now: Date = new Date(),
): Promise<StudioVideoView> {
  const items = await db
    .select()
    .from(contentItems)
    .where(
      and(
        eq(contentItems.profile_id, profileId),
        eq(contentItems.kind, "shot_list"),
        sql`${contentItems.provenance}->>'brief_id' IS NOT NULL`,
      ),
    )
    .orderBy(desc(contentItems.created_at))
    .limit(MAX_TARGETS);
  const gen = await generationView(profileId, items, setup);
  const targets: VideoTargetView[] = items.map((item) => {
    const ref = briefRefOf(item.provenance);
    const g = gen.items[item.id];
    return {
      item_id: item.id,
      title: item.title,
      brief_id: ref?.brief_id ?? "",
      hook_index: ref?.hook_index ?? null,
      refusal: g?.refusal ?? null,
      estimate: g?.estimates.video ?? null,
      pending_proposal_id: g?.pending_proposal_id ?? null,
      approved_proposal_id: g?.approved_proposal_id ?? null,
      making_generation_id: null,
    };
  });

  const gens = await db
    .select()
    .from(mediaGenerations)
    .where(
      and(
        eq(mediaGenerations.profile_id, profileId),
        sql`EXISTS (SELECT 1 FROM media_candidates mc WHERE mc.generation_id = ${mediaGenerations.id})`,
      ),
    )
    .orderBy(desc(mediaGenerations.created_at))
    .limit(MAX_SETS);
  const cands =
    gens.length === 0
      ? []
      : await db
          .select()
          .from(mediaCandidates)
          .where(
            inArray(
              mediaCandidates.generation_id,
              gens.map((g) => g.id),
            ),
          )
          .orderBy(mediaCandidates.ordinal);
  const sets: CandidateSetView[] = gens.map((g) => {
    const mine = cands.filter((c) => c.generation_id === g.id);
    return {
      generation_id: g.id,
      proposal_id: g.proposal_id,
      target_item_id: g.target_item_id,
      brief_id: mine[0]?.brief_id ?? null,
      hook_index: mine[0]?.hook_index ?? null,
      created_at: new Date(Date.parse(g.created_at)).toISOString(),
      status: g.status,
      cost: g.cost_minor === null ? null : money(g.cost_minor, g.currency),
      chosen_id: mine.find((c) => c.status === "chosen")?.id ?? null,
      ready: mine.filter((c) => ["ready", "chosen", "not_chosen"].includes(c.status)).length,
      pending: mine.filter((c) => c.status === "generating").length,
      candidates: mine.map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        status: c.status,
        url: c.media_url,
        label: c.label,
        cost: c.cost_minor === null ? null : money(c.cost_minor, c.currency),
        error: c.error,
        waiting: c.status === "generating" ? c.waiting : null,
        model: c.model,
        result_item_id: c.result_item_id,
      })),
    };
  });
  // An approved proposal whose set has started isn't offered to start again: its progress shows.
  for (const t of targets) {
    const making = sets.find((s) => s.target_item_id === t.item_id && s.status === "generating");
    if (making) t.making_generation_id = making.generation_id;
    if (t.approved_proposal_id && sets.some((s) => s.proposal_id === t.approved_proposal_id)) {
      t.approved_proposal_id = null;
    }
  }

  let month: StudioVideoView["month"] = null;
  if (setup.caps) {
    const accountId = await accountOf(profileId);
    const r = await capRoom({
      accountId,
      // The month's figure doesn't depend on the item; any id reads it.
      targetItemId: items[0]?.id ?? "00000000-0000-0000-0000-000000000000",
      now,
      caps: setup.caps,
    });
    month = { cap: r.month_cap, spent: r.month_spent };
  }
  return { setup: setupView(setup), month, targets, sets };
}
