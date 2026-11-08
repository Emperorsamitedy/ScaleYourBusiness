// What an AI video is asked to show — P6-03, rule 33.
//
// "The prompt is built from profile facts with their provenance, never
// from free text a customer typed." So the words sent to the provider come
// from exactly two places, and nowhere else:
//
//   1. the business's own profile facts — current field records, answered
//      or inferred, from a short list of keys (what it sells, its best
//      seller, its promise, the feeling it wants, who its customers are,
//      its tone, what sets it apart), each from a source the owner stands
//      behind (the interview, the conversation with SYB, a document, a
//      connector, or an inference that names what it came from). Each one
//      used is recorded with its field record id, status, source and date.
//   2. the creative brief's hook the item was made from — the brief
//      pipeline's own output, where every claim cites its sources (P3-51).
//
// There is no free-text parameter. A customer's message, a review, a
// support thread or a typed "direction" cannot reach these prompts: the
// builder is pure over (facts, hook), and the reader reads field_records
// only. The likeness and brand screen (./generate/guard) still runs on
// every prompt after, and the provider gets FIXED_INSTRUCTION with each.
//
// Three prompts per brief, one per shot angle, so the three candidates
// differ in something the owner can choose between. Each asks for
// photorealistic, phone-like footage: the most real-looking result the
// model offers, never a cartoon or a "cinematic" look that reads as an ad.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { factWords } from "../bank/fact-words";
import { ENGLISH_WORDS } from "../bank/words";
import { repr } from "../profile/factsheet";
import { GENERATED_CLIP_SECONDS } from "./generate/provider";

/** The profile facts an AI video may rest on, in the order the prompt uses them. */
export const VIDEO_FACT_KEYS: readonly string[] = [
  "identity.sells",
  "identity.business_type",
  "identity.description",
  "marketing.brand.main_promise",
  "marketing.brand.desired_feeling",
  "customers.type",
  "presence.brand_tone",
  "positioning.differentiator",
];

/** The best seller is a pointer to an offer; these of its attributes are read. */
export const BEST_SELLER_KEY = "offers.best_seller_id";
export const BEST_SELLER_ATTRS: readonly string[] = ["name", "description"];

/**
 * Sources the owner stands behind. Left out: a system default (not a fact
 * about the business) and web research (other people's words on the web).
 */
export const VIDEO_FACT_SOURCES: readonly string[] = [
  "owner_input",
  "conversation",
  "document",
  "connector",
  "inferred",
];

/** One fact as the prompt used it, with its provenance (rule 2). */
export interface VideoFact {
  key: string;
  /** The fact in words: a vocabulary code as its label, owner text as it was given. */
  value: string;
  record_id: string;
  status: "answered" | "inferred";
  source_kind: string;
  recorded_at: string;
}

/** The brief's hook the item was made from, and what it cites. */
export interface VideoHook {
  brief_id: string;
  hook_index: number;
  hook: string;
  cites: string[];
}

/** Candidates per brief (rule 33). */
export const CANDIDATES_PER_BRIEF = 3;

/** One shot angle per candidate: real places and things, hands at most, no faces. */
export const SHOT_ANGLES: readonly string[] = [
  "a slow close-up of what the business sells, showing its real textures in natural light",
  "what the business sells being used or served in its real setting, seen over the shoulder, hands only, no faces",
  "a slow, steady shot of the place where it is made or sold, with no one facing the camera",
];

const FACT_MAX = 220;
/** The words before the fixed instruction; Kling takes 2,500 characters in all. */
export const VIDEO_PROMPT_MAX = 1_800;

/** Pure: a fact's words, clean of links, handles and hashtags, and short. */
export function cleanFact(text: string, max = FACT_MAX): string {
  const t = text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(^|\s)[#@][\p{L}\p{N}_.]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;:,]+$/, "");
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const LINES: Readonly<Record<string, string>> = {
  "identity.sells": "What the business sells: {v}.",
  "identity.business_type": "Kind of business: {v}.",
  "identity.description": "In the owner's words: {v}.",
  "marketing.brand.main_promise": "Its promise to customers: {v}.",
  "marketing.brand.desired_feeling": "The feeling the footage should leave: {v}.",
  "customers.type": "Its customers: {v}.",
  "presence.brand_tone": "Its tone: {v}.",
  "positioning.differentiator": "What sets it apart: {v}.",
};

/**
 * Pure: the three prompts, one per shot angle. Only facts with an allowed
 * key and source are used; it refuses (returns null) when nothing says
 * what the business sells — there would be nothing true to film.
 */
export function buildVideoPrompts(args: {
  facts: readonly VideoFact[];
  hook: Pick<VideoHook, "hook"> | null;
  seconds?: number;
}): string[] | null {
  const usable = args.facts.filter(
    (f) =>
      VIDEO_FACT_SOURCES.includes(f.source_kind) &&
      (VIDEO_FACT_KEYS.includes(f.key) || isBestSellerAttr(f.key)) &&
      cleanFact(f.value) !== "",
  );
  const subject = usable.some(
    (f) =>
      f.key === "identity.sells" || f.key === "identity.description" || isBestSellerAttr(f.key),
  );
  if (!subject) return null;

  const seconds = args.seconds ?? GENERATED_CLIP_SECONDS;
  const lines: string[] = [];
  const best = usable.filter((f) => isBestSellerAttr(f.key));
  for (const key of VIDEO_FACT_KEYS) {
    const f = usable.find((x) => x.key === key);
    if (f) lines.push(LINES[key]!.replace("{v}", cleanFact(f.value)));
    if (key === "identity.sells" && best.length > 0) {
      const name = best.find((x) => x.key.endsWith(".name"));
      const desc = best.find((x) => x.key.endsWith(".description"));
      lines.push(
        `Its best seller: ${[name, desc]
          .filter((x): x is VideoFact => x !== undefined)
          .map((x) => cleanFact(x.value))
          .join(" — ")}.`,
      );
    }
  }
  const hook = args.hook ? cleanFact(args.hook.hook, 200) : "";
  if (hook) lines.push(`The idea, from the business's creative brief: ${hook}.`);

  return SHOT_ANGLES.map((angle) => {
    const prompt = [
      `Photorealistic, true-to-life footage, as if filmed on a modern phone: natural light, real materials, gentle handheld movement, one continuous shot, vertical 9:16, ${seconds} seconds. No on-screen text or captions. Not animated, not illustrated.`,
      `The shot: ${angle}.`,
      ...lines,
    ]
      .join(" ")
      .replace(/\.\.+/g, ".");
    return prompt.length > VIDEO_PROMPT_MAX ? `${prompt.slice(0, VIDEO_PROMPT_MAX - 1)}…` : prompt;
  });
}

function isBestSellerAttr(key: string): boolean {
  const parts = key.split(".");
  return parts.length === 3 && parts[0] === "offers" && BEST_SELLER_ATTRS.includes(parts[2] ?? "");
}

const ENGLISH_FACTS = factWords(ENGLISH_WORDS);

/** A fact's value in words: a vocabulary code as the interview's label, anything else as given. */
function wordsFor(key: string, value: unknown): string | null {
  return ENGLISH_FACTS.value(key, value) ?? repr(value);
}

/** The offer id the best-seller fact points at, or null. */
function offerIdOf(value: unknown): string | null {
  const v =
    typeof value === "string"
      ? value
      : typeof (value as { code?: unknown } | null)?.code === "string"
        ? (value as { code: string }).code
        : null;
  return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

/** The business's current facts for a video, each with its provenance. Reads field_records only. */
export async function readVideoFacts(profileId: string): Promise<VideoFact[]> {
  const current = and(
    eq(fieldRecords.profile_id, profileId),
    isNull(fieldRecords.superseded_at),
    inArray(fieldRecords.status, ["answered", "inferred"]),
  );
  const rows = await db
    .select()
    .from(fieldRecords)
    .where(and(current, inArray(fieldRecords.field_key, [...VIDEO_FACT_KEYS, BEST_SELLER_KEY])));
  const best = rows.find((r) => r.field_key === BEST_SELLER_KEY);
  const offerId = best && sourceAllowed(best.source) ? offerIdOf(best.value) : null;
  const offerRows = offerId
    ? await db
        .select()
        .from(fieldRecords)
        .where(
          and(
            current,
            inArray(
              fieldRecords.field_key,
              BEST_SELLER_ATTRS.map((a) => `offers.${offerId}.${a}`),
            ),
          ),
        )
    : [];
  const out: VideoFact[] = [];
  for (const r of [...rows, ...offerRows]) {
    if (r.field_key === BEST_SELLER_KEY || !sourceAllowed(r.source)) continue;
    const value = wordsFor(r.field_key, r.value);
    if (value === null || value.trim() === "") continue;
    out.push({
      key: r.field_key,
      value,
      record_id: r.id,
      status: r.status as "answered" | "inferred",
      source_kind: (r.source as { kind: string }).kind,
      recorded_at: new Date(Date.parse(r.recorded_at)).toISOString(),
    });
  }
  return out;
}

function sourceAllowed(source: unknown): boolean {
  const kind = (source as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && VIDEO_FACT_SOURCES.includes(kind);
}
