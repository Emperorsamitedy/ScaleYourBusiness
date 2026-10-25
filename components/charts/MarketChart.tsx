"use client";

// "<Your shop>, read like a stock" — the business's own daily takings as
// candles, with what slipped away drawn above them (the owner's landing
// idea, built on real data and the sheet system; specs/ux-spec-v1.md
// §2.1). Plain SVG, sheet tokens only (app/charts.css):
//
//   · candles: up (closed at or above its open) is a FILLED body, down is
//     HOLLOW — shape carries direction, the ok/alarm tint only repeats it,
//     so the chart reads in grayscale;
//   · the volume pane: orders, appointments or visits per bucket;
//   · the overlay: the slipped money as a two-step band above the close
//     (the low end solid, the rest of the range lighter) under a dotted
//     "what you'd have kept" line; the waiting proposals' range as a
//     dashed band ahead of today, ESTIMATED;
//   · event markers: a hollow square for something detected, a filled one
//     for something you approved, a hairline for the day a source came in;
//   · a crosshair readout in mono, by pointer or keyboard (←/→, Home/End,
//     Esc), and the 1D/1W/1M switch as a group of pressed buttons;
//   · the text alternative: the summary as the figure's accessible name
//     and a visually-hidden table of every plotted value.
//
// Every number comes from the model (lib/charts/model); this file draws.

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import Link from "next/link";
import { BASIS_MEANING } from "../report/basis";
import { num } from "../sheet/num";
import type { Bucket, Candle } from "../../lib/charts/candles";
import {
  BUCKETS,
  BUCKET_LABEL,
  BUCKET_SPAN,
  bucketCandles,
  bucketStart,
  lastBuckets,
} from "../../lib/charts/candles";
import { stepKey } from "../../lib/charts/keys";
import type { DrawnModel, EmptyModel, MarketChartModel, MarketEvent } from "../../lib/charts/model";
import {
  EVENT_WORD,
  chartSummary,
  chartTable,
  dayMoney,
  periodLabel,
  shortDate,
} from "../../lib/charts/model";
import type { OpportunityComponent, PricedComponent } from "../../lib/charts/opportunity";
import { COMPONENT_LABEL, rangeWhole } from "../../lib/charts/opportunity";
import { useChartWidth } from "./useChartWidth";

/* ── geometry, in CSS pixels ── */

const PAD_L = 4;
const AXIS_W = 70;
const AXIS_W_NARROW = 58;
const TOP = 14;
const PRICE_H = 180;
const PRICE_H_NARROW = 180;
const GAP = 8;
const VOL_H = 40;
const XAXIS_H = 24;

interface Placed {
  e: MarketEvent;
  n: number;
}

export function layout(
  model: DrawnModel,
  candles: readonly Candle[],
  width: number,
  narrow: boolean,
  bucket: Bucket,
) {
  const table = model.components.find(
    (c): c is PricedComponent => c.key === "on_the_table" && c.status === "priced",
  );
  const axisW = narrow ? AXIS_W_NARROW : AXIS_W;
  const showVol = !narrow && model.volume !== null && candles.some((c) => c.volume !== null);
  const priceH = narrow ? PRICE_H_NARROW : PRICE_H;
  const priceBottom = TOP + priceH;
  const volTop = priceBottom + GAP;
  const volBottom = showVol ? volTop + VOL_H : priceBottom;
  const height = volBottom + XAXIS_H;
  const plotR = width - axisW;
  const ahead = table ? Math.max(4, Math.round(candles.length * 0.14)) : 0;
  const slots = candles.length + ahead;
  const slot = (plotR - PAD_L) / Math.max(1, slots);
  const x = (i: number) => PAD_L + slot * (i + 0.5);
  const body = Math.max(1, Math.min(14, slot * 0.62));

  // The per-day equivalent of the waiting proposals' monthly range, above the recent average day.
  const recent = candles.slice(-Math.min(candles.length, bucket === "day" ? 28 : 4));
  const avgDay =
    recent.length === 0
      ? 0
      : Math.round(recent.reduce((n, c) => n + c.close_minor, 0) / recent.length);
  const band = table
    ? {
        base: avgDay,
        low: avgDay + Math.round(table.total.low_minor / 30),
        high: avgDay + Math.round(table.total.high_minor / 30),
      }
    : null;

  const values = [
    ...candles.flatMap((c) => [c.high_minor, c.low_minor, c.kept_high_minor]),
    ...(band ? [band.high, band.base] : []),
  ];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) hi = lo + 100;
  const pad = (hi - lo) * 0.08;
  lo = Math.max(0, lo - pad);
  hi = hi + pad;
  const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * priceH;

  const tickCount = narrow ? 4 : 5;
  const ticks = Array.from({ length: tickCount }, (_, i) => lo + ((hi - lo) * i) / (tickCount - 1));
  const volMax = Math.max(1, ...candles.map((c) => c.volume ?? 0));
  const labelEvery = Math.max(1, Math.ceil(candles.length / (narrow ? 3 : 7)));

  // Events onto the bucket they fall in (or the next measured one).
  const starts = candles.map((c) => c.start);
  const placed = new Map<number, Placed[]>();
  model.events.forEach((e, n) => {
    const s = bucketStart(e.date, bucket);
    let i = starts.indexOf(s);
    if (i === -1) i = starts.findIndex((d) => d > s);
    if (i === -1 || e.date < (candles[0]?.start ?? "")) return;
    placed.set(i, [...(placed.get(i) ?? []), { e, n: n + 1 }]);
  });

  return {
    width,
    height,
    plotR,
    axisW,
    priceBottom,
    volTop,
    volBottom,
    showVol,
    slot,
    body,
    x,
    y,
    ticks,
    volMax,
    labelEvery,
    placed,
    band,
    ahead,
    future: { x0: x(candles.length) - slot / 2, x1: plotR },
  };
}

const pts = (xs: readonly [number, number][]) =>
  xs.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(" ");

/* ── the chart ── */

export function MarketChart({ model }: { model: MarketChartModel }) {
  if (model.status === "empty") return <EmptyMarket model={model} />;
  return <DrawnMarket model={model} />;
}

function DrawnMarket({ model }: { model: DrawnModel }) {
  const [bucket, setBucket] = useState<Bucket>(model.bucket);
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>();

  const all = useMemo(() => bucketCandles(model.days, bucket), [model.days, bucket]);
  const candles = useMemo(
    () => lastBuckets(all, BUCKET_SPAN[bucket][narrow ? "narrow" : "wide"]),
    [all, bucket, narrow],
  );
  const g = useMemo(
    () => layout(model, candles, width, narrow, bucket),
    [model, candles, width, narrow, bucket],
  );
  const summary = chartSummary(model, candles, bucket);
  const table = chartTable(model, candles, bucket);
  const cur = model.currency;
  const shown = at !== null && at < candles.length ? at : candles.length - 1;
  const c = candles[shown];

  const onMove = (ev: PointerEvent<SVGSVGElement>) => {
    const r = ev.currentTarget.getBoundingClientRect();
    const px = ev.clientX - r.left;
    const i = Math.floor((px - PAD_L) / g.slot);
    setAt(i >= 0 && i < candles.length ? i : null);
  };
  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, candles.length);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };

  const slipAreas = useMemo(() => {
    const close = candles.map((k, i) => [g.x(i), g.y(k.close_minor)] as [number, number]);
    const low = candles.map((k, i) => [g.x(i), g.y(k.kept_low_minor)] as [number, number]);
    const high = candles.map((k, i) => [g.x(i), g.y(k.kept_high_minor)] as [number, number]);
    return {
      solid: pts([...low, ...[...close].reverse()]),
      range: pts([...high, ...[...low].reverse()]),
      line: pts(high),
      any: candles.some((k) => k.slip_high_minor > 0),
    };
  }, [candles, g]);

  const last = candles.at(-1);
  const tableComp = model.components.find((k) => k.key === "on_the_table");
  const flows = model.components.filter((k) => k.kind === "flow");
  const others = model.components.filter((k) => k.kind !== "flow");
  const descId = "mk-table";

  return (
    <section className="cs mk" aria-labelledby="mk-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">Insights · Your numbers as a chart</p>
          <h2 className="cs-title" id="mk-title">
            {model.title}
          </h2>
          <p className="mk-headline">{model.headline.text}</p>
        </div>
        <div className="cs-meta">
          {model.price.label} · {model.price.source}
          <br />
          <span className="word">{model.price.basis}</span> · {num(model.price.days_measured)} days
          measured
        </div>
      </header>

      <div className="mk-bar">
        <div className="mk-switch" role="group" aria-label="Candle period">
          {BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              className={`mk-tf${bucket === b ? " on" : ""}`}
              aria-pressed={bucket === b}
              onClick={() => {
                setBucket(b);
                setAt(null);
              }}
            >
              {BUCKET_LABEL[b]}
              <span className="sr-only"> — one candle a {b}</span>
            </button>
          ))}
        </div>
        <ul className="mk-keys" aria-label="Key">
          <li>
            <span className="mk-key-candle up" aria-hidden="true" /> up: filled
          </li>
          <li>
            <span className="mk-key-candle down" aria-hidden="true" /> down: hollow
          </li>
          {slipAreas.any && (
            <li>
              <span className="mk-key-slip" aria-hidden="true" /> slipped, a day
            </li>
          )}
          {slipAreas.any && (
            <li>
              <span className="mk-key-kept" aria-hidden="true" /> what you&rsquo;d have kept
            </li>
          )}
          {g.band && (
            <li>
              <span className="mk-key-table" aria-hidden="true" /> on the table
            </li>
          )}
        </ul>
      </div>

      {c && (
        <p className="mk-readout" aria-live="polite">
          <b>{periodLabel(c, bucket)}</b>
          <span>
            O {dayMoney(c.open_minor, cur)} H {dayMoney(c.high_minor, cur)} L{" "}
            {dayMoney(c.low_minor, cur)} C <b>{dayMoney(c.close_minor, cur)}</b>
          </span>
          {c.closed > 0 && (
            <span>
              {num(c.closed)} closed day{c.closed === 1 ? "" : "s"}
            </span>
          )}
          {model.volume && (
            <span>
              {c.volume === null ? "not measured" : num(c.volume)} {model.volume.word}
            </span>
          )}
          <span>
            {c.slip_high_minor > 0 ? (
              <>
                slipped{" "}
                <b>
                  {rangeWhole({
                    low_minor: c.slip_low_minor,
                    high_minor: c.slip_high_minor,
                    currency: cur,
                  })}
                </b>
                {": "}
                {c.slip
                  .map(
                    (s) =>
                      `${COMPONENT_LABEL[s.key as keyof typeof COMPONENT_LABEL] ?? s.key} ${rangeWhole({ low_minor: s.low_minor, high_minor: s.high_minor, currency: cur })}`,
                  )
                  .join(", ")}{" "}
                <span className="word">DERIVED</span> · kept{" "}
                {rangeWhole({
                  low_minor: c.kept_low_minor,
                  high_minor: c.kept_high_minor,
                  currency: cur,
                })}{" "}
                a day
              </>
            ) : (
              "nothing measured slipped"
            )}
          </span>
        </p>
      )}

      <div className="mk-plot" ref={ref}>
        <svg
          className="mk-svg"
          width={g.width}
          height={g.height}
          viewBox={`0 0 ${g.width} ${g.height}`}
          role="img"
          aria-label={summary}
          aria-describedby={descId}
          tabIndex={0}
          onPointerMove={onMove}
          onPointerLeave={() => setAt(null)}
          onKeyDown={onKey}
          onBlur={() => setAt(null)}
        >
          {g.ticks.map((t) => (
            <line key={`g${t}`} className="grid" x1={0} x2={g.plotR} y1={g.y(t)} y2={g.y(t)} />
          ))}
          <line className="axis" x1={g.plotR} x2={g.plotR} y1={TOP - 6} y2={g.volBottom} />

          {g.band && (
            <g className="mk-ahead">
              <rect
                className="band"
                x={g.future.x0}
                width={Math.max(0, g.future.x1 - g.future.x0)}
                y={g.y(g.band.high)}
                height={Math.max(1, g.y(g.band.low) - g.y(g.band.high))}
              />
              <line
                className="base"
                x1={g.future.x0}
                x2={g.future.x1}
                y1={g.y(g.band.base)}
                y2={g.y(g.band.base)}
              />
              <text
                className="ahead-label"
                x={(g.future.x0 + g.future.x1) / 2}
                y={g.y(g.band.high) - 6}
                textAnchor="middle"
              >
                {g.future.x1 - g.future.x0 > 96 ? "ON THE TABLE" : "TABLE"}
              </text>
            </g>
          )}

          {slipAreas.any && (
            <g className="mk-slip" aria-hidden="true">
              <polygon className="solid" points={slipAreas.solid} />
              <polygon className="range" points={slipAreas.range} />
              <polyline className="kept" points={slipAreas.line} />
            </g>
          )}

          {candles.map((k, i) => {
            const up = k.close_minor >= k.open_minor;
            const cx = g.x(i);
            const top = g.y(Math.max(k.open_minor, k.close_minor));
            const h = Math.max(1, Math.abs(g.y(k.open_minor) - g.y(k.close_minor)));
            return (
              <g key={k.start} className={up ? "up" : "down"}>
                <line
                  className="wick"
                  x1={cx}
                  x2={cx}
                  y1={g.y(k.high_minor)}
                  y2={g.y(k.low_minor)}
                />
                <rect className="body" x={cx - g.body / 2} y={top} width={g.body} height={h} />
                {g.showVol && k.volume !== null && (
                  <rect
                    className="vol"
                    x={cx - g.body / 2}
                    width={g.body}
                    y={g.volBottom - (k.volume / g.volMax) * VOL_H}
                    height={Math.max(0.5, (k.volume / g.volMax) * VOL_H)}
                  />
                )}
              </g>
            );
          })}

          {[...g.placed.entries()].map(([i, list]) => {
            const cx = g.x(i);
            const kinds = new Set(list.map((p) => p.e.kind));
            const label = list.length === 1 ? String(list[0]!.n) : `${list[0]!.n}+`;
            return (
              <g key={`e${i}`} className="mk-event">
                {kinds.has("connected") && (
                  <line className="conn" x1={cx} x2={cx} y1={TOP} y2={g.priceBottom} />
                )}
                {(kinds.has("anomaly") || kinds.has("approved")) && (
                  <rect
                    className={kinds.has("approved") ? "mark approved" : "mark anomaly"}
                    x={cx - 5}
                    y={g.priceBottom - 14}
                    width={10}
                    height={10}
                  />
                )}
                <text className="ev-n" x={cx} y={g.priceBottom - 18} textAnchor="middle">
                  {label}
                </text>
              </g>
            );
          })}

          {g.ticks.map((t) => (
            <text key={`t${t}`} className="tick" x={g.plotR + 6} y={g.y(t) + 4}>
              {dayMoney(t, cur)}
            </text>
          ))}
          {last && (
            <g className={last.close_minor >= last.open_minor ? "tag up" : "tag down"}>
              <rect x={g.plotR + 1} y={g.y(last.close_minor) - 9} width={g.axisW - 1} height={18} />
              <text x={g.plotR + 6} y={g.y(last.close_minor) + 4}>
                {dayMoney(last.close_minor, cur)}
              </text>
            </g>
          )}
          {g.showVol && (
            <text className="pane-label" x={4} y={g.volTop + 11}>
              {model.volume!.word.toUpperCase()}
            </text>
          )}
          {candles.map((k, i) =>
            i % g.labelEvery === 0 ? (
              <text
                key={`x${k.start}`}
                className="tick"
                x={i === 0 ? Math.max(0, g.x(i) - g.slot / 2) : g.x(i)}
                y={g.volBottom + 17}
                textAnchor={i === 0 ? "start" : "middle"}
              >
                {bucket === "month" ? periodLabel(k, bucket).slice(0, 3) : shortDate(k.start)}
              </text>
            ) : null,
          )}

          {at !== null && c && (
            <g className="mk-cross" aria-hidden="true">
              <line x1={g.x(shown)} x2={g.x(shown)} y1={TOP - 6} y2={g.volBottom} />
            </g>
          )}
        </svg>
      </div>

      {model.events.length > 0 && (
        <ol className="mk-events" aria-label="Marked on the chart">
          {model.events.map((e, i) => (
            <li key={`${e.date}-${i}`}>
              <span className="mk-ev-n" aria-hidden="true">
                {i + 1}
              </span>
              <span className="mk-ev-shape" data-kind={e.kind} aria-hidden="true" />
              <span className="word">{EVENT_WORD[e.kind]}</span>{" "}
              <span className="mk-ev-date">{shortDate(e.date)}</span> · {e.label}
              <span className="sr-only">. {e.detail}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="mk-components">
        <table className="rt rt-stack">
          <caption className="sr-only">
            What slips away each month, how each part was worked out, and its basis
          </caption>
          <thead>
            <tr>
              <th scope="col">Where it slips</th>
              <th scope="col" className="num">
                {cur} a month
              </th>
              <th scope="col">Basis</th>
              <th scope="col">How it was worked out</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((k) => (
              <ComponentRow key={k.key} c={k} />
            ))}
          </tbody>
          {others.length > 0 && (
            <tbody className="mk-apart">
              <tr className="mk-apart-head">
                <th scope="rowgroup" colSpan={4}>
                  Not added to the month
                </th>
              </tr>
              {others.map((k) => (
                <ComponentRow key={k.key} c={k} />
              ))}
            </tbody>
          )}
        </table>
        <p className="mk-legend">
          A month is 30 days: each flow is read over its own window and scaled to 30 days, as its
          line says. DERIVED = {BASIS_MEANING.DERIVED}. ESTIMATED here = the waiting
          proposals&rsquo; own forecasts. Ranges run from the low end to the high end; one figure
          means nothing estimated went in.
          {tableComp?.status === "priced" && (
            <>
              {" "}
              <Link href="/proposals">See what&rsquo;s waiting →</Link>
            </>
          )}
        </p>
        {model.notes.map((n) => (
          <p key={n} className="mk-legend">
            {n}
          </p>
        ))}
      </div>

      <div className="sr-only" id={descId}>
        <table>
          <caption>{table.caption}</caption>
          <thead>
            <tr>
              {table.head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((r) => (
              <tr key={r[0]}>
                {r.map((v, j) =>
                  j === 0 ? (
                    <th key={j} scope="row">
                      {v}
                    </th>
                  ) : (
                    <td key={j}>{v}</td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ComponentRow({ c }: { c: OpportunityComponent }) {
  if (c.status === "absent") {
    return (
      <tr className="mk-absent">
        <th scope="row">{c.label}</th>
        <td className="num" data-label="A month">
          <span className="word none">Not measured</span>
        </td>
        <td data-label="Basis">—</td>
        <td data-label="What would fill it">{capital(c.reason)}.</td>
      </tr>
    );
  }
  const figure = c.monthly ?? c.total;
  return (
    <tr>
      <th scope="row">{c.label}</th>
      <td className="num" data-label={c.kind === "stock" ? "Tied up now" : "A month"}>
        {rangeWhole(figure)}
        {c.kind === "stock" && <span className="mk-unit"> now</span>}
      </td>
      <td data-label="Basis">
        <span className="word">{c.basis}</span>
        {c.basis_note && <span className="mk-note"> {c.basis_note}</span>}
      </td>
      <td className="src" data-label="How">
        {capital(c.formula)}.
        {c.kind === "flow" && c.window.days !== 30 && (
          <>
            {" "}
            Over {num(c.window.days)} days: {rangeWhole(c.total)}, × 30 ÷ {num(c.window.days)}.
          </>
        )}
        {c.note && <> {capital(c.note)}.</>}
      </td>
    </tr>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function EmptyMarket({ model }: { model: EmptyModel }) {
  return (
    <section className="cs mk mk-empty" aria-labelledby="mk-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">Insights · Your numbers as a chart</p>
          <h2 className="cs-title" id="mk-title">
            {model.title}
          </h2>
        </div>
      </header>
      <div className="cs-body">
        <p className="mk-headline">Nothing to draw yet.</p>
        <p className="mk-sub">
          {model.message} <Link href={model.href}>Go to Connections →</Link>
        </p>
        <p className="mk-sub">
          When it&rsquo;s connected, I&rsquo;ll price where money slips away:
        </p>
        <ul className="mk-would">
          {model.components.map((k) => (
            <li key={k.key}>
              <b>{k.label}</b> — {k.reason}.
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
