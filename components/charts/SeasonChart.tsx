"use client";

// The busy-season chart (idea 46, specs/ux-spec-v1.md §2.1): the last 52
// weeks of the business's own measured series, each bar its week against
// the normal week (1.0×), on the chart family's sheet tokens. Busy weeks
// are FILLED ink, quiet weeks HOLLOW, the rest grey; the middle half of
// weeks is a tinted band round 1.0×, and the busy and quiet lines are
// dashed. The weeks that line up with the next eight (52 weeks on) carry a
// bracket. With too little history it draws the weeks there are against
// their own median and says, in its title, that it isn't a season.
//
// Plain SVG at the container's width (useChartWidth); ←/→ step the
// crosshair (lib/charts/keys); every value is also in a table.

import { useState, type KeyboardEvent } from "react";
import "../../app/charts.css";
import { stepKey } from "../../lib/charts/keys";
import { dayMoney, shortDate } from "../../lib/charts/model";
import { num } from "../sheet/num";
import { SheetCard } from "../sheet/PageHead";
import { useChartWidth } from "./useChartWidth";

export interface SeasonChartWeek {
  start: string;
  value: number;
  index: number;
  low: number | null;
  high: number | null;
  flag: "busy" | "quiet" | null;
  /** Lines up with one of the next eight weeks (52 weeks later). */
  ahead: boolean;
}

export interface SeasonChartModel {
  label: string;
  title: string;
  meta: string;
  foot: string;
  summary: string;
  weeks: SeasonChartWeek[];
  /** The middle half of weeks, as multiples of the normal week; null with too little history. */
  band: { low: number; high: number } | null;
  /** Busy and quiet lines are drawn only once seasons can be named. */
  lines: { busy: number; quiet: number } | null;
  currency: string | null;
  noun: string;
}

const x10 = (v: number) => `${(Math.round(v * 10) / 10).toFixed(1)}×`;

export function SeasonChart({ model }: { model: SeasonChartModel }) {
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(720);
  const weeks = model.weeks;
  const TOP = 26;
  const H = narrow ? 130 : 170;
  const AXIS_W = 46;
  const height = TOP + H + 24;
  const plotR = width - AXIS_W;
  const slot = (plotR - 4) / Math.max(1, weeks.length);
  const bw = Math.max(2, Math.min(18, slot * 0.7));
  const xc = (i: number) => 4 + slot * (i + 0.5);
  const top = Math.max(2, ...weeks.map((w) => w.index)) * 1.05;
  const y = (v: number) => TOP + H - (Math.max(0, v) / top) * H;
  const every = Math.max(1, Math.ceil(weeks.length / (narrow ? 4 : 8)));
  const shown = at ?? weeks.length - 1;
  const w = weeks[shown];
  const aheadIdx = weeks.flatMap((wk, i) => (wk.ahead ? [i] : []));

  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, weeks.length);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };
  const value = (v: number) =>
    model.currency ? dayMoney(v, model.currency) : `${num(Math.round(v))} ${model.noun}`;

  return (
    <SheetCard
      className="sc sn"
      label={model.label}
      title={model.title}
      meta={model.meta}
      foot={model.foot}
    >
      <ul className="sc-keys" aria-label="Key">
        {model.lines ? (
          <>
            <li>
              <span className="sc-key sn-busy" aria-hidden="true" /> busy: filled
            </li>
            <li>
              <span className="sc-key sn-quiet" aria-hidden="true" /> quiet: hollow
            </li>
            <li>
              <span className="sc-key sn-band" aria-hidden="true" /> your middle half of weeks
            </li>
          </>
        ) : (
          <li>
            <span className="sc-key sn-plain" aria-hidden="true" /> a week against your median week
          </li>
        )}
      </ul>
      <div className="sc-plot" ref={ref}>
        <svg
          className="sc-svg"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={model.summary}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setAt(null)}
          onPointerMove={(ev) => {
            const r = ev.currentTarget.getBoundingClientRect();
            const i = Math.floor((ev.clientX - r.left - 4) / slot);
            setAt(i >= 0 && i < weeks.length ? i : null);
          }}
          onPointerLeave={() => setAt(null)}
        >
          {model.band && (
            <rect
              className="sn-band"
              x={0}
              width={plotR}
              y={y(model.band.high)}
              height={Math.max(1, y(model.band.low) - y(model.band.high))}
            />
          )}
          <line className="sn-normal" x1={0} x2={plotR} y1={y(1)} y2={y(1)} />
          <text className="tick" x={plotR + 6} y={y(1) + 4}>
            1.0×
          </text>
          {model.lines && (
            <>
              <line
                className="sn-line"
                x1={0}
                x2={plotR}
                y1={y(model.lines.busy)}
                y2={y(model.lines.busy)}
              />
              <line
                className="sn-line"
                x1={0}
                x2={plotR}
                y1={y(model.lines.quiet)}
                y2={y(model.lines.quiet)}
              />
              <text className="tick" x={plotR + 6} y={y(model.lines.busy) - 2}>
                {x10(model.lines.busy)}
              </text>
              <text className="tick" x={plotR + 6} y={y(model.lines.quiet) + 12}>
                {x10(model.lines.quiet)}
              </text>
            </>
          )}
          <text className="tick" x={plotR + 6} y={y(top / 1.05) + 4}>
            {x10(top / 1.05)}
          </text>
          {aheadIdx.length > 0 && (
            <g className="sn-ahead">
              <line
                x1={xc(aheadIdx[0]!) - slot / 2}
                x2={xc(aheadIdx.at(-1)!) + slot / 2}
                y1={TOP - 10}
                y2={TOP - 10}
              />
              <text className="pane-label" x={xc(aheadIdx[0]!) - slot / 2} y={TOP - 14}>
                {narrow ? "NEXT 8 WKS" : "THE NEXT 8 WEEKS, LAST YEAR"}
              </text>
            </g>
          )}
          {weeks.map((wk, i) => {
            const cx = xc(i);
            const y0 = y(wk.index);
            const cls =
              wk.flag === "busy" ? "sn-busy" : wk.flag === "quiet" ? "sn-quiet" : "sn-plain";
            return (
              <g key={wk.start} className={at === i ? "on" : undefined}>
                <rect
                  className={cls}
                  x={cx - bw / 2}
                  y={y0}
                  width={bw}
                  height={Math.max(0.5, y(0) - y0)}
                />
                {i % every === 0 && (
                  <text
                    className="tick"
                    x={i === 0 ? Math.max(0, cx - bw / 2) : cx}
                    y={height - 6}
                    textAnchor={i === 0 ? "start" : "middle"}
                  >
                    {shortDate(wk.start)}
                  </text>
                )}
              </g>
            );
          })}
          <line className="grid" x1={0} x2={plotR} y1={y(0)} y2={y(0)} />
        </svg>
      </div>
      {w && (
        <p className="sc-readout" aria-live="polite">
          <b>Week of {shortDate(w.start)}</b> · {value(w.value)} ·{" "}
          <b>
            {x10(w.index)}
            {w.low !== null && (
              <>
                {" "}
                ({(Math.round(w.low * 10) / 10).toFixed(1)}–
                {w.high === null ? "?" : (Math.round(w.high * 10) / 10).toFixed(1)}×)
              </>
            )}
          </b>{" "}
          your {model.lines ? "normal" : "median"} week
          {w.flag && <> · {w.flag}</>}
        </p>
      )}
      <div className="sr-only">
        <table>
          <caption>{model.summary}</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">
                {model.currency ? `${model.noun} (${model.currency})` : model.noun}
              </th>
              <th scope="col">Against the {model.lines ? "normal" : "median"} week</th>
              <th scope="col">Flag</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((wk) => (
              <tr key={wk.start}>
                <th scope="row">{shortDate(wk.start)}</th>
                <td>{value(wk.value)}</td>
                <td>{x10(wk.index)}</td>
                <td>{wk.flag ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}
