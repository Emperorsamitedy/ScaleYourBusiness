// The ScaleX mark and wordmark (brand concept A, "Ascent", 2026-11-15).
// The mark is an X: two short rounded Ink bars on one diagonal, crossed by
// an Accent arrow rising to the upper right. On a dark ground the bars turn
// white. One geometry, drawn on a 100-unit square, serves the rail, the app
// icons (components/sheet/AppIcon.tsx) and the favicon.

export const BRAND = {
  ink: "#0D1321",
  accent: "#00A86B",
  paper: "#FFFFFF",
  /** The app-icon tile on a dark ground. */
  tile: "#1B2030",
} as const;

/** The mark's parts on a 100 × 100 grid, shared by every rendering.
 *  Matched to the final logo system (owner, 2026-11-17): the strokes carry
 *  the weight of the wordmark's letters, the bars fill their corners, and
 *  the head is a full wedge rather than a thin tip. */
export const MARK = {
  stroke: 17,
  bars: [
    [10, 10, 30, 30],
    [70, 70, 90, 90],
  ],
  shaft: [10, 90, 66, 34],
  head: "94,6 61,14 86,39",
} as const;

export function Mark({
  size = 24,
  onDark = false,
  title,
}: {
  size?: number;
  /** Bars in white, for the ink rail and dark tiles. */
  onDark?: boolean;
  /** Spoken name when the mark stands alone; omitted when text sits beside it. */
  title?: string;
}) {
  const bar = onDark ? BRAND.paper : BRAND.ink;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {MARK.bars.map(([x1, y1, x2, y2]) => (
        <line
          key={`${x1}-${y1}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={bar}
          strokeWidth={MARK.stroke}
          strokeLinecap="round"
        />
      ))}
      <line
        x1={MARK.shaft[0]}
        y1={MARK.shaft[1]}
        x2={MARK.shaft[2]}
        y2={MARK.shaft[3]}
        stroke={BRAND.accent}
        strokeWidth={MARK.stroke}
        strokeLinecap="round"
      />
      <polygon
        points={MARK.head}
        fill={BRAND.accent}
        stroke={BRAND.accent}
        strokeWidth={4}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "ScaleX": "Scale" in the ground's ink, and the X is the mark itself
 *  (owner's logo, 2026-11-15: the wordmark's last letter is the Ascent X). */
export function Wordmark({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className={`brand-word${onDark ? " on-dark" : ""}`} aria-label="ScaleX" role="img">
      <span aria-hidden="true">Scale</span>
      <span className="brand-x" aria-hidden="true">
        <Mark onDark={onDark} />
      </span>
    </span>
  );
}

/** The logo as the rail and the page mastheads show it: the wordmark, whose
 *  X is the mark. `size` is kept for callers; the wordmark sizes from its font. */
export function Logo({ onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <span className="brand-logo">
      <Wordmark onDark={onDark} />
    </span>
  );
}
