"use client";

// The instrument cluster — P1-55.
//
// Four chart forms, none of them a bar: a tick-marked dial for the leak,
// a radar plot of every product's margin (the shape itself is the
// finding — one vertex collapses inward), two small arc gauges, and a
// sweeping scanner while the numbers are being computed.
//
// All geometry is computed, not hand-drawn, so the same components work
// for any profile's real numbers later.

/* ── polar helpers ── */

// Rounded, because Math.cos and Math.sin are not required to be correctly
// rounded and Node and Chrome disagree in the last bit. Unrounded, every
// tick coordinate is a hydration mismatch React refuses to patch up.
const r3 = (n: number): number => Math.round(n * 1000) / 1000;

const P = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const t = ((deg - 90) * Math.PI) / 180;
  return [r3(cx + r * Math.cos(t)), r3(cy + r * Math.sin(t))];
};

/** Arc path for a fraction of a circle, starting at 12 o'clock. */
function arcPath(cx: number, cy: number, r: number, frac: number, from = 0): string {
  const span = Math.min(0.9999, Math.max(0.0001, frac)) * 360;
  const [x0, y0] = P(cx, cy, r, from);
  const [x1, y1] = P(cx, cy, r, from + span);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${span > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

/** Graduation marks around a ring — the thing that makes it read as an instrument. */
function Ticks({
  cx,
  cy,
  r,
  count = 60,
  len = 5,
  every = 5,
}: {
  cx: number;
  cy: number;
  r: number;
  count?: number;
  len?: number;
  every?: number;
}) {
  return (
    <g className="hud-ticks">
      {Array.from({ length: count }, (_, i) => {
        const deg = (360 / count) * i;
        const major = i % every === 0;
        const [x1, y1] = P(cx, cy, r, deg);
        const [x2, y2] = P(cx, cy, r - (major ? len * 1.9 : len), deg);
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={major ? "rgba(245,155,75,.55)" : "rgba(255,255,255,.16)"}
            strokeWidth={major ? 1.3 : 0.8}
          />
        );
      })}
    </g>
  );
}

/** The headline dial: leak as a share of revenue, in a rotating housing. */
export function LeakDial({ value, live }: { value: string; live: boolean }) {
  const cx = 100;
  const cy = 100;
  return (
    <svg viewBox="0 0 200 200" className={live ? "hud-dial in" : "hud-dial"} aria-hidden="true">
      <circle cx={cx} cy={cy} r={94} fill="none" stroke="rgba(255,255,255,.07)" />
      <Ticks cx={cx} cy={cy} r={94} />
      {/* slow counter-rotating housing */}
      <g className="hud-spin">
        <circle
          cx={cx}
          cy={cy}
          r={80}
          fill="none"
          stroke="rgba(255,255,255,.13)"
          strokeDasharray="3 9"
        />
      </g>
      <g className="hud-spin-rev">
        <circle
          cx={cx}
          cy={cy}
          r={68}
          fill="none"
          stroke="rgba(76,125,240,.28)"
          strokeDasharray="26 12"
          strokeWidth="1.2"
        />
      </g>
      {/* the measurement: 11.6% of revenue */}
      <path
        className="hud-arc"
        d={arcPath(cx, cy, 55, 0.116)}
        fill="none"
        stroke="url(#hudGrad)"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle cx={cx} cy={cy} r={55} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="9" />
      <defs>
        <linearGradient id="hudGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffb25c" />
          <stop offset="100%" stopColor="#e1560f" />
        </linearGradient>
      </defs>
      <text x={cx} y={cy - 12} textAnchor="middle" className="hud-cap">
        LEAKING / MONTH
      </text>
      <text x={cx} y={cy + 18} textAnchor="middle" className="hud-value">
        {value}
      </text>
      <text x={cx} y={cy + 38} textAnchor="middle" className="hud-sub">
        11.6% OF REVENUE
      </text>
    </svg>
  );
}

/** Every product's margin on its own axis — the shape is the finding. */
export function MarginRadar({ live }: { live: boolean }) {
  const cx = 110;
  const cy = 105;
  const R = 74;
  const items = [
    { name: "Gift box", v: 61 },
    { name: "Winter", v: 44 },
    { name: "Sampler", v: 38 },
    { name: "1L", v: 31 },
    { name: "0.5L", v: 18, hot: true },
  ];
  const max = 65;
  const pts = items.map((it, i) => P(cx, cy, (it.v / max) * R, (360 / items.length) * i));

  return (
    <svg viewBox="0 0 220 210" className={live ? "hud-radar in" : "hud-radar"} aria-hidden="true">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon
          key={f}
          points={items
            .map((_, i) => P(cx, cy, R * f, (360 / items.length) * i).join(","))
            .join(" ")}
          fill="none"
          stroke="rgba(255,255,255,.07)"
        />
      ))}
      {items.map((_, i) => {
        const [x, y] = P(cx, cy, R, (360 / items.length) * i);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,.07)" />;
      })}

      <polygon
        className="hud-poly"
        points={pts.map((p) => p.join(",")).join(" ")}
        fill="rgba(245,155,75,.16)"
        stroke="#f59b4b"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      {items.map((it, i) => {
        const [x, y] = pts[i]!;
        const [lx, ly] = P(cx, cy, R + 17, (360 / items.length) * i);
        return (
          <g key={it.name}>
            <circle
              cx={x}
              cy={y}
              r={it.hot ? 5 : 3}
              fill={it.hot ? "#f59b4b" : "rgba(255,255,255,.5)"}
            />
            {it.hot && (
              <circle className="hud-ping" cx={x} cy={y} r={5} fill="none" stroke="#f59b4b" />
            )}
            <text
              x={lx}
              y={ly + 3}
              textAnchor="middle"
              className={it.hot ? "hud-axis hot" : "hud-axis"}
            >
              {it.name}
            </text>
          </g>
        );
      })}
      <text x={cx} y={cy + R + 46} textAnchor="middle" className="hud-cap">
        MARGIN BY PRODUCT
      </text>
    </svg>
  );
}

/** A small arc gauge for a supporting figure. */
export function MiniGauge({
  label,
  value,
  note,
  frac,
  tone = "ember",
  live,
}: {
  label: string;
  value: string;
  note: string;
  frac: number;
  tone?: "ember" | "blue";
  live: boolean;
}) {
  const stroke = tone === "blue" ? "#4c7df0" : "#f59b4b";
  return (
    <div className="hud-mini">
      <svg viewBox="0 0 120 120" className={live ? "hud-dial in" : "hud-dial"} aria-hidden="true">
        <Ticks cx={60} cy={60} r={56} count={36} len={3.5} every={3} />
        <circle cx={60} cy={60} r={40} fill="none" stroke="rgba(255,255,255,.06)" strokeWidth="6" />
        <path
          className="hud-arc"
          d={arcPath(60, 60, 40, frac)}
          fill="none"
          stroke={stroke}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <text x="60" y="58" textAnchor="middle" className="hud-mini-value">
          {value}
        </text>
        <text x="60" y="74" textAnchor="middle" className="hud-sub">
          {note}
        </text>
      </svg>
      <span className="hud-cap-html">{label}</span>
    </div>
  );
}

/** The sweep while the numbers are being worked out. */
export function Scanner() {
  return (
    <div className="hud-scan">
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle cx="100" cy="100" r="92" fill="none" stroke="rgba(255,255,255,.08)" />
        <circle cx="100" cy="100" r="62" fill="none" stroke="rgba(255,255,255,.06)" />
        <circle cx="100" cy="100" r="32" fill="none" stroke="rgba(255,255,255,.05)" />
        <Ticks cx={100} cy={100} r={92} count={48} len={4} every={4} />
        <g className="hud-sweep">
          <defs>
            <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#f59b4b" stopOpacity="0" />
              <stop offset="100%" stopColor="#f59b4b" stopOpacity=".55" />
            </linearGradient>
          </defs>
          <path d="M100,100 L100,8 A92,92 0 0 1 165,35 Z" fill="url(#sweep)" />
          <line x1="100" y1="100" x2="100" y2="8" stroke="#ffb25c" strokeWidth="1.6" />
        </g>
        <circle className="hud-ping" cx="100" cy="100" r="30" fill="none" stroke="#f59b4b" />
      </svg>
      <span className="hud-scan-text">reading 214 facts · computing five margins</span>
    </div>
  );
}
