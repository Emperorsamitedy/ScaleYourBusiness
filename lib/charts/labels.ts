// Labels down the side of a chart, kept apart. Pure.
//
// A chart that names its last values at the right edge (the cash chart: the
// hopeful end, the cautious end, the buffer) can have two of them a few
// pixels apart, and then neither can be read. `spreadLabels` keeps their
// order, moves them the least it can so each has `gap` of room, and keeps
// them inside the plot.

export interface SideLabel<K extends string = string> {
  key: K;
  /** Where the value sits on the plot. */
  y: number;
}

/** The same labels, in their original order, with a `y` no closer than `gap` to its neighbour. */
export function spreadLabels<T extends SideLabel>(
  labels: readonly T[],
  top: number,
  bottom: number,
  gap: number,
): T[] {
  const byY = labels.map((l, i) => ({ l, i })).sort((a, b) => a.l.y - b.l.y || a.i - b.i);
  const ys: number[] = [];
  for (const [k, { l }] of byY.entries()) {
    const want = Math.max(top, l.y);
    ys.push(k === 0 ? want : Math.max(want, ys[k - 1]! + gap));
  }
  // Pushed past the bottom: walk back up, keeping the gap.
  for (let k = ys.length - 1; k >= 0; k--) {
    const cap = k === ys.length - 1 ? bottom : ys[k + 1]! - gap;
    if (ys[k]! > cap) ys[k] = cap;
  }
  const out = labels.map((l) => ({ ...l }));
  for (const [k, { i }] of byY.entries()) out[i]!.y = ys[k]!;
  return out;
}
