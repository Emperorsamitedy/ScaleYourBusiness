// "Nothing copies another business's wording" — P3-51, as a check, not a
// promise. Deterministic: a written text is refused when it shares
// OVERLAP_RULES.n words in a row with any of the niche's ads (their bodies
// and headlines). Learning from what works is the point; lifting another
// business's sentence is not, and a five-word run is where shared phrasing
// stops being a coincidence of the language.
//
// Words are compared lower-cased, accents and punctuation removed, so a
// changed comma or capital doesn't launder a copied line.

export const OVERLAP_RULES = {
  /** Words in a row that count as copying. */
  n: 5,
} as const;

/** Pure: a text's words, normalised for comparison. */
export function overlapWords(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

function grams(words: readonly string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= words.length; i += 1) out.push(words.slice(i, i + n).join(" "));
  return out;
}

/** The n-grams of every text another business wrote — built once per brief. */
export function borrowedIndex(
  texts: readonly { ref: string; text: string }[],
  n: number = OVERLAP_RULES.n,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const t of texts) {
    for (const g of grams(overlapWords(t.text), n)) if (!index.has(g)) index.set(g, t.ref);
  }
  return index;
}

export interface Borrowing {
  /** The shared run of words, as compared. */
  phrase: string;
  /** Whose text it is in: the ad's reference. */
  ref: string;
}

/** Pure: every run of n words `text` shares with the index, merged into the longest phrases. */
export function findBorrowings(
  text: string,
  index: ReadonlyMap<string, string>,
  n: number = OVERLAP_RULES.n,
): Borrowing[] {
  const words = overlapWords(text);
  const hits: Borrowing[] = [];
  let i = 0;
  while (i + n <= words.length) {
    const g = words.slice(i, i + n).join(" ");
    const ref = index.get(g);
    if (!ref) {
      i += 1;
      continue;
    }
    let end = i + n;
    while (end < words.length && index.has(words.slice(end - n + 1, end + 1).join(" "))) end += 1;
    hits.push({ phrase: words.slice(i, end).join(" "), ref });
    i = end;
  }
  return hits;
}
