// The text-width range bar — ux-spec §2 "Figures". The ok band is a
// tint, the value is an ink tick, and a dashed hairline marks where
// slight drift becomes "act now". Decorative to assistive tech: the row
// it sits in already states value, range and flag in words.

export interface RangeBarProps {
  /** The visible scale, low to high. */
  scale: readonly [number, number];
  value: number | null;
  /** The reference / goal range. */
  band: readonly [number, number] | null;
  /** Past here the flag becomes ACT NOW. */
  actAt?: number | null;
}

const pct = (v: number, [lo, hi]: readonly [number, number]) =>
  `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)).toFixed(2)}%`;

export function RangeBar({ scale, value, band, actAt }: RangeBarProps) {
  return (
    <span className="rbar" aria-hidden="true">
      {band && (
        <span
          className="rbar-band"
          style={{
            left: pct(band[0], scale),
            width: `calc(${pct(band[1], scale)} - ${pct(band[0], scale)})`,
          }}
        />
      )}
      {actAt != null && <span className="rbar-act" style={{ left: pct(actAt, scale) }} />}
      {value != null && <span className="rbar-tick" style={{ left: pct(value, scale) }} />}
    </span>
  );
}
