// The Goals screen's weekly candle chart (the owner's Goals design,
// 2026-10-17), drawn as plain SVG — no chart library. One candle per
// measured week (lib/care/chart-view), per day; the cobalt line is the
// path alert mode judges against, the dotted line the target; the right
// edge tags the target and the latest close. Under it, for a revenue
// goal, the week's orders. Every mark is a measured figure or the path's
// own arithmetic; the figure's summary is in its accessible name.

import type { GoalChart } from "../../lib/care/charts";
import { addDays, daysBetween, pathPer30d } from "../../lib/care/chart-view";
import { minorUnitExponent } from "../../lib/core/money";
import { moneyText, num } from "../sheet/num";

const W = 480;
const LEFT = 8;
const RIGHT = W - 62;
const TOP = 22;
const PRICE_BOTTOM_VOL = 172;
const VOL_TOP = 184;
const BOTTOM = 240;

/** A per-day figure: whole units above 100, cents below, counts to one decimal when small. */
export function dayFig(value: number, currency: string | null): string {
  if (currency === null) return num(value, Math.abs(value) < 100 ? 1 : 0);
  const exp = minorUnitExponent(currency);
  const major = value / 10 ** exp;
  return Math.abs(major) < 100
    ? moneyText(Math.round(value), currency)
    : moneyText(Math.round(major) * 10 ** exp, currency);
}

function signedFig(value: number, currency: string | null): string {
  const body = dayFig(Math.abs(value), currency);
  if (Math.abs(value) < 0.5) return dayFig(0, currency);
  return value > 0 ? `+${body}` : `−${body}`;
}

/** A tag's figure, squeezed to the tag when it is long ("12,000 HUF"). */
function TagText({ x, y, text }: { x: number; y: number; text: string }) {
  const room = W - RIGHT - 10;
  return (
    <text
      className="tag-text"
      x={x}
      y={y}
      {...(text.length > 8 ? { textLength: room, lengthAdjust: "spacingAndGlyphs" } : {})}
    >
      {text}
    </text>
  );
}

export function CandleChart({ chart, label }: { chart: GoalChart; label: string }) {
  const { candles, currency } = chart;
  const last = candles.at(-1);
  if (!last) {
    return (
      <div className="gl-chart">
        <p className="gl-nochart">
          {chart.unconnected
            ? `No connection measures ${label} yet, so there is nothing to chart.`
            : `No ${label} measured in the last weeks, so there is nothing to chart yet.`}
        </p>
      </div>
    );
  }

  const span = daysBetween(chart.from, chart.to) + 1;
  const plotW = RIGHT - LEFT;
  const x = (day: string, offset = 0.5) =>
    LEFT + ((daysBetween(chart.from, day) + offset) / span) * plotW;
  const bodyW = Math.max(3, (7 / span) * plotW * 0.55);
  const hasVol = chart.volume !== null && chart.volume.weeks.length > 0;
  const priceBottom = hasVol ? PRICE_BOTTOM_VOL : BOTTOM;

  // The path, per day, from where it starts (or the axis start) to the axis end.
  const measure = {
    set_on: chart.set_on,
    deadline: chart.deadline,
    target_per_30d: chart.target_per_30d,
  };
  const baseline = chart.baseline_per_30d === null ? null : { per_30d: chart.baseline_per_30d };
  const pathDays: string[] = [];
  if (baseline) {
    const start = chart.set_on > chart.from ? chart.set_on : chart.from;
    if (start <= chart.to) {
      pathDays.push(start);
      if (chart.deadline > start && chart.deadline < chart.to) pathDays.push(chart.deadline);
      pathDays.push(chart.to);
    }
  }
  const pathPts = pathDays.map((d) => ({ d, v: (pathPer30d(measure, baseline, d) ?? 0) / 30 }));
  const target = chart.target_per_30d / 30;

  const values = [...candles.flatMap((c) => [c.high, c.low]), ...pathPts.map((p) => p.v), target];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.1;
  lo -= pad;
  hi += pad;
  const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * (priceBottom - TOP);

  const up = last.close >= last.open;
  const todayX = x(chart.today, 1);
  const yTarget = y(target);
  let yNow = y(last.close);
  if (Math.abs(yNow - yTarget) < 16) yNow = yTarget + (yNow >= yTarget ? 16 : -16);

  const volMax = hasVol ? Math.max(1, ...chart.volume!.weeks.map(([, n]) => n)) : 1;
  const dirOf = new Map(candles.map((c) => [c.week, c.close >= c.open ? "up" : "down"]));
  const lastVol = hasVol ? chart.volume!.weeks.find(([w]) => w === last.week)?.[1] : undefined;
  const grid = [0.2, 0.4, 0.6, 0.8].map((f) => TOP + f * (priceBottom - TOP));
  const metricWord = label.charAt(0).toUpperCase() + label.slice(1);

  const summary =
    `${metricWord} per day, ${candles.length} weekly candles. ` +
    `Last week opened ${dayFig(last.open, currency)}, closed ${dayFig(last.close, currency)}` +
    (pathPts.length > 0
      ? `; the path to the target ${dayFig(target, currency)} a day.`
      : `; target ${dayFig(target, currency)} a day, no measured starting point for a path.`);

  return (
    <figure className="gl-chart" style={{ margin: 0 }}>
      <figcaption className="gl-legend">
        <span>
          <b>{metricWord} / day</b>
        </span>
        <span>1W</span>
        <span className={up ? "up" : "down"}>
          O {dayFig(last.open, currency)} H {dayFig(last.high, currency)} L{" "}
          {dayFig(last.low, currency)} C {dayFig(last.close, currency)}{" "}
          {signedFig(last.close - last.open, currency)}
        </span>
        {lastVol !== undefined && (
          <>
            <br />
            <span style={{ marginLeft: 0 }}>
              Vol <b>{num(lastVol)}</b> {chart.volume!.label}
            </span>
          </>
        )}
      </figcaption>
      <svg
        className="gl-svg"
        viewBox={`0 0 ${W} ${BOTTOM + 8}`}
        role="img"
        aria-label={summary}
        preserveAspectRatio="xMidYMid meet"
      >
        {grid.map((gy) => (
          <line key={gy} className="grid" x1={LEFT} x2={RIGHT} y1={gy} y2={gy} />
        ))}
        <line className="grid" x1={RIGHT} x2={RIGHT} y1={TOP - 10} y2={BOTTOM} />
        {todayX <= RIGHT && (
          <>
            <line className="today" x1={todayX} x2={todayX} y1={TOP - 8} y2={BOTTOM} />
            <text className="today-label" x={todayX + 4} y={TOP - 1}>
              TODAY
            </text>
          </>
        )}
        <line className="target" x1={LEFT} x2={RIGHT} y1={yTarget} y2={yTarget} />
        {pathPts.length > 1 && (
          <polyline
            className="path"
            points={pathPts.map((p) => `${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ")}
          />
        )}
        {candles.map((c) => {
          const cx = x(addDays(c.week, 3));
          const cls = c.close >= c.open ? "up" : "down";
          const top = y(Math.max(c.open, c.close));
          const h = Math.max(1.5, Math.abs(y(c.open) - y(c.close)));
          return (
            <g key={c.week} className={cls}>
              <line className="wick" x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} />
              <rect className="body" x={cx - bodyW / 2} y={top} width={bodyW} height={h} />
            </g>
          );
        })}
        {hasVol &&
          chart.volume!.weeks.map(([week, n]) => {
            const cx = x(addDays(week, 3));
            const h = (n / volMax) * (BOTTOM - VOL_TOP);
            return (
              <rect
                key={week}
                className={`vol ${dirOf.get(week) ?? "up"}`}
                x={cx - bodyW / 2}
                y={BOTTOM - h}
                width={bodyW}
                height={h}
              />
            );
          })}
        <rect
          className="tag-target"
          x={RIGHT + 2}
          y={yTarget - 8}
          width={W - RIGHT - 2}
          height={16}
        />
        <TagText x={RIGHT + 6} y={yTarget + 4} text={dayFig(target, currency)} />
        <rect
          className={`tag-now ${up ? "up" : "down"}`}
          x={RIGHT + 2}
          y={yNow - 8}
          width={W - RIGHT - 2}
          height={16}
        />
        <TagText x={RIGHT + 6} y={yNow + 4} text={dayFig(last.close, currency)} />
      </svg>
    </figure>
  );
}
