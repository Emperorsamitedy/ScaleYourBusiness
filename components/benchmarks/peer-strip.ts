// The peers' middle half as a strip (components/sheet/RangeBar), with the
// reader's own figure ticked on it — the v1 build spec §5.3, drawn. Pure:
// only where the strip starts and ends. Peer figures only; a Eurostat
// figure never goes on it (§5.4).

export interface PeerStrip {
  scale: readonly [number, number];
  band: readonly [number, number];
}

/** The quartiles and the reader's figure, padded a tenth of their span; null when there is nothing to place. */
export function peerStrip(p25: unknown, p75: unknown, own: unknown): PeerStrip | null {
  if (typeof p25 !== "number" || typeof p75 !== "number" || typeof own !== "number") return null;
  if (![p25, p75, own].every(Number.isFinite) || p25 > p75) return null;
  const lo = Math.min(p25, own);
  const hi = Math.max(p75, own);
  if (hi === lo) return null;
  const pad = (hi - lo) / 10;
  return { scale: [lo - pad, hi + pad], band: [p25, p75] };
}
