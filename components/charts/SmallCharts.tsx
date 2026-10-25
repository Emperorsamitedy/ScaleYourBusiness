"use client";

// The smaller charts beside the market chart (specs/ux-spec-v1.md §2.1),
// each drawn only where there is a data story (lib/charts/small):
//
//   BookingsChart  completed appointments against no-shows and late
//                  cancellations, week by week — completed FILLED, no-shows
//                  HOLLOW, late cancellations tinted, stacked with a gap —
//                  and, in its own pane on its own axis, what the missed
//                  slots were worth (the low end solid, the range lighter)
//   AdsChart       per campaign, spend (a hollow bar) against what Meta
//                  attributes back (a filled bar) on one shared scale, the
//                  even line dashed; LOSING / PAYS BACK as worded flags
//
// Plain SVG, sheet tokens only (app/charts.css); keyboard stepping by
// ←/→ on the bookings chart; every value is also in a table.

import { useMemo, useState, type KeyboardEvent } from "react";
import { num } from "../sheet/num";
import { stepKey } from "../../lib/charts/keys";
import { dayMoney, shortDate } from "../../lib/charts/model";
import { rangeWhole } from "../../lib/charts/opportunity";
import type { AdsChartModel, BookingsChartModel } from "../../lib/charts/small";
import { SheetCard } from "../sheet/PageHead";
import { useChartWidth } from "./useChartWidth";

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function BookingsChart({ model }: { model: BookingsChartModel }) {
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(480);
  const weeks = model.weeks;
  const money = model.currency !== null;
  const TOP = 22;
  const COUNT_H = narrow ? 110 : 130;
  const MONEY_TOP = TOP + COUNT_H + 26;
  const MONEY_H = money ? 60 : 0;
  const AXIS_W = 62;
  const height = (money ? MONEY_TOP + MONEY_H : TOP + COUNT_H) + 22;
  const plotR = width - AXIS_W;
  const slot = (plotR - 4) / Math.max(1, weeks.length);
  const bw = Math.max(3, Math.min(26, slot * 0.6));
  const x = (i: number) => 4 + slot * (i + 0.5);
  const maxCount = Math.max(1, ...weeks.map((w) => w.completed + w.no_show + (w.late ?? 0)));
  const maxLost = Math.max(1, ...weeks.map((w) => w.lost_high_minor ?? 0));
  const yc = (v: number) => TOP + COUNT_H - (v / maxCount) * COUNT_H;
  const ym = (v: number) => MONEY_TOP + MONEY_H - (v / maxLost) * MONEY_H;
  const every = Math.max(1, Math.ceil(weeks.length / (narrow ? 3 : 6)));
  const shown = at ?? weeks.length - 1;
  const w = weeks[shown];
  const cur = model.currency ?? "";

  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, weeks.length);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };

  return (
    <SheetCard
      className="sc"
      label="Bookings · week by week"
      title="Kept, missed and what the missed ones were worth"
      meta={
        <>
          {capital(model.source)}
          <br />
          <span className="word">OBSERVED</span> counts · <span className="word">DERIVED</span>{" "}
          money
        </>
      }
      foot={model.lost_note}
    >
      <ul className="sc-keys" aria-label="Key">
        <li>
          <span className="sc-key completed" aria-hidden="true" /> completed: filled
        </li>
        <li>
          <span className="sc-key noshow" aria-hidden="true" /> no-show: hollow
        </li>
        {model.late_separated && (
          <li>
            <span className="sc-key late" aria-hidden="true" /> late cancellation: tinted
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
          {[0.5, 1].map((f) => (
            <line
              key={f}
              className="grid"
              x1={0}
              x2={plotR}
              y1={yc(maxCount * f)}
              y2={yc(maxCount * f)}
            />
          ))}
          <text className="tick" x={plotR + 6} y={yc(maxCount) + 4}>
            {num(maxCount)}
          </text>
          <text className="tick" x={plotR + 6} y={yc(0) + 4}>
            0
          </text>
          {weeks.map((wk, i) => {
            const cx = x(i);
            const c0 = yc(wk.completed);
            const n0 = yc(wk.completed + wk.no_show);
            const l0 = yc(wk.completed + wk.no_show + (wk.late ?? 0));
            return (
              <g key={wk.start} className={at === i ? "on" : undefined}>
                <rect
                  className="completed"
                  x={cx - bw / 2}
                  y={c0}
                  width={bw}
                  height={Math.max(0, yc(0) - c0)}
                />
                {wk.no_show > 0 && (
                  <rect
                    className="noshow"
                    x={cx - bw / 2 + 0.75}
                    y={n0 + 0.75}
                    width={bw - 1.5}
                    height={Math.max(0.5, c0 - n0 - 2.5)}
                  />
                )}
                {(wk.late ?? 0) > 0 && (
                  <rect
                    className="late"
                    x={cx - bw / 2 + 0.5}
                    y={l0 + 0.5}
                    width={bw - 1}
                    height={Math.max(0.5, n0 - l0 - 2)}
                  />
                )}
                {money && wk.lost_high_minor !== null && wk.lost_high_minor > 0 && (
                  <>
                    <rect
                      className="lost-hi"
                      x={cx - bw / 2}
                      y={ym(wk.lost_high_minor)}
                      width={bw}
                      height={Math.max(0.5, ym(0) - ym(wk.lost_high_minor))}
                    />
                    <rect
                      className="lost-lo"
                      x={cx - bw / 2}
                      y={ym(wk.lost_low_minor ?? 0)}
                      width={bw}
                      height={Math.max(0, ym(0) - ym(wk.lost_low_minor ?? 0))}
                    />
                  </>
                )}
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
          <text className="pane-label" x={4} y={TOP - 8}>
            APPOINTMENTS
          </text>
          {money && (
            <>
              <line className="grid" x1={0} x2={plotR} y1={ym(0)} y2={ym(0)} />
              <text className="pane-label" x={4} y={MONEY_TOP - 8}>
                MISSED, WORTH ({cur})
              </text>
              <text className="tick" x={plotR + 6} y={ym(maxLost) + 4}>
                {dayMoney(maxLost, cur)}
              </text>
            </>
          )}
        </svg>
      </div>
      {w && (
        <p className="sc-readout" aria-live="polite">
          <b>Week of {shortDate(w.start)}</b> · {num(w.completed)} completed · {num(w.no_show)}{" "}
          no-shows
          {w.late !== null && <> · {num(w.late)} late cancellations</>}
          {money && w.lost_high_minor !== null && (
            <>
              {" "}
              · missed worth{" "}
              <b>
                {rangeWhole({
                  low_minor: w.lost_low_minor ?? 0,
                  high_minor: w.lost_high_minor,
                  currency: cur,
                })}
              </b>
            </>
          )}
        </p>
      )}
      <div className="sr-only">
        <table>
          <caption>Appointments a week, and what the missed ones were worth</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col">Completed</th>
              <th scope="col">No-shows</th>
              {model.late_separated && <th scope="col">Late cancellations</th>}
              {money && <th scope="col">Missed, worth ({cur})</th>}
            </tr>
          </thead>
          <tbody>
            {weeks.map((wk) => (
              <tr key={wk.start}>
                <th scope="row">{shortDate(wk.start)}</th>
                <td>{num(wk.completed)}</td>
                <td>{num(wk.no_show)}</td>
                {model.late_separated && <td>{num(wk.late ?? 0)}</td>}
                {money && (
                  <td>
                    {rangeWhole({
                      low_minor: wk.lost_low_minor ?? 0,
                      high_minor: wk.lost_high_minor ?? 0,
                      currency: cur,
                    })}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}

export function AdsChart({ model }: { model: AdsChartModel }) {
  const byCurrency = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of model.campaigns) {
      m.set(c.currency, Math.max(m.get(c.currency) ?? 1, c.spend_minor, c.value_minor));
    }
    return m;
  }, [model.campaigns]);
  // Bars only, no text inside: the drawing stretches to its cell.
  const barW = 200;
  return (
    <SheetCard
      className="sc"
      label={`Ads · the last ${num(model.window.days)} days`}
      title={
        model.losing === 0
          ? "Every campaign brings back what it costs"
          : `${num(model.losing)} campaign${model.losing === 1 ? "" : "s"} cost${model.losing === 1 ? "s" : ""} more than it brings back`
      }
      meta={
        <>
          Meta Ads · {shortDate(model.window.from)}–{shortDate(model.window.to)}
          <br />
          <span className="word">DERIVED</span> from Meta&rsquo;s own attribution
        </>
      }
      foot="Return = the purchase value Meta attributes to the campaign ÷ what it spent. Below 1.0 it loses money by Meta's own count — the line I propose a pause at."
    >
      <ul className="sc-keys" aria-label="Key">
        <li>
          <span className="sc-key spend" aria-hidden="true" /> spent: hollow
        </li>
        <li>
          <span className="sc-key ret" aria-hidden="true" /> Meta attributes back: filled
        </li>
      </ul>
      <table className="rt rt-stack sc-ads">
        <caption className="sr-only">{model.summary}</caption>
        <thead>
          <tr>
            <th scope="col">Campaign</th>
            <th scope="col">Spent against back</th>
            <th scope="col" className="num">
              Return
            </th>
            <th scope="col">Flag</th>
          </tr>
        </thead>
        <tbody>
          {model.campaigns.map((c) => {
            const max = byCurrency.get(c.currency) ?? 1;
            const sw = (c.spend_minor / max) * (barW - 4);
            const vw = (c.value_minor / max) * (barW - 4);
            return (
              <tr key={c.campaign_ref}>
                <th scope="row">{c.campaign_name}</th>
                <td data-label="Spent / back">
                  <svg
                    className="sc-bars"
                    viewBox={`0 0 ${barW} 30`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <rect
                      className="spend"
                      x={1}
                      y={2}
                      width={Math.max(1, sw)}
                      height={11}
                      vectorEffect="non-scaling-stroke"
                    />
                    <rect className="ret" x={1} y={17} width={Math.max(1, vw)} height={11} />
                    <line
                      className="even"
                      x1={1 + sw}
                      x2={1 + sw}
                      y1={0}
                      y2={30}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <span className="sc-note">
                    {dayMoney(c.spend_minor, c.currency)} spent ·{" "}
                    {dayMoney(c.value_minor, c.currency)} back
                  </span>
                </td>
                <td className="num" data-label="Return">
                  {c.roas === null ? "—" : num(c.roas, 2)}
                </td>
                <td data-label="Flag">
                  {c.losing ? (
                    <span className="flag alarm">Losing</span>
                  ) : (
                    <span className="flag ok">Pays back</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SheetCard>
  );
}
