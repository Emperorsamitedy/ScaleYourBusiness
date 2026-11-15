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

/** The mark's parts on a 100 × 100 grid, shared by every rendering. */
export const MARK = {
  stroke: 14,
  bars: [
    [12, 12, 32, 32],
    [66, 66, 86, 86],
  ],
  shaft: [15, 83, 64, 34],
  head: "92,8 56.5,20.5 79.5,43.5",
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

/** "ScaleX": "Scale" in the ground's ink, the X in Accent. */
export function Wordmark({ onDark = false }: { onDark?: boolean }) {
  return (
    <span className={`brand-word${onDark ? " on-dark" : ""}`}>
      Scale<span className="brand-x">X</span>
    </span>
  );
}

/** Mark and wordmark together, as the rail and the page mastheads show them. */
export function Logo({ size = 22, onDark = false }: { size?: number; onDark?: boolean }) {
  return (
    <span className="brand-logo">
      <Mark size={size} onDark={onDark} />
      <Wordmark onDark={onDark} />
    </span>
  );
}
