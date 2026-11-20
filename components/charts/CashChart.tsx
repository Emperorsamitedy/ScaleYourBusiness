"use client";

// The 13-week cash chart (P5-10, specs/ux-spec-v1.md §2.1), on the chart
// family's sheet tokens: today's cash, then the balance at the end of each
// of the next 13 weeks as a tinted RANGE BAND from the cautious end to the
// hopeful end, the cautious end drawn as a solid line on its lower edge.
// The owner's buffer (or zero, when none is stated) is a dashed line; the
// first week whose cautious end dips under it carries a hollow ring and
// "Tight". The figures at the right edge are the ones a reader looks for:
// where the band ends, and the line (kept apart by lib/charts/labels). Read
// in grayscale: shape and position carry the meaning, the tint repeats it.
// What it rests on (the sources line and how the band is drawn) sits folded
// under "How this works" (decluttered 2026-11-09 on the owner's instruction).
//
// Redrawn 2026-11-18 from the mockup the owner picked: the head is the
// chart's name with its key beside it, and nothing repeats the page's
// headline.
//
// Plain SVG at the container's width (useChartWidth); ←/→ step the
// crosshair (lib/charts/keys); every value is also in a table.
//
// L-3b: the chart's own words (key, line labels, readout, table heads) are
// the "charts.cash" catalogue; money and the axis's days in the reader's
// locale, in the business's currency.

import { useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import "../../app/charts.css";
import { stepKey } from "../../lib/charts/keys";
import { spreadLabels } from "../../lib/charts/labels";
import { wholeMoney } from "../../lib/cash/model";
import { shortDate } from "../../lib/charts/model";
import { Fold } from "../sheet/Fold";
import { SheetCard } from "../sheet/PageHead";
import { useAppLocale } from "../sheet/useTr";
import { useChartWidth } from "./useChartWidth";

export interface CashChartPoint {
  label: string;
  start: string;
  low: number;
  high: number;
}

export interface CashChartModel {
  label: string;
  title: string;
  meta: string;
  foot: string;
  summary: string;
  /** Today first, then each week's end. */
  points: CashChartPoint[];
  /** label is a code, "BUFFER" or "ZERO"; the chart words it. */
  line: { amount: number; label: string };
  /** Index into points of the first tight week, or null. */
  tight: number | null;
  currency: string;
}

export function CashChart({
  model,
  tightWord,
}: {
  model: CashChartModel;
  /** The screen's own word for a tight week ("Tight"), so the chart and the page say it one way. */
  tightWord?: string;
}) {
  const t = useTranslations("charts.cash");
  const locale = useAppLocale();
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(720);
  const pts = model.points;
  const TOP = 14;
  const H = narrow ? 160 : 220;
  const AXIS_W = narrow ? 64 : 76;
  const height = TOP + H + 28;
  const plotR = width - AXIS_W;
  const step = (plotR - 12) / Math.max(1, pts.length - 1);
  const x = (i: number) => 6 + step * i;
  const values = [...pts.flatMap((p) => [p.low, p.high]), model.line.amount, 0];
  const max = Math.max(...values);
  const min = Math.min(...values);
  const pad = (max - min) * 0.08 || Math.abs(max) * 0.1 || 1;
  const top = max + pad;
  const bottom = min - pad;
  const y = (v: number) => TOP + ((top - v) / (top - bottom)) * H;
  const money = (v: number) => wholeMoney(v, model.currency, locale);
  const shown = at ?? model.tight ?? pts.length - 1;
  const p = pts[shown];
  const last = pts[pts.length - 1];

  const band =
    pts.map((q, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(q.high)}`).join(" ") +
    " " +
    [...pts]
      .map((q, i) => ({ q, i }))
      .reverse()
      .map(({ q, i }) => `L${x(i)},${y(q.low)}`)
      .join(" ") +
    " Z";
  const lowLine = pts.map((q, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(q.low)}`).join(" ");
  const highLine = pts.map((q, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(q.high)}`).join(" ");
  const every = narrow ? 4 : 2;

  // The figures at the right edge: where the band ends, and the line.
  const ends = last
    ? [
        { key: "high", y: y(last.high), text: money(last.high), line: false },
        ...(money(last.low) === money(last.high)
          ? []
          : [{ key: "low", y: y(last.low), text: money(last.low), line: false }]),
        { key: "line", y: y(model.line.amount), text: money(model.line.amount), line: true },
      ]
    : [];
  const sideLabels = spreadLabels(ends, TOP + 4, TOP + H, 15);

  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, pts.length);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };

  const tight = model.tight !== null ? (pts[model.tight] ?? null) : null;
  const tightX = model.tight !== null ? x(model.tight) : 0;
  // The word sits under its ring, and never runs off either side of the plot.
  const tightAnchor = tightX < 40 ? "start" : tightX > plotR - 40 ? "end" : "middle";

  return (
    <SheetCard
      className="sc cf"
      title={model.label}
      meta={
        <ul className="sc-keys" aria-label={t("key")}>
          <li>
            <span className="sc-key cf-band" aria-hidden="true" />
            <span className="cap1">{t("band")}</span>
          </li>
          <li>
            <span className="sc-key cf-low" aria-hidden="true" />
            <span className="cap1">{t("low")}</span>
          </li>
          <li>
            <span className="sc-key cf-line" aria-hidden="true" />
            <span className="cap1">{model.line.label === "BUFFER" ? t("buffer") : t("zero")}</span>
          </li>
        </ul>
      }
      foot={
        <Fold summary={t("how")}>
          <p>{model.meta}</p>
          <p>{model.foot}</p>
        </Fold>
      }
    >
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
            const i = Math.round((ev.clientX - r.left - 6) / step);
            setAt(i >= 0 && i < pts.length ? i : null);
          }}
          onPointerLeave={() => setAt(null)}
        >
          {bottom < 0 && top > 0 ? (
            <line className="grid" x1={0} x2={plotR} y1={y(0)} y2={y(0)} />
          ) : (
            <line className="grid" x1={0} x2={plotR} y1={TOP + H} y2={TOP + H} />
          )}
          <path className="cf-band" d={band} />
          <path className="cf-high" d={highLine} />
          <path className="cf-low" d={lowLine} />
          <line
            className="cf-line"
            x1={0}
            x2={plotR}
            y1={y(model.line.amount)}
            y2={y(model.line.amount)}
          />
          {sideLabels.map((l) => (
            <text
              key={l.key}
              className={l.line ? "val cf-line-val" : "val"}
              x={plotR + 8}
              y={l.y + 4}
            >
              {l.text}
            </text>
          ))}
          {at !== null && pts[at] && (
            <g className="cf-at">
              <line className="cf-cross" x1={x(at)} x2={x(at)} y1={TOP} y2={TOP + H} />
              <circle className="cf-dot" cx={x(at)} cy={y(pts[at]!.high)} r={3.5} />
              <circle className="cf-dot" cx={x(at)} cy={y(pts[at]!.low)} r={3.5} />
            </g>
          )}
          {tight && (
            <g className="cf-tight">
              <circle cx={tightX} cy={y(tight.low)} r={5.5} />
              <text
                className="pane-label"
                x={tightX}
                y={Math.min(TOP + H - 5, y(tight.low) + 21)}
                textAnchor={tightAnchor}
              >
                {tightWord ?? t("tight")}
              </text>
            </g>
          )}
          {pts.map((q, i) =>
            i % every === 0 ? (
              <text
                key={q.start}
                className="tick"
                x={x(i)}
                y={height - 8}
                textAnchor={i === 0 ? "start" : "middle"}
              >
                {i === 0 ? t("today") : shortDate(q.start, locale)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
      {p && (
        <p className="sc-readout" aria-live="polite">
          <b>{p.label}</b> ·{" "}
          {p.low === p.high ? (
            <b>{money(p.low)}</b>
          ) : (
            t.rich("readoutRange", {
              low: money(p.low),
              high: money(p.high),
              b: (c) => <b>{c}</b>,
            })
          )}
          {p.low < model.line.amount && <> · {t("underLine")}</>}
        </p>
      )}
      <div className="sr-only">
        <table>
          <caption>{model.summary}</caption>
          <thead>
            <tr>
              <th scope="col">{t("when")}</th>
              <th scope="col">{t("cautiousCol", { currency: model.currency })}</th>
              <th scope="col">{t("hopefulCol", { currency: model.currency })}</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((q) => (
              <tr key={q.start + q.label}>
                <th scope="row">{q.label}</th>
                <td>{money(q.low)}</td>
                <td>{money(q.high)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}
