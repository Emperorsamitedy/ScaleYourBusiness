"use client";

// "Your business, read like a stock." — the chosen illustrative business's
// revenue as a candlestick chart (./Demos: the webshop by default, or the
// salon), with the day each leak began marked and the gap to the no-leak
// line shaded, as the owner's landing design (2026-10-17) draws it. 1D /
// 1W switch the bucket, "Leak overlay" toggles the shading, and the
// crosshair follows the pointer. Local state only.
//
// L-3d: its words are the "landing.storeChart" catalogue (the series' own
// words repeat there in English); figures and dates in the reader's
// language, in euros as the series is, never converted.

import { useMemo, useState, type PointerEvent } from "react";
import type { AppLocale } from "../../lib/i18n/locales";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import {
  CHART_CURRENCY,
  CHART_DAY_COUNT,
  type Candle,
  type ChartSeries,
} from "../../lib/marketing/sample-chart";
import { useDemo } from "./Demos";
import { chartDay } from "./words";

// Plot geometry, in viewBox units (1000 × 420).
const X0 = 10;
const X1 = 900;
const Y0 = 20;
const Y1 = 300;
const V0 = 318;
const V1 = 386;
const UP = "#26A69A";
const DOWN = "#EF5350";

const euros = (minor: number) => minor / 100;
/** Whole euros: "€1,234" in English, as the chart always printed them. */
const eur = (v: number, locale: AppLocale) =>
  moneyText(Math.round(v) * 100, CHART_CURRENCY, locale);

/** The price axis, in euros, and the y of a value on it. */
function axisOf(series: ChartSeries) {
  const LO = euros(series.axis.lo_minor);
  const HI = euros(series.axis.hi_minor);
  return { LO, HI, Y: (v: number) => Y1 - ((v - LO) / (HI - LO)) * (Y1 - Y0) };
}

function geometry(
  series: ChartSeries,
  data: readonly Candle[],
  weekly: boolean,
  locale: AppLocale,
  labelOf: (key: string) => string,
) {
  const { LO, HI, Y } = axisOf(series);
  const N = data.length;
  const slot = (X1 - X0) / N;
  const bw = Math.max(3, slot * 0.66);
  const X = (i: number) => X0 + slot * (i + 0.5);
  const maxV = Math.max(...data.map((k) => k.volume));
  let bU = "";
  let bD = "";
  let wU = "";
  let wD = "";
  let vU = "";
  let vD = "";
  let ideal = "";
  let bot = "";
  data.forEach((k, i) => {
    const x = X(i);
    const o = euros(k.open_minor);
    const c = euros(k.close_minor);
    const up = c >= o;
    const yo = Y(o);
    const yc = Y(c);
    const t = Math.min(yo, yc);
    const hh = Math.max(1, Math.abs(yo - yc));
    const body = `M${(x - bw / 2).toFixed(1)} ${t.toFixed(1)}h${bw.toFixed(1)}v${hh.toFixed(1)}h${(-bw).toFixed(1)}Z`;
    const wick = `M${x.toFixed(1)} ${Y(euros(k.high_minor)).toFixed(1)}V${Y(euros(k.low_minor)).toFixed(1)}`; // not money: an SVG path's pixel coordinates
    const vh = (k.volume / maxV) * (V1 - V0);
    const vol = `M${(x - bw / 2).toFixed(1)} ${(V1 - vh).toFixed(1)}h${bw.toFixed(1)}V${V1}h${(-bw).toFixed(1)}Z`;
    if (up) {
      bU += body;
      wU += wick;
      vU += vol;
    } else {
      bD += body;
      wD += wick;
      vD += vol;
    }
    const iy = Y(euros(k.ideal_minor)).toFixed(1); // not money: a pixel coordinate
    ideal += `${i ? "L" : "M"}${x.toFixed(1)} ${iy}`;
    bot = `L${x.toFixed(1)} ${yc.toFixed(1)}${bot}`;
  });

  let grid = "";
  const ticks: { y: string; l: string }[] = [];
  for (let g = 0; g <= 4; g++) {
    const val = LO + ((HI - LO) * g) / 4;
    const yy = Y(val);
    grid += `M0 ${yy.toFixed(1)}H920`;
    ticks.push({ y: (yy + 4).toFixed(1), l: eur(val, locale) });
  }
  for (let gx = 0; gx < N; gx += Math.max(1, Math.round(N / 6))) {
    grid += `M${X(gx).toFixed(1)} 0V390`;
  }
  const xl: { x: string; l: string }[] = [];
  for (let q = 0; q < N; q += Math.max(1, Math.round(N / 5))) {
    xl.push({ x: X(q).toFixed(1), l: chartDay(data[q]!.day, locale) });
  }

  const events = series.events.map((e, i) => {
    const idx = weekly ? Math.min(N - 1, Math.floor(e.day / 7)) : e.day;
    const x = X(idx);
    const yl = Y(euros(data[idx]!.low_minor)) + 10;
    const label = labelOf(`${e.key}.label`);
    const letter = labelOf(`${e.key}.key`);
    const lw = label.length * 6.6 + 16;
    // Every other label steps down, so neighbours never overlap.
    const ly = 30 + (i % 2 === 1 ? 26 : 0);
    return { ...e, label, letter, x, yl, lw, ly };
  });

  return {
    N,
    slot,
    X,
    bU: bU || "M0 0",
    bD: bD || "M0 0",
    wU: wU || "M0 0",
    wD: wD || "M0 0",
    vU: vU || "M0 0",
    vD: vD || "M0 0",
    ideal,
    gapArea: `${ideal}${bot}Z`,
    grid,
    ticks,
    xl,
    events,
  };
}

export function StoreChart() {
  const { chart } = useDemo();
  const { tr, locale } = useTr("landing.storeChart");
  const own = (key: string, values?: Record<string, string | number>) =>
    tr(`${chart.id}.${key}`, values);
  const money = (v: number) => eur(v, locale);
  const [tf, setTf] = useState<"D" | "W">("D");
  const [gap, setGap] = useState(true);
  const [hover, setHover] = useState(-1);
  const [hoverY, setHoverY] = useState(0);

  const weekly = tf === "W";
  const data = weekly ? chart.weeks : chart.days;
  const g = useMemo(
    () => geometry(chart, data, weekly, locale, (key) => tr(`${chart.id}.${key}`)),
    // `tr` is a new function each render but follows the locale, so the locale stands for it.
    [chart, data, weekly, locale],
  );
  const { LO, HI, Y } = axisOf(chart);

  const last = data[g.N - 1]!;
  const lastC = euros(last.close_minor);
  const lastColor = last.close_minor >= last.open_minor ? UP : DOWN;
  const hi = hover >= 0 && hover < g.N ? hover : g.N - 1;
  const hk = data[hi]!;
  const legendColor = { color: hk.close_minor >= hk.open_minor ? UP : DOWN };
  const hyVal = LO + ((Y1 - hoverY) / (Y1 - Y0)) * (HI - LO);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * 1000;
    const vy = ((e.clientY - r.top) / r.height) * 420;
    const idx = Math.floor((vx - X0) / g.slot);
    if (idx < 0 || idx >= g.N || vx > 920) {
      setHover(-1);
      return;
    }
    setHover(idx);
    setHoverY(Math.max(0, Math.min(390, vy)));
  };

  const mini = (on: boolean) => (on ? "ll-mini on" : "ll-mini");

  return (
    <>
      <div className="ll-tv" style={{ marginTop: 40 }}>
        <div className="ll-tv-bar">
          <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
            <span
              className="ll-m"
              style={{ fontWeight: 600, fontSize: 13, padding: "0 10px 0 4px" }}
            >
              {own("title")}
            </span>
            <span className="ll-tv-sep" aria-hidden="true" />
            <button
              type="button"
              className={mini(tf === "D")}
              onClick={() => {
                setTf("D");
                setHover(-1);
              }}
              aria-pressed={tf === "D"}
            >
              {tr("day", { count: num(1, 0, locale) })}
            </button>
            <button
              type="button"
              className={mini(tf === "W")}
              onClick={() => {
                setTf("W");
                setHover(-1);
              }}
              aria-pressed={tf === "W"}
            >
              {tr("week", { count: num(1, 0, locale) })}
            </button>
            <span className="ll-tv-sep" aria-hidden="true" />
            <button
              type="button"
              className={mini(gap)}
              onClick={() => setGap((v) => !v)}
              aria-pressed={gap}
            >
              {tr("overlay")}
            </button>
          </div>
          <span className="ll-m" style={{ fontSize: 11.5, color: "#5D6B78" }}>
            {own("subtitle", { days: CHART_DAY_COUNT })}
          </span>
        </div>
        <div className="ll-m ll-tv-legend">
          <span style={{ color: "#131722", fontWeight: 600 }}>
            {weekly ? tr("weekOf", { day: chartDay(hk.day, locale) }) : chartDay(hk.day, locale)}
          </span>
          <span>
            {tr("open")} <span style={legendColor}>{money(euros(hk.open_minor))}</span>
          </span>
          <span>
            {tr("high")} <span style={legendColor}>{money(euros(hk.high_minor))}</span>
          </span>
          <span>
            {tr("low")} <span style={legendColor}>{money(euros(hk.low_minor))}</span>
          </span>
          <span>
            {tr("close")} <span style={legendColor}>{money(euros(hk.close_minor))}</span>
          </span>
          <span>
            {own("volume")} <span style={legendColor}>{num(hk.volume, 0, locale)}</span>
          </span>
          {gap && (
            <>
              <span style={{ color: "#2962FF" }}>
                {tr("withoutLeaks", { value: money(euros(hk.ideal_minor)) })}
              </span>
              <span style={{ color: "#EF5350" }}>
                {tr("gap", {
                  value: money(Math.max(0, euros(hk.ideal_minor - hk.close_minor))),
                })}
              </span>
            </>
          )}
        </div>
        <svg
          viewBox="0 0 1000 420"
          role="img"
          aria-label={own("description", { days: CHART_DAY_COUNT })}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(-1)}
          className="ll-chart"
        >
          <path d={g.grid} stroke="#EEF0F4" strokeWidth="1" fill="none" />
          <line x1="920" y1="0" x2="920" y2="390" stroke="#E0E3EB" />
          <line x1="0" y1="390" x2="1000" y2="390" stroke="#E0E3EB" />
          {gap && (
            <>
              <path d={g.gapArea} fill="rgba(239,83,80,.12)" />
              <path
                d={g.ideal}
                fill="none"
                stroke="#2962FF"
                strokeWidth="1.6"
                strokeDasharray="4 4"
              />
            </>
          )}
          <path d={g.vU} fill="rgba(38,166,154,.4)" />
          <path d={g.vD} fill="rgba(239,83,80,.4)" />
          <path d={g.wU} stroke={UP} strokeWidth="1" fill="none" />
          <path d={g.wD} stroke={DOWN} strokeWidth="1" fill="none" />
          <path d={g.bU} fill={UP} />
          <path d={g.bD} fill={DOWN} />
          {g.events.map((e) => (
            <g key={e.key}>
              <line
                x1={e.x.toFixed(1)}
                y1={(e.ly + 20).toFixed(1)}
                x2={e.x.toFixed(1)}
                y2={e.yl.toFixed(1)}
                stroke="#2962FF"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <rect
                x={(e.x - 9).toFixed(1)}
                y={e.yl.toFixed(1)}
                width="18"
                height="18"
                fill="#2962FF"
              />
              <text
                x={e.x.toFixed(1)}
                y={(e.yl + 13).toFixed(1)}
                textAnchor="middle"
                fontSize="11"
                fontWeight="600"
                fill="#FFFFFF"
              >
                {e.letter}
              </text>
              <rect
                x={(e.x - 8).toFixed(1)}
                y={e.ly}
                width={e.lw.toFixed(0)}
                height="20"
                fill="#FFFFFF"
                stroke="#2962FF"
              />
              <text x={e.x.toFixed(1)} y={e.ly + 14} fontSize="10.5" fill="#131722">
                {e.letter} · {e.label}
              </text>
            </g>
          ))}
          <line
            x1="0"
            y1={Y(lastC).toFixed(1)}
            x2="920"
            y2={Y(lastC).toFixed(1)}
            stroke={lastColor}
            strokeDasharray="1 3"
          />
          {g.ticks.map((t) => (
            <text key={t.l} x="928" y={t.y} fontSize="11" fill="#5D6B78">
              {t.l}
            </text>
          ))}
          <rect x="921" y={(Y(lastC) - 10).toFixed(1)} width="79" height="20" fill={lastColor} />
          <text x="928" y={(Y(lastC) + 4).toFixed(1)} fontSize="11" fontWeight="600" fill="#FFFFFF">
            {money(lastC)}
          </text>
          {g.xl.map((x) => (
            <text key={x.x} x={x.x} y="408" fontSize="11" fill="#5D6B78" textAnchor="middle">
              {x.l}
            </text>
          ))}
          {hover >= 0 && (
            <>
              <line
                x1={g.X(hi).toFixed(1)}
                y1="0"
                x2={g.X(hi).toFixed(1)}
                y2="390"
                stroke="#9598A1"
                strokeDasharray="4 4"
              />
              <line
                x1="0"
                y1={hoverY.toFixed(1)}
                x2="920"
                y2={hoverY.toFixed(1)}
                stroke="#9598A1"
                strokeDasharray="4 4"
              />
              <rect x="921" y={(hoverY - 10).toFixed(1)} width="79" height="20" fill="#131722" />
              <text x="928" y={(hoverY + 4).toFixed(1)} fontSize="11" fill="#FFFFFF">
                {money(hyVal)}
              </text>
              <rect x={(g.X(hi) - 48).toFixed(1)} y="391" width="96" height="20" fill="#131722" />
              <text x={g.X(hi).toFixed(1)} y="405" textAnchor="middle" fontSize="11" fill="#FFFFFF">
                {chartDay(hk.day, locale)}
              </text>
            </>
          )}
        </svg>
      </div>
      <div className="ll-chart-key">
        {chart.events.map((e) => (
          <div key={e.key} className="ll-m">
            <span className="ll-chart-keybox" aria-hidden="true">
              {own(`${e.key}.key`)}
            </span>
            {own(`${e.key}.note`)}
          </div>
        ))}
      </div>
    </>
  );
}
