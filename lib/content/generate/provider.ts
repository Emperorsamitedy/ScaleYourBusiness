// The media-generation seam — P3-53 (Session K, "real first, AI fallback").
//
// ONE interface every generation provider implements, so the rest of SYB
// never knows which one is on. Today there are two implementations: the
// FAKE (./fake — tests and development, refused in production) and an
// empty, clearly marked adapter SLOT for the real provider (./vendor),
// which is not chosen: build-sequence step 2's quotes are pending, and
// MEDIA_PROVIDER defaults to off.
//
// What every provider must honour, whatever it is:
//   - it is handed FIXED_INSTRUCTION with every request (no real person's
//     likeness, no brand's logo or wordmark, no text posing as a real
//     photo) — the deterministic screen (./guard) has already refused the
//     prompts that ask for those, and this is the second line
//   - it states its price before it runs (estimate) and its charge after
//     (cost), in integer minor units with a currency (rule 1). A failed
//     attempt that was still charged says so (ProviderError.cost)
//   - it returns bytes and a content type, nothing else: labelling the
//     file as generated (./label) and placing it on an item happen after,
//     in SYB's own code, so no provider can skip them

import type { Money } from "../../core/money";

export type GeneratedMedia = "image" | "video";

/** A short clip: long enough for a Reel (3 s minimum), short enough to stay cheap. */
export const GENERATED_CLIP_SECONDS = 5;

/**
 * Sent with every request, verbatim. The guard refuses prompts that ask for
 * these; this tells the provider not to volunteer them either.
 */
export const FIXED_INSTRUCTION = [
  "Make original imagery for a small business's own social media post.",
  "Do not depict any real, identifiable person: no celebrity, public figure, customer or staff member, and no one's likeness or voice.",
  "Do not show any brand's logo, wordmark, trademark, packaging design or mascot, including the business's competitors.",
  "Do not add text that claims the image is a real photograph or real footage.",
  "No sexual, violent or hateful content.",
].join(" ");

export interface GenerationRequest {
  media: GeneratedMedia;
  /** What to make — built from the item and the brief, shown to the owner on the proposal. */
  prompt: string;
  /** FIXED_INSTRUCTION, always. */
  instruction: string;
  /** Video: 9:16 (Reels). Image: 4:5 (the feed's tallest). */
  aspect: "9:16" | "4:5";
  /** Video only. */
  seconds?: number;
  account_id: string;
}

export interface GenerationOutput {
  bytes: Uint8Array;
  content_type: "image/jpeg" | "video/mp4";
  /** What this attempt was charged. */
  cost: Money;
  /** The provider's own model name, for provenance. */
  model: string;
}

export class ProviderError extends Error {
  readonly retryable: boolean;
  /** What a failed attempt was still charged, when the provider charges for failures. */
  readonly cost: Money | null;
  constructor(message: string, opts: { retryable?: boolean; cost?: Money | null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.retryable = opts.retryable ?? false;
    this.cost = opts.cost ?? null;
  }
}

export interface MediaProvider {
  readonly id: string;
  /** Null when usable; otherwise the owner's sentence for why not. */
  readonly unavailable: string | null;
  /** The price of one attempt, before anything runs. */
  estimate(req: { media: GeneratedMedia; seconds?: number }): Money;
  generate(req: GenerationRequest): Promise<GenerationOutput>;
}
