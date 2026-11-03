"use client";

// The 13-week cash chart (P5-10, specs/ux-spec-v1.md §2.1), on the chart
// family's sheet tokens: today's cash, then the balance at the end of each
// of the next 13 weeks as a tinted RANGE BAND from the cautious end to the
// hopeful end, the cautious end drawn as a solid ink line on its lower edge.
// The owner's buffer (or zero, when none is stated) is a dashed line with
// its mono label; the first week whose cautious end dips under it carries a
// hollow square and "TIGHT". Read in grayscale: no colour carries meaning.
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
import { wholeMoney } from "../../lib/cash/model";
import { shortDate } from "../../lib/charts/model";
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

export function CashChart({ model }: { model: CashChartModel }) {
  const t = useTranslations("charts.cash");
  const locale = useAppLocale();
  const [at, setAt] = useState<number | null>(null);
  const { ref, width, narrow } = useChartWidth<HTMLDivElement>(720);
  const pts = model.points;
  const TOP = 18;
  const H = narrow ? 150 : 200;
  const AXIS_W = 64;
  const height = TOP + H + 24;
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
  const lineWord = model.line.label === "BUFFER" ? t("lineBuffer") : t("lineZero");
  const shown = at ?? model.tight ?? pts.length - 1;
  const p = pts[shown];

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

  const onKey = (ev: KeyboardEvent<SVGSVGElement>) => {
    const { next, handled } = stepKey(ev.key, at, pts.length);
    if (!handled) return;
    ev.preventDefault();
    setAt(next);
  };

  return (
    <SheetCard
      className="sc cf"
      label={model.label}
      title={model.title}
      meta={model.meta}
      foot={model.foot}
    >
      <ul className="sc-keys" aria-label={t("key")}>
        <li>
          <span className="sc-key cf-band" aria-hidden="true" /> {t("band")}
        </li>
        <li>
          <span className="sc-key cf-low" aria-hidden="true" /> {t("low")}
        </li>
        <li>
          <span className="sc-key cf-line" aria-hidden="true" />{" "}
          {model.line.label === "BUFFER" ? t("buffer") : t("zero")}
        </li>
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
            const i = Math.round((ev.clientX - r.left - 6) / step);
            setAt(i >= 0 && i < pts.length ? i : null);
          }}
          onPointerLeave={() => setAt(null)}
        >
          {bottom < 0 && top > 0 && <line className="grid" x1={0} x2={plotR} y1={y(0)} y2={y(0)} />}
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
          <text className="tick" x={plotR + 6} y={y(model.line.amount) + 4}>
            {lineWord}
          </text>
          <text className="tick" x={plotR + 6} y={y(top - pad) + 4}>
            {money(top - pad)}
          </text>
          <text className="tick" x={plotR + 6} y={y(bottom + pad) + 4}>
            {money(bottom + pad)}
          </text>
          {at !== null && <line className="cf-cross" x1={x(at)} x2={x(at)} y1={TOP} y2={TOP + H} />}
          {model.tight !== null && pts[model.tight] && (
            <g className="cf-tight">
              <rect
                x={x(model.tight) - 5}
                y={y(pts[model.tight]!.low) - 5}
                width={10}
                height={10}
              />
              <text
                className="pane-label"
                x={x(model.tight)}
                y={Math.min(TOP + H - 2, y(pts[model.tight]!.low) + 20)}
                textAnchor="middle"
              >
                {t("tight")}
              </text>
            </g>
          )}
          {pts.map((q, i) =>
            i % every === 0 ? (
              <text
                key={q.start}
                className="tick"
                x={x(i)}
                y={height - 6}
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
