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
//      run per proposal, ever), and the three are made side by side, each
//      with at most MAX_GENERATION_ATTEMPTS attempts and the caps re-checked
//      before every retry. Each finished clip is labelled in the file
//      (rule 33 — before it is stored anywhere), stored through the media
//      store (Vercel Blob in production), and kept as a candidate row with
//      its own cost line, tagged by workload (rule 34).
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
import { contentItems, decisionLog, mediaCandidates, mediaGenerations } from "../../db/schema";
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
import { readVideoComment, stampVideo } from "./generate/label";
import type { MediaProvider } from "./generate/provider";
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
  generationView,
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
/** A stored candidate read back for placing: refused past this. */
export const CANDIDATE_MAX_BYTES = 150 * 1024 * 1024;

export const DIRECTION_REFUSED =
  "An AI video's words come from your profile facts and the creative brief, not from typed directions — change those facts, or film it yourself";
export const NEEDS_BRIEF =
  "AI video is made from a creative brief's hook: make this shot list from a brief in the studio first";
export const NEEDS_FACTS =
  "SYB doesn't know yet what the business sells, so there is nothing true to film — answer that in the interview first";

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
        `SYB won't propose that: ${verdict.reason} ("${verdict.matched}"), from your profile facts or the brief. Change that fact, or film it.`,
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
  if (over) throw new ContentError(`SYB won't propose that: ${over}`, 409);

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
      summary: `Generate ${n} AI video candidates (${seconds} seconds each) for "${item.title}" — about ${cost} in all; you pick one, because there's no footage for it`,
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

/* ── 2. generating, once approved ── */

interface CandidateDetail {
  target_item_id?: unknown;
  candidates?: unknown;
  seconds?: unknown;
  prompts?: unknown;
  prompt_sha256?: unknown;
  brief?: { brief_id?: unknown; hook_index?: unknown };
}

interface CandidateRun {
  id: string;
  ordinal: number;
  prompt: string;
  charged: number;
  inflight: boolean;
  attempts: number;
  status: "ready" | "failed";
  error: string | null;
}

export async function generateCandidatesFromProposal(args: {
  proposal: ProposalRow;
  setup: GenerationSetup;
  store?: MediaStore;
  now: Date;
}): Promise<GenerationOutcome> {
  const { proposal, setup, now } = args;
  const d = ((proposal.action as { detail?: CandidateDetail }).detail ?? {}) as CandidateDetail;
  const prompts = Array.isArray(d.prompts)
    ? d.prompts.filter((p): p is string => typeof p === "string")
    : [];
  if (
    typeof d.target_item_id !== "string" ||
    prompts.length === 0 ||
    prompts.length !== d.candidates ||
    prompts.length > 3
  ) {
    throw new ContentError("the proposal doesn't say what to generate", 422);
  }
  if (d.prompt_sha256 !== promptsHash(prompts)) {
    throw new ContentError("the prompts aren't the ones you approved — nothing was generated", 409);
  }
  const seconds = GENERATED_CLIP_SECONDS;
  if (!setup.provider) {
    throw new ContentError(`${setup.reason ?? GENERATION_OFF} It stays approved.`, 503);
  }
  const provider = setup.provider;
  const store = args.store ?? configuredMediaStore();
  if (!store) {
    throw new ContentError("media storage isn't set up on this server. It stays approved.", 503);
  }
  const caps = capsOf(setup);
  const accountId = await accountOf(proposal.profile_id);
  const target = await ownedItem(proposal.profile_id, d.target_item_id);
  const zero = money(0, caps.currency);

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
  const room = await capRoom({ accountId, targetItemId: target.id, now, caps });
  const setPrice = money(each.amount_minor * prompts.length, each.currency);
  const over = capRefusal(room, setPrice);
  if (over) throw new ContentError(`Nothing was generated: ${over}. It stays approved.`, 409);

  // The claim: one run per approved proposal, ever.
  let claimId: string;
  try {
    const [claim] = await db
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
        created_at: now.toISOString(),
      })
      .returning({ id: mediaGenerations.id });
    claimId = claim!.id;
  } catch (error) {
    if (
      /media_generations_proposal_uq/.test(String((error as { cause?: unknown }).cause ?? error))
    ) {
      throw new ContentError("this has already been generated, or is being generated now", 409);
    }
    throw error;
  }

  const label = mediaDisclosureLabel("video", "generated_video");
  const briefId = typeof d.brief?.brief_id === "string" ? d.brief.brief_id : null;
  const hookIndex = Number.isInteger(d.brief?.hook_index) ? (d.brief!.hook_index as number) : null;
  // Rule 33: the label is on the row from the moment the candidate exists.
  const rows = await db
    .insert(mediaCandidates)
    .values(
      prompts.map((prompt, i) => ({
        generation_id: claimId,
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
      })),
    )
    .returning({ id: mediaCandidates.id, ordinal: mediaCandidates.ordinal });
  const runs: CandidateRun[] = rows
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      prompt: prompts[r.ordinal - 1]!,
      charged: 0,
      inflight: false,
      attempts: 0,
      status: "failed",
      error: null,
    }));

  // The budget, shared by the three: what is charged plus what is in flight.
  const committed = () =>
    runs.reduce((sum, r) => sum + r.charged + (r.inflight ? each.amount_minor : 0), 0);
  const roomFor = (): string | null =>
    capRefusal(
      {
        ...room,
        item_spent: money(room.item_spent.amount_minor + committed(), caps.currency),
        month_spent: money(room.month_spent.amount_minor + committed(), caps.currency),
      },
      each,
    );

  const dir = path.join(os.tmpdir(), `syb-candidates-${randomBytes(8).toString("hex")}`);
  await fs.mkdir(dir, { recursive: true });

  const runOne = async (run: CandidateRun): Promise<void> => {
    const fail = async (sentence: string) => {
      run.status = "failed";
      run.error = sentence;
      await db
        .update(mediaCandidates)
        .set({
          status: "failed",
          error: sentence,
          cost_minor: run.charged,
          attempts: run.attempts,
          finished_at: new Date().toISOString(),
        })
        .where(eq(mediaCandidates.id, run.id));
    };
    let output: Awaited<ReturnType<MediaProvider["generate"]>> | null = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const stop = roomFor();
        if (stop) return fail(`a retry ${stop}`);
      }
      run.attempts = attempt;
      run.inflight = true;
      await db
        .update(mediaCandidates)
        .set({ attempts: attempt })
        .where(eq(mediaCandidates.id, run.id));
      try {
        output = await provider.generate({
          media: "video",
          prompt: run.prompt,
          instruction: FIXED_INSTRUCTION,
          aspect: "9:16",
          seconds,
          account_id: accountId,
          idempotency_key: `syb-${claimId}-${run.ordinal}-${attempt}`,
        });
        run.inflight = false;
        if (output.cost.currency !== caps.currency) {
          return fail(`the provider charged in ${output.cost.currency}, not ${caps.currency}`);
        }
        run.charged += output.cost.amount_minor;
        break;
      } catch (error) {
        run.inflight = false;
        if (!(error instanceof ProviderError)) throw error;
        if (error.cost && error.cost.currency === caps.currency) {
          run.charged += error.cost.amount_minor;
        }
        if (!error.retryable || attempt === MAX_GENERATION_ATTEMPTS) return fail(error.message);
        output = null;
      }
    }
    if (!output) return fail("the provider returned nothing");
    if (output.content_type !== "video/mp4" || output.bytes.byteLength === 0) {
      return fail(`the provider returned ${output.content_type}, not video/mp4`);
    }

    // Rule 33, in the file: stamped and read back before it is stored anywhere.
    const raw = path.join(dir, `raw-${run.ordinal}.mp4`);
    await fs.writeFile(raw, output.bytes);
    const file = await stampVideo(raw, path.join(dir, `candidate-${run.ordinal}.mp4`), label);
    if ((await readVideoComment(file)) !== label) {
      return fail("the clip couldn't be labelled as generated");
    }
    const bytes = new Uint8Array(await fs.readFile(file));
    const stored = await store.put(
      renderPath(proposal.profile_id, target.id, file),
      bytes,
      "video/mp4",
    );
    run.status = "ready";
    await db
      .update(mediaCandidates)
      .set({
        status: "ready",
        model: output.model,
        request_id: output.request_id ?? null,
        media_url: stored.url,
        pathname: stored.pathname,
        bytes: stored.bytes,
        cost_minor: run.charged,
        attempts: run.attempts,
        finished_at: new Date().toISOString(),
      })
      .where(eq(mediaCandidates.id, run.id));
    // Rule 34: one cost line per candidate, tagged by workload.
    console.log(
      JSON.stringify({
        event: "media_generation_cost",
        workload: AI_VIDEO_WORKLOAD,
        account_id: accountId,
        generation_id: claimId,
        candidate_id: run.id,
        ordinal: run.ordinal,
        provider: provider.id,
        model: output.model,
        request_id: output.request_id ?? null,
        cost_minor: run.charged,
        currency: caps.currency,
        status: "ready",
      }),
    );
  };

  try {
    await Promise.all(
      runs.map(async (run) => {
        try {
          await runOne(run);
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "media_candidate_error",
              account_id: accountId,
              generation_id: claimId,
              candidate_id: run.id,
              ...logSafeError(error),
            }),
          );
          await db
            .update(mediaCandidates)
            .set({
              status: "failed",
              error:
                error instanceof ContentError ? error.message : "something went wrong on our side",
              cost_minor: run.charged,
              attempts: run.attempts,
              finished_at: new Date().toISOString(),
            })
            .where(and(eq(mediaCandidates.id, run.id), eq(mediaCandidates.status, "generating")));
          run.status = "failed";
          run.error ??= "something went wrong on our side";
        }
        if (run.status === "failed") {
          console.log(
            JSON.stringify({
              event: "media_generation_cost",
              workload: AI_VIDEO_WORKLOAD,
              account_id: accountId,
              generation_id: claimId,
              candidate_id: run.id,
              ordinal: run.ordinal,
              provider: provider.id,
              cost_minor: run.charged,
              currency: caps.currency,
              status: "failed",
            }),
          );
        }
      }),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  const charged = runs.reduce((s, r) => s + r.charged, 0);
  const cost = money(charged, caps.currency);
  const ready = runs.filter((r) => r.status === "ready");
  const firstError = runs.find((r) => r.error)?.error ?? null;
  await db
    .update(mediaGenerations)
    .set({
      status: ready.length > 0 ? "generated" : "failed",
      cost_minor: charged,
      attempts: Math.max(...runs.map((r) => r.attempts)),
      finished_at: new Date().toISOString(),
      ...(ready.length === 0 ? { error: firstError ?? "nothing was made" } : {}),
    })
    .where(eq(mediaGenerations.id, claimId));
  await recordExecution({
    proposalId: proposal.id,
    result: {
      generated: ready.length > 0,
      candidates: runs.map((r) => ({ id: r.id, ordinal: r.ordinal, status: r.status })),
      cost,
    },
  });
  if (ready.length === 0) {
    return {
      status: "failed",
      cost,
      candidate_ids: runs.map((r) => r.id),
      note: `Generating failed: ${firstError ?? "nothing was made"}. ${format(cost)} was charged.`,
    };
  }
  return {
    status: "generated",
    cost,
    candidate_ids: ready.map((r) => r.id),
    note: `${ready.length} of ${runs.length} AI video candidates are ready for ${format(cost)}, each labelled as AI-generated. Pick one in the studio; nothing is published without your yes.`,
  };
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
    if (!claimed) throw new ContentError("this candidate changed while you looked — reload", 409);
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
      candidates: mine.map((c) => ({
        id: c.id,
        ordinal: c.ordinal,
        status: c.status,
        url: c.media_url,
        label: c.label,
        cost: c.cost_minor === null ? null : money(c.cost_minor, c.currency),
        error: c.error,
        model: c.model,
        result_item_id: c.result_item_id,
      })),
    };
  });

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
