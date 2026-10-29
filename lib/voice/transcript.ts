// Idea 50: what the browser heard, merged into what the owner already typed.
//
// Pure text work, no browser in it. A listening session starts from the
// box's text as the owner left it (the base) and only ever appends to it:
// spoken words go after the typed ones with a space where one is needed,
// a capital where a sentence starts, and never a change to a typed letter.
// The browser's interim guesses show while the owner talks and are
// replaced by its final words as they settle; both count from the same
// base, so a guess that changes never leaves a stale copy behind.

/** One recognised stretch, as the Web Speech API reports it (first alternative only). */
export interface ResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string } | undefined;
}

export interface ResultListLike {
  readonly length: number;
  readonly [index: number]: ResultLike | undefined;
}

/** The session's words so far, settled and still-changing, in the order spoken. */
export interface Spoken {
  final: string[];
  interim: string[];
}

const SENTENCE_END = /(?:[.!?…]["'”’)]*\s*|\n\s*)$/u;
const LEADING_PUNCT = /^[,.;:!?…)\]”’]/u;

/** A capital on the first letter, when the piece opens with a letter. Never lowercases. */
function capitalise(piece: string): string {
  return piece.replace(/^([^\p{L}\p{N}]*)(\p{L})/u, (_, lead: string, c: string) => {
    return lead + c.toLocaleUpperCase();
  });
}

/**
 * Appends one spoken piece to the text before it. The text before is kept
 * exactly as it stands; only a joining space and a sentence-start capital
 * are added. Empty or blank speech changes nothing.
 */
export function joinSpoken(before: string, spoken: string): string {
  const piece = spoken.replace(/\s+/gu, " ").trim();
  if (piece === "") return before;
  const startsSentence = before.trim() === "" || SENTENCE_END.test(before);
  const word = startsSentence ? capitalise(piece) : piece;
  const sep = before === "" || /\s$/u.test(before) || LEADING_PUNCT.test(word) ? "" : " ";
  return before + sep + word;
}

/** Reads a result list into settled and still-changing words. */
export function spokenOf(results: ResultListLike): Spoken {
  const out: Spoken = { final: [], interim: [] };
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const text = r?.[0]?.transcript ?? "";
    if (!r || text.trim() === "") continue;
    (r.isFinal ? out.final : out.interim).push(text);
  }
  return out;
}

/** The box's text: the base, then everything heard so far, settled words first. */
export function mergeSpoken(base: string, spoken: Spoken): string {
  return [...spoken.final, ...spoken.interim].reduce(joinSpoken, base);
}
