"use client";

// The small visuals — specs/ux-spec-v1.md §2.1 "Small visuals". Each draws
// what its screen already says in words, from the same data, in the
// charts' own grammar (app/viz.css): filled ink is measured, hollow is
// stated, --ok is money earned or kept, the dashed --ok band an estimate.
// Plain SVG and CSS, sheet tokens only. A figure is always printed beside
// its mark, so nothing is hover-only.

import "../../app/viz.css";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { stepKey } from "../../lib/charts/keys";
import { niceTicks } from "../../lib/charts/ticks";
import { useChartWidth } from "./useChartWidth";

export type Tone =
  "ink" | "ink2" | "soft" | "faint" | "hollow" | "ok" | "okband" | "drift" | "alarm";

const share = (v: number, max: number) =>
  `${Math.min(100, Math.max(0, max > 0 ? (v / max) * 100 : 0)).toFixed(2)}%`;

// ── SegBar ──

export interface Seg {
  key: string;
  label: string;
  value: number;
  /** The figure as printed in the key; the plain value when absent. */
  display?: string;
  tone: Tone;
}

/** One stacked bar. With `onPick`, each segment is a pressed-state button. */
export function SegBar({
  segs,
  label,
  active,
  onPick,
  bare,
}: {
  segs: readonly Seg[];
  /** The whole bar said in one sentence. */
  label: string;
  active?: string | null;
  onPick?: (key: string) => void;
  /** No key under the bar: the screen already prints each count beside it. */
  bare?: boolean;
}) {
  const drawn = segs.filter((s) => s.value > 0);
  const picking = onPick !== undefined && active != null && drawn.some((s) => s.key === active);
  return (
    <div className="vz-block">
      <div
        className={`vz-seg${picking ? " picking" : ""}`}
        role={onPick ? "group" : "img"}
        aria-label={label}
      >
        {drawn.map((s) =>
          onPick ? (
            <button
              key={s.key}
              type="button"
              className={`vz-${s.tone}`}
              style={{ flex: `${s.value} 1 0` }}
              aria-pressed={active === s.key}
              aria-label={`${s.label}: ${s.display ?? s.value}`}
              title={`${s.label}: ${s.display ?? s.value}`}
              onClick={() => onPick(s.key)}
            />
          ) : (
            <span
              key={s.key}
              className={`vz-${s.tone}`}
              style={{ flex: `${s.value} 1 0` }}
              title={`${s.label}: ${s.display ?? s.value}`}
            />
          ),
        )}
      </div>
      {!bare && (
        <ul className="vz-keys" aria-hidden={onPick ? undefined : true}>
          {segs.map((s) => (
            <li key={s.key}>
              <span className={`vz-key vz-${s.tone}`} aria-hidden="true" />
              {s.label} <b>{s.display ?? s.value}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── HBars ──

export interface BarRow {
  key: string;
  label: ReactNode;
  /** A mono line under the label. */
  note?: ReactNode;
  /** The bar's length, on the shared scale. */
  value: number;
  /** For a range: the sure end. The bar is solid to here and lighter to `value`. */
  low?: number;
  /** The figure printed at the end of the row. */
  display: ReactNode;
  tone?: Tone;
  href?: string;
}

/** Horizontal bars on one zero-based scale, each with its figure printed. */
export function HBars({
  rows,
  max,
  refAt,
  refLabel,
  label,
  active,
  onPick,
  axis,
}: {
  rows: readonly BarRow[];
  /** The scale's top; the largest value when absent. */
  max?: number;
  /** A dashed reference line on every row (break-even, a target). */
  refAt?: number;
  refLabel?: string;
  label: string;
  active?: string | null;
  onPick?: (key: string) => void;
  /** A ruled scale under the bars: its ticks (the last is the scale's top) and how each prints. */
  axis?: { ticks: readonly number[]; format: (v: number) => string };
}) {
  const top = Math.max(
    max ?? 0,
    refAt ?? 0,
    ...rows.map((r) => r.value),
    ...(axis?.ticks ?? []),
    0,
  );
  const ruled = axis !== undefined && axis.ticks.length > 1;
  return (
    <div className="vz-block">
      <ul className={`vz-bars${ruled ? " ruled" : ""}`} aria-label={label}>
        {ruled && refAt !== undefined && refLabel && (
          <li className="vz-ref-head" aria-hidden="true">
            <span />
            <span className="vz-axis">
              {/* The name sits over its line, and leans inward near either end so it never
                  runs off the chart (a phone's axis is narrower than the name). */}
              <b
                style={
                  refAt / (top || 1) > 0.6
                    ? { right: share(top - refAt, top), transform: "none" }
                    : refAt / (top || 1) < 0.25
                      ? { left: share(refAt, top), transform: "none" }
                      : { left: share(refAt, top) }
                }
              >
                {refLabel}
              </b>
            </span>
            <span />
          </li>
        )}
        {rows.map((r) => {
          const inner = (
            <>
              {r.label}
              {r.note && <span className="vz-bar-note">{r.note}</span>}
            </>
          );
          return (
            <li key={r.key}>
              {onPick ? (
                <button
                  type="button"
                  className="vz-bar-label"
                  aria-pressed={active === r.key}
                  onClick={() => onPick(r.key)}
                >
                  {inner}
                </button>
              ) : r.href ? (
                <a className="vz-bar-label" href={r.href}>
                  {inner}
                </a>
              ) : (
                <span className="vz-bar-label">{inner}</span>
              )}
              <span className="vz-bar-track" aria-hidden="true">
                {ruled &&
                  axis.ticks
                    .slice(1)
                    .map((t) => (
                      <i key={t} className="vz-bar-grid" style={{ left: share(t, top) }} />
                    ))}
                {r.low !== undefined && r.low < r.value && (
                  <span
                    className={`vz-bar-rest vz-${r.tone ?? "ink"}`}
                    style={{ left: 0, width: share(r.value, top) }}
                  />
                )}
                <span
                  className={`vz-bar-fill vz-${r.tone ?? "ink"}`}
                  style={{ left: 0, width: share(r.low ?? r.value, top) }}
                />
                {refAt !== undefined && (
                  <span className="vz-bar-ref" style={{ left: share(refAt, top) }} />
                )}
              </span>
              <span className="vz-bar-fig">{r.display}</span>
            </li>
          );
        })}
        {ruled && (
          <li className="vz-axis-row" aria-hidden="true">
            <span />
            <span className="vz-axis">
              {axis.ticks.map((t) => (
                <i key={t} style={{ left: share(t, top) }}>
                  {axis.format(t)}
                </i>
              ))}
            </span>
            <span />
          </li>
        )}
      </ul>
      {!ruled && refAt !== undefined && refLabel && (
        <p className="vz-ref-note">
          <i aria-hidden="true" />
          {refLabel}
        </p>
      )}
    </div>
  );
}

// ── Dumbbell ──

export interface DumbRow {
  key: string;
  label: ReactNode;
  /** What was said (hollow). */
  a: number;
  /** What was measured (filled). */
  b: number;
  display: ReactNode;
}

/** Two marks per row on that row's own zero-based scale, joined by a line. */
export function Dumbbell({
  rows,
  aWord,
  bWord,
  label,
}: {
  rows: readonly DumbRow[];
  aWord: string;
  bWord: string;
  label: string;
}) {
  return (
    <div className="vz-block">
      <ul className="vz-dumb" aria-label={label}>
        {rows.map((r) => {
          const top = Math.max(Math.abs(r.a), Math.abs(r.b), 1) * 1.08;
          const pa = Math.abs(r.a) / top;
          const pb = Math.abs(r.b) / top;
          return (
            <li key={r.key}>
              <span className="vz-bar-label">{r.label}</span>
              <span className="vz-dumb-track" aria-hidden="true">
                <span
                  className="vz-dumb-join"
                  style={{
                    left: `${(Math.min(pa, pb) * 100).toFixed(2)}%`,
                    width: `${(Math.abs(pa - pb) * 100).toFixed(2)}%`,
                  }}
                />
                <span className="vz-dumb-a" style={{ left: `${(pa * 100).toFixed(2)}%` }} />
                <span className="vz-dumb-b" style={{ left: `${(pb * 100).toFixed(2)}%` }} />
              </span>
              <span className="vz-bar-fig">{r.display}</span>
            </li>
          );
        })}
      </ul>
      <ul className="vz-keys" aria-hidden="true">
        <li>
          <span className="vz-key vz-hollow" /> {aWord}
        </li>
        <li>
          <span className="vz-key vz-ink" /> {bWord}
        </li>
      </ul>
    </div>
  );
}

// ── Bullet ──

/**
 * Start → target as the tinted band, a dashed tick where the path says the
 * figure should be, an ink tick where it is. Decorative to assistive tech:
 * the figures beside it already say all four.
 */
export function Bullet({
  start,
  target,
  now,
  path,
  title,
}: {
  start: number;
  target: number;
  now: number | null;
  path?: number | null;
  title?: string;
}) {
  const points = [start, target, ...(now === null ? [] : [now]), ...(path == null ? [] : [path])];
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const pad = (hi - lo || 1) * 0.06;
  const at = (v: number) => `${(((v - (lo - pad)) / (hi - lo + 2 * pad)) * 100).toFixed(2)}%`;
  const from = Math.min(start, target);
  const to = Math.max(start, target);
  return (
    <span className="vz-bullet" aria-hidden="true" title={title}>
      <span
        className="vz-bullet-band"
        style={{ left: at(from), width: `calc(${at(to)} - ${at(from)})` }}
      />
      {path != null && <span className="vz-bullet-path" style={{ left: at(path) }} />}
      {now !== null && <span className="vz-bullet-now" style={{ left: at(now) }} />}
    </span>
  );
}

// ── Spark ──

/**
 * A daily series at text height: an ink line, the last reading a dot.
 * Pointer or ←/→ shows one day's figure. `span` tints a run of days.
 */
export function Spark({
  values,
  labels,
  format,
  label,
  span,
  width = 132,
  height = 30,
}: {
  values: readonly (number | null)[];
  /** One per value: the day, as printed in the readout. */
  labels: readonly string[];
  format: (v: number) => string;
  /** The series said in one sentence. */
  label: string;
  span?: readonly [number, number] | null;
  width?: number;
  height?: number;
}) {
  const [at, setAt] = useState<number | null>(null);
  const n = values.length;
  const known = values.filter((v): v is number => v !== null);
  if (n < 2 || known.length < 2) return null;
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  const P = 3;
  const x = (i: number) => P + (i / (n - 1)) * (width - 2 * P);
  const y = (v: number) =>
    hi === lo ? height / 2 : P + (1 - (v - lo) / (hi - lo)) * (height - 2 * P);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  let last = n - 1;
  while (last > 0 && values[last] === null) last -= 1;
  const lastV = values[last] ?? null;
  const shown = at !== null && values[at] !== null ? at : null;
  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, n);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };
  return (
    <span className="vz-spark">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setAt(null)}
        onPointerMove={(ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          const i = Math.round(((ev.clientX - r.left - P) / (r.width - 2 * P)) * (n - 1));
          setAt(i >= 0 && i < n ? i : null);
        }}
        onPointerLeave={() => setAt(null)}
      >
        {span && (
          <rect
            className="span"
            x={x(span[0]) - 1}
            y={0}
            width={Math.max(3, x(span[1]) - x(span[0]) + 2)}
            height={height}
          />
        )}
        <line className="base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
        <path className="line" d={d} />
        {lastV !== null && shown === null && (
          <rect className="dot" x={x(last) - 2.5} y={y(lastV) - 2.5} width={5} height={5} />
        )}
        {shown !== null && (
          <>
            <line className="cross" x1={x(shown)} x2={x(shown)} y1={0} y2={height} />
            <rect
              className="dot"
              x={x(shown) - 2.5}
              y={y(values[shown] as number) - 2.5}
              width={5}
              height={5}
            />
          </>
        )}
      </svg>
      {shown !== null && (
        <span
          className="vz-tip"
          style={{ left: `${Math.min(width - 30, Math.max(30, x(shown)))}px` }}
          aria-live="polite"
        >
          {labels[shown]} · {format(values[shown] as number)}
        </span>
      )}
    </span>
  );
}

// ── Steps ──

export interface Step {
  key: string;
  label: string;
  state: "done" | "now" | "todo";
}

/** A process as connected squares: filled is done, heavy outline is now. */
export function Steps({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <ol className="vz-steps" aria-label={label}>
      {steps.map((s) => (
        <li key={s.key} className={s.state} aria-current={s.state === "now" ? "step" : undefined}>
          <span className="vz-step" aria-hidden="true" />
          {s.label}
        </li>
      ))}
    </ol>
  );
}

// ── Trend ──

export interface TrendPoint {
  /** The day, as printed on the axis and in the readout. */
  label: string;
  value: number | null;
}

/**
 * A measured series as a printed chart: round-number ticks on a labelled
 * scale, dotted gridlines, the line in ink over a tint of --ok, and the
 * last reading marked with its figure. Pointer or ←/→ reads one day. The
 * scale is zoomed to the series (a line, not bars), which its ticks say.
 */
export function Trend({
  points,
  format,
  label,
  columns,
  step = 1,
  height = 150,
}: {
  points: readonly TrendPoint[];
  /** One reading in full ("€1,867"); the ticks print through it too. */
  format: (v: number) => string;
  /** The series said in one sentence. */
  label: string;
  /** The hidden table's two column names: the day, the figure. */
  columns: readonly [string, string];
  /** Minor units per major unit, so money's ticks fall on round major figures. */
  step?: number;
  height?: number;
}) {
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(420);
  const n = points.length;
  const known = points.flatMap((p) => (p.value === null ? [] : [p.value]));
  if (n < 2 || known.length < 2) return null;
  const ticks = niceTicks(Math.min(...known) / step, Math.max(...known) / step, narrow ? 3 : 4).map(
    (t) => t * step,
  );
  const lo = ticks[0] ?? 0;
  const hi = ticks.at(-1) ?? 1;
  const tickText = ticks.map(format);
  const L = Math.max(...tickText.map((t) => t.length)) * 7 + 10;
  const R = 12;
  const T = 18;
  const B = 22;
  const H = narrow ? Math.min(height, 130) : height;
  const x = (i: number) => L + (i / (n - 1)) * (width - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
  const runs: { from: number; to: number; d: string }[] = [];
  points.forEach((p, i) => {
    if (p.value === null) return;
    const here = `${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`;
    const open = runs.at(-1);
    if (open && open.to === i - 1) {
      open.d += `L${here}`;
      open.to = i;
    } else {
      runs.push({ from: i, to: i, d: `M${here}` });
    }
  });
  let last = n - 1;
  while (last > 0 && points[last]?.value == null) last -= 1;
  const lastV = points[last]?.value ?? null;
  const shown = at !== null && points[at]?.value != null ? at : null;
  const shownV = shown === null ? null : (points[shown]?.value ?? null);
  const every = Math.max(1, Math.ceil(n / (narrow ? 3 : 5)));
  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, n);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };
  return (
    <div className="vz-trend" ref={ref}>
      <svg
        width={width}
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        role="img"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKey}
        onBlur={() => setAt(null)}
        onPointerMove={(ev) => {
          const r = ev.currentTarget.getBoundingClientRect();
          const i = Math.round(((ev.clientX - r.left - L) / (r.width - L - R)) * (n - 1));
          setAt(i >= 0 && i < n ? i : null);
        }}
        onPointerLeave={() => setAt(null)}
      >
        {ticks.map((t, k) => (
          <g key={t}>
            <line className={k === 0 ? "axis" : "grid"} x1={L} x2={width - R} y1={y(t)} y2={y(t)} />
            <text className="tick" x={L - 6} y={y(t) + 4} textAnchor="end">
              {tickText[k]}
            </text>
          </g>
        ))}
        {runs.map((r) => (
          <g key={r.from}>
            <path
              className="area"
              d={`${r.d}L${x(r.to).toFixed(1)} ${y(lo).toFixed(1)}L${x(r.from).toFixed(1)} ${y(lo).toFixed(1)}Z`}
            />
            <path className="line" d={r.d} />
          </g>
        ))}
        {points.map((p, i) =>
          i % every === 0 && n - 1 - i >= every / 2 ? (
            <text
              key={i}
              className="tick"
              x={x(i)}
              y={H - 6}
              textAnchor={i === 0 ? "start" : "middle"}
            >
              {p.label}
            </text>
          ) : null,
        )}
        <text className="tick" x={x(n - 1)} y={H - 6} textAnchor="end">
          {points[n - 1]?.label}
        </text>
        {lastV !== null && shown === null && (
          <>
            <rect className="end" x={x(last) - 3.5} y={y(lastV) - 3.5} width={7} height={7} />
            <text className="end-fig" x={x(last) + 2} y={y(lastV) - 9} textAnchor="end">
              {format(lastV)}
            </text>
          </>
        )}
        {shown !== null && shownV !== null && (
          <>
            <line className="cross" x1={x(shown)} x2={x(shown)} y1={T - 6} y2={H - B} />
            <rect className="end" x={x(shown) - 3.5} y={y(shownV) - 3.5} width={7} height={7} />
          </>
        )}
      </svg>
      {shown !== null && shownV !== null && (
        <span
          className="vz-tip"
          style={{
            left: `${Math.min(width - 50, Math.max(50, x(shown)))}px`,
            bottom: `${H - T + 8}px`,
          }}
          aria-live="polite"
        >
          {points[shown]?.label} · {format(shownV)}
        </span>
      )}
      <div className="sr-only">
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">{columns[0]}</th>
              <th scope="col">{columns[1]}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p, i) => (
              <tr key={i}>
                <th scope="row">{p.label}</th>
                <td>{p.value === null ? "—" : format(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
