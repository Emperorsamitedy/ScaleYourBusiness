"use client";

// Slow stock, cash tied up over time (specs/ux-spec-v1.md §2.1): one row
// per slow item, a line through its value at cost on each stock count, and
// the first and latest figures beside it. Shown only with two counts or
// more (lib/charts/stock-history). A count is a snapshot: the line joins
// one item's balances; nothing is added across days.

import "../../app/charts.css";
import { num } from "../sheet/num";
import { SheetCard } from "../sheet/PageHead";
import { dayMoney, shortDate } from "../../lib/charts/model";
import type { StockHistoryModel } from "../../lib/charts/stock-history";

const W = 160;
const H = 32;

export function StockHistoryChart({ model }: { model: StockHistoryModel }) {
  const cur = model.currency;
  const d0 = Date.parse(`${model.dates[0]}T00:00:00Z`);
  const d1 = Date.parse(`${model.dates.at(-1)}T00:00:00Z`);
  const span = Math.max(1, d1 - d0);
  const x = (date: string) => 2 + ((Date.parse(`${date}T00:00:00Z`) - d0) / span) * (W - 4);
  return (
    <SheetCard
      className="sc"
      label={`Slow stock · ${num(model.dates.length)} counts`}
      title="Cash tied up, count by count"
      meta={
        <>
          {shortDate(model.dates[0]!)} – {shortDate(model.dates.at(-1)!)}
          <br />
          <span className="word">OBSERVED</span> · units on hand × unit cost
        </>
      }
      foot={`A stock, not a flow: each point is what one item held on the day it was counted, never added across days.${model.other_currency > 0 ? ` ${num(model.other_currency)} item${model.other_currency === 1 ? "" : "s"} in another currency left out.` : ""}`}
    >
      <table className="rt rt-stack sc-stock">
        <caption className="sr-only">{model.summary}</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Over the counts</th>
            <th scope="col" className="num">
              First ({cur})
            </th>
            <th scope="col" className="num">
              Latest ({cur})
            </th>
          </tr>
        </thead>
        <tbody>
          {model.items.map((item) => {
            const vals = item.points.map((p) => p.cash_minor);
            const lo = Math.min(...vals);
            const hi = Math.max(...vals);
            const y = (v: number) => (hi === lo ? H / 2 : 4 + ((hi - v) / (hi - lo)) * (H - 8));
            const first = item.points[0]!;
            const last = item.points.at(-1)!;
            return (
              <tr key={item.key}>
                <th scope="row">{item.name}</th>
                <td data-label="Over the counts">
                  <svg
                    className="sc-bars"
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <line
                      className="grid"
                      x1={0}
                      x2={W}
                      y1={H - 1}
                      y2={H - 1}
                      vectorEffect="non-scaling-stroke"
                    />
                    <polyline
                      className="line"
                      points={item.points.map((p) => `${x(p.date)},${y(p.cash_minor)}`).join(" ")}
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  <span className="sc-note">
                    {item.points.length === 1
                      ? `one count, ${shortDate(first.date)}`
                      : `${shortDate(first.date)} → ${shortDate(last.date)} · ${
                          last.cash_minor === first.cash_minor
                            ? "unchanged"
                            : last.cash_minor < first.cash_minor
                              ? `down ${dayMoney(first.cash_minor - last.cash_minor, cur)}`
                              : `up ${dayMoney(last.cash_minor - first.cash_minor, cur)}`
                        }`}
                  </span>
                </td>
                <td className="num" data-label={`First (${cur})`}>
                  {item.points.length === 1 ? "—" : dayMoney(first.cash_minor, cur)}
                </td>
                <td className="num" data-label={`Latest (${cur})`}>
                  {dayMoney(last.cash_minor, cur)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SheetCard>
  );
}
