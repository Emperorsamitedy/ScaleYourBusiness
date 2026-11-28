"use client";

// Seasons & bundles · the year, week by week (idea 46; said plainly on
// 2026-11-28, the canvas design the owner approved). Each bar is one week
// of the last year against the normal week: busy weeks filled green, quiet
// weeks amber, the rest grey. Nothing to decode: the chart is labelled on
// its own bars (last year's stretch that lines up with the weeks ahead, the
// next one if there's room, and the stretch this year is in now), the
// value scale sits on the right with the normal week marked, and a bracket
// marks the weeks that line up with the next eight.
//
// Plain SVG at the container's width (useChartWidth), so the words keep
// their real size on a phone. A label that has no room is left out rather
// than drawn over a bar. Every value is also in a table for screen readers.

import { useChartWidth } from "../charts/useChartWidth";
import { shortDate } from "../../lib/charts/model";
import type { SeasonResult } from "../../lib/seasons/forecast";
import { useTr } from "../sheet/useTr";
import { capitalFirst, currentRun, signedPct, sizePct, weekValue } from "./patterns-view";

type Ready = Extract<SeasonResult, { status: "ready" }>;

/** Rough width of a line of text at a size: Archivo averages about half an em a character. */
const textWidth = (s: string, size: number, bold = false) => s.length * size * (bold ? 0.56 : 0.52);

interface Label {
  x: number;
  anchor: "start" | "end";
  title: string;
  sub?: string;
  /** Where its leader line ends: the top of the bar it names. */
  to?: { x: number; y: number };
  y: number;
}

export function YearChart({ r }: { r: Ready }) {
  const { tr, locale } = useTr("patterns");
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(880);
  const weeks = r.weeks;
  const money = r.series.currency;
  const value = (v: number) => weekValue(v, money, r.series.noun, locale);
  const normal = r.normal.median;

  const GUTTER = narrow ? 70 : 92;
  const plotW = Math.max(120, width - GUTTER);
  const slot = plotW / Math.max(1, weeks.length);
  const bw = Math.max(2, Math.min(20, slot - (slot > 8 ? 3 : 1)));
  const xl = (i: number) => i * slot + (slot - bw) / 2;
  const xc = (i: number) => i * slot + slot / 2;
  const peak = Math.max(2, ...weeks.map((w) => w.index));
  const indexOf = (start: string) => weeks.findIndex((w) => w.start === start);

  // ── the words on the bars ──
  const first = r.upcoming[0];
  const second = r.upcoming.find((u) => u.run.kind !== first?.run.kind);
  const now = currentRun(weeks);
  const runWords = (u: Ready["upcoming"][number]) => ({
    title: tr("chart.lastYear", { kind: u.run.kind }),
    sub: tr("chart.lastYearSub", {
      kind: u.run.kind,
      total: value(u.run.total),
      count: u.run.weeks,
      pct: sizePct(u.run.index, locale),
    }),
  });
  const left = first && indexOf(first.run.start) >= 0 ? runWords(first) : null;
  const right = now ? tr("chart.now", { kind: now.kind, day: shortDate(now.start, locale) }) : null;
  const leftW = left ? Math.max(textWidth(left.title, 13, true), textWidth(left.sub, 12.5)) : 0;
  const rightW = right ? textWidth(right, 13, true) : 0;
  // Side by side when both fit with a gap; otherwise the right one drops a row.
  const stacked = left !== null && right !== null && leftW + rightW + 32 > plotW;
  const TOP = (stacked ? 84 : 50) + 8;
  const H = narrow ? 150 : 200;
  const bottom = TOP + H;
  const top = peak * 1.04;
  const y = (v: number) => bottom - (Math.max(0, v) / top) * H;

  const labels: Label[] = [];
  if (left && first) {
    const i = indexOf(first.run.start);
    labels.push({
      x: Math.max(0, xl(i)),
      anchor: "start",
      y: 16,
      ...left,
      to: { x: xc(i), y: y(weeks[i]!.index) - 3 },
    });
  }
  if (right && now) {
    const i = weeks.length - 1;
    labels.push({
      x: plotW,
      anchor: "end",
      y: stacked ? 58 : 16,
      title: right,
      to: { x: xc(i), y: y(weeks[i]!.index) - 3 },
    });
  }
  // The next stretch, set just above the bars it covers, if it fits inside the plot.
  if (second && !narrow) {
    const i = indexOf(second.run.start);
    const words = runWords(second);
    const w = Math.max(textWidth(words.title, 13, true), textWidth(words.sub, 12.5));
    const x = i >= 0 ? xl(i) : -1;
    if (x >= 0 && x + w <= plotW) {
      const under = weeks.filter((_, k) => xl(k) + bw >= x && xl(k) <= x + w);
      const high = Math.max(1, ...under.map((u) => u.index));
      const subY = y(high) - 10;
      if (subY - 16 > TOP + 4) labels.push({ x, anchor: "start", y: subY - 16, ...words });
    }
  }

  // ── the months along the bottom, never closer than a label's width ──
  const ticks: { i: number; text: string }[] = [];
  let lastX = -Infinity;
  weeks.forEach((w, i) => {
    const day = Number(w.start.slice(8, 10));
    if (day > 7) return;
    const month = new Date(`${w.start}T00:00:00Z`);
    const jan = month.getUTCMonth() === 0;
    const text = new Intl.DateTimeFormat(locale, {
      month: "short",
      ...(jan && !narrow ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(month);
    const x = xl(i);
    if (x - lastX < (narrow ? 44 : 38) || x + textWidth(text, 12) > width) return;
    ticks.push({ i, text });
    lastX = x + textWidth(text, 12);
  });

  const ahead = new Set(r.ahead.map((a) => a.last_year_start));
  const aheadIdx = weeks.flatMap((w, i) => (ahead.has(w.start) ? [i] : []));
  const bracketY = bottom + 30;
  const height = aheadIdx.length > 0 ? bracketY + 26 : bottom + 26;
  const kindWord = (f: "busy" | "quiet" | null) => tr(`chart.kind.${f ?? "normal"}`);
  const summary = tr("chart.summary", {
    count: weeks.length,
    noun: r.series.noun,
    normal: value(normal),
  });

  return (
    <div className="pt-year" ref={ref}>
      <svg
        className="pt-year-svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={summary}
      >
        {peak >= 2 && (
          <>
            <line className="pt-grid" x1={0} x2={plotW} y1={y(2)} y2={y(2)} />
            <text className="pt-tick" x={plotW + 10} y={y(2) + 4}>
              {value(normal * 2)}
            </text>
          </>
        )}
        {weeks.map((w, i) => (
          <rect
            key={w.start}
            className={w.flag === "busy" ? "pt-busy" : w.flag === "quiet" ? "pt-quiet" : "pt-plain"}
            x={xl(i)}
            y={y(w.index)}
            width={bw}
            height={Math.max(0.5, bottom - y(w.index))}
            rx={1}
          >
            <title>
              {`${tr("weeks.weekOf", { day: shortDate(w.start, locale) })}: ${value(w.value)}, ${signedPct(w.index, locale)}`}
            </title>
          </rect>
        ))}
        <line className="pt-normal" x1={0} x2={plotW} y1={y(1)} y2={y(1)} />
        <text className="pt-tick pt-tick-normal" x={plotW + 10} y={y(1) + 4}>
          {value(normal)}
        </text>
        <text className="pt-tick" x={plotW + 10} y={y(1) + 19}>
          {tr("chart.normal")}
        </text>
        <line className="pt-axis" x1={0} x2={plotW} y1={bottom} y2={bottom} />
        {ticks.map((t) => (
          <text key={t.i} className="pt-tick" x={xl(t.i)} y={bottom + 18}>
            {t.text}
          </text>
        ))}
        {labels.map((l) => (
          <g key={l.title} className="pt-label">
            <text x={l.x} y={l.y} textAnchor={l.anchor} className="pt-label-title">
              {l.title}
            </text>
            {l.sub && (
              <text x={l.x} y={l.y + 16} textAnchor={l.anchor} className="pt-label-sub">
                {l.sub}
              </text>
            )}
            {l.to && (
              <line
                className="pt-leader"
                x1={l.to.x}
                x2={l.to.x}
                y1={l.y + (l.sub ? 22 : 6)}
                y2={Math.max(l.y + (l.sub ? 22 : 6), l.to.y)}
              />
            )}
          </g>
        ))}
        {aheadIdx.length > 0 && (
          <g className="pt-bracket">
            <path d={`M${xl(aheadIdx[0]!)} ${bracketY - 6} v5 H${xl(aheadIdx.at(-1)!) + bw} v-5`} />
            <text x={xl(aheadIdx[0]!)} y={bracketY + 14}>
              {tr(narrow ? "chart.nextShort" : "chart.next", { count: aheadIdx.length })}
            </text>
          </g>
        )}
      </svg>
      <div className="sr-only">
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">{tr("weeks.colWeek")}</th>
              <th scope="col">{money ? tr("weeks.colSales") : capitalFirst(r.series.noun)}</th>
              <th scope="col">{tr("weeks.colAgainst")}</th>
              <th scope="col">{tr("chart.colKind")}</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.start}>
                <th scope="row">{shortDate(w.start, locale)}</th>
                <td>{value(w.value)}</td>
                <td>{signedPct(w.index, locale)}</td>
                <td>{kindWord(w.flag)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
