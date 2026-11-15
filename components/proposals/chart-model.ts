// The Decisions screen's charts, as numbers (specs/ux-spec-v1.md §8,
// "Charts on the Decisions screen"). Pure: everything here is worked out
// from what the screen already prints, so a chart never shows a figure
// the words don't.

import { rangeAxis } from "./queue-model";

/** A change line's words, before and after: how many stayed, came in, went out. */
export interface WordChange {
  before: number;
  after: number;
  kept: number;
  added: number;
  removed: number;
}

const words = (s: string): string[] => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/**
 * Word-level diff by longest common subsequence: kept words are the ones
 * both sides share in order. Null when either side is not a sentence
 * (fewer than three words with letters in them) — a figure like
 * "€34.00 → €36.72" has no words to count, and its chart would say nothing.
 */
export function wordChange(beforeText: string, afterText: string): WordChange | null {
  const a = words(beforeText.replace(/^→\s*/, ""));
  const b = words(afterText.replace(/^→\s*/, ""));
  const lettered = (ws: string[]) => ws.filter((x) => /\p{L}/u.test(x)).length;
  if (lettered(a) < 3 || lettered(b) < 3) return null;
  const norm = (w: string) => w.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      const down = dp[i + 1] as number[];
      row[j] =
        norm(a[i] as string) === norm(b[j] as string)
          ? (down[j + 1] as number) + 1
          : Math.max(down[j] as number, row[j + 1] as number);
    }
  }
  const kept = (dp[0] as number[])[0] as number;
  return { before: m, after: n, kept, added: n - kept, removed: m - kept };
}

/** Evidence lines counted by basis, in the order the legend prints them. */
export function basisCounts<B extends string>(
  bases: readonly B[],
  lines: readonly { basis: string }[],
): { basis: B | "NOT RECORDED"; count: number }[] {
  const order: (B | "NOT RECORDED")[] = [...bases, "NOT RECORDED"];
  return order
    .map((basis) => ({ basis, count: lines.filter((l) => l.basis === basis).length }))
    .filter((c) => c.count > 0 || (bases as readonly string[]).includes(c.basis));
}

/** One shared top for every waiting item's value bar, so the longest bar is the biggest decision. */
export function valueScaleTop(highs: readonly number[]): number | null {
  const top = Math.max(0, ...highs);
  if (top <= 0) return null;
  const axis = rangeAxis(0, top);
  return axis.scale[1];
}

/** Where a value sits on a 0…top bar, in percent, held inside the bar. */
export function pct(value: number, top: number): number {
  if (top <= 0) return 0;
  return Math.max(0, Math.min(100, (value / top) * 100));
}
