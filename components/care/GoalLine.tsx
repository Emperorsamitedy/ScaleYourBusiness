"use client";

// Insights · Goals — one goal's measured series as a line (said plainly on
// 2026-11-28, the canvas design the owner approved, in the TradingView style
// the owner asked for on Home: a line, the value scale on the right with the
// latest value in a filled tag). Each point is a week's average a day over
// its measured days (lib/care/chart-view weeklyAverages); the target per day
// is dashed with its own tag; a mark shows the week the goal was set. In
// place of the weekly candles, whose open/high/low/close read as a trading
// screen. Plain SVG at the container's width (useChartWidth); every value is
// also in a table for screen readers.

import { useChartWidth } from "../charts/useChartWidth";
import { shortDate } from "../../lib/charts/model";
import type { GoalChart } from "../../lib/care/charts";
import { minorUnitExponent } from "../../lib/core/money";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";

export function GoalLine({ chart, metric }: { chart: GoalChart; metric: string }) {
  const { tr, locale } = useTr("goals");
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(560);
  const pts = chart.weekly;
  const value = (v: number) => {
    if (chart.currency === null) return num(Math.round(v), 0, locale);
    const unit = 10 ** minorUnitExponent(chart.currency);
    return moneyText(Math.round(v / unit) * unit, chart.currency, locale);
  };
  const title = tr("line.title", { metric });
  if (pts.length < 2) {
    return (
      <div className="gl-line" ref={ref}>
        <p className="gl-line-title">{title}</p>
        <p className="gl-nochart">
          {chart.unconnected
            ? tr("candle.noneUnconnected", { metric })
            : tr("candle.noneMeasured", { metric })}
        </p>
      </div>
    );
  }
  const target = chart.target_per_30d / 30;
  const vals = pts.map((p) => p.per_day);
  const lo = Math.min(...vals, target);
  const hi = Math.max(...vals, target);
  const pad = (hi - lo) * 0.12 || hi * 0.1 || 1;
  const min = Math.max(0, lo - pad);
  const max = hi + pad;
  const TAG = narrow ? 74 : 92;
  const plot = Math.max(120, width - TAG - 6);
  const top = 14;
  const bottom = narrow ? 150 : 176;
  const height = bottom + 24;
  const x = (i: number) => 4 + (i * (plot - 8)) / (pts.length - 1);
  const y = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top);
  const line = pts
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.per_day).toFixed(1)}`)
    .join(" ");
  const last = pts.length - 1;
  const area = `${line} L${x(last).toFixed(1)},${bottom} L${x(0).toFixed(1)},${bottom} Z`;
  const setIdx = pts.findIndex((p) => p.week >= chart.set_on.slice(0, 10));
  // Keep the two tags apart when the latest week sits close to the target.
  const lastY = y(vals[last]!);
  let targetY = y(target);
  if (Math.abs(lastY - targetY) < 22) targetY = lastY + (targetY >= lastY ? 22 : -22);
  // Month names along the bottom, never closer than a label's width.
  const ticks: { i: number; text: string }[] = [];
  let lastX = -Infinity;
  pts.forEach((p, i) => {
    if (Number(p.week.slice(8, 10)) > 7) return;
    const text = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(
      new Date(`${p.week}T00:00:00Z`),
    );
    if (x(i) - lastX < 40) return;
    ticks.push({ i, text });
    lastX = x(i);
  });
  const summary = tr("line.summary", {
    metric,
    count: pts.length,
    last: value(vals[last]!),
    target: value(target),
  });
  return (
    <div className="gl-line" ref={ref}>
      <p className="gl-line-title">{title}</p>
      <svg
        className="gl-line-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
      >
        <path className="gl-area" d={area} />
        <line className="gl-target" x1={0} x2={plot} y1={y(target)} y2={y(target)} />
        <rect
          className="gl-tag-target"
          x={plot + 6}
          y={targetY - 10}
          width={TAG}
          height={20}
          rx={3}
        />
        <text className="gl-tag-text" x={plot + 6 + TAG / 2} y={targetY + 4} textAnchor="middle">
          {tr("line.target", { value: value(target) })}
        </text>
        {setIdx > 0 && (
          <g className="gl-set">
            <line x1={x(setIdx)} x2={x(setIdx)} y1={top} y2={bottom} />
            <text x={x(setIdx) - 4} y={top + 8} textAnchor="end">
              {tr("line.set")}
            </text>
          </g>
        )}
        <path className="gl-path" d={line} />
        <circle className="gl-dot" cx={x(last)} cy={lastY} r={3.5} />
        <rect className="gl-tag-now" x={plot + 6} y={lastY - 10} width={TAG} height={20} rx={3} />
        <text className="gl-tag-text now" x={plot + 6 + TAG / 2} y={lastY + 4} textAnchor="middle">
          {value(vals[last]!)}
        </text>
        <line className="gl-axis" x1={0} x2={plot} y1={bottom} y2={bottom} />
        {ticks.map((t) => (
          <text key={t.i} className="gl-tick" x={x(t.i)} y={bottom + 17}>
            {t.text}
          </text>
        ))}
      </svg>
      <div className="sr-only">
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">{tr("line.colWeek")}</th>
              <th scope="col">{tr("line.colPerDay")}</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.week}>
                <th scope="row">{shortDate(p.week, locale)}</th>
                <td>{value(p.per_day)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
