"use client";

// Slow stock, cash tied up over time (specs/ux-spec-v1.md §2.1): one row
// per slow item, a line through its value at cost on each stock count, and
// the first and latest figures beside it. Shown only with two counts or
// more (lib/charts/stock-history). A count is a snapshot: the line joins
// one item's balances; nothing is added across days.
//
// L-3b: the chart's own words are the "charts.stockHistory" catalogue;
// money and days in the reader's locale, in the business's currency. The
// table's caption (the model's summary, built in lib/charts) is L-4.

import "../../app/charts.css";
import { useTranslations } from "next-intl";
import { moneyText } from "../sheet/num";
import { SheetCard } from "../sheet/PageHead";
import { useAppLocale } from "../sheet/useTr";
import { dayMoney, shortDate } from "../../lib/charts/model";
import type { StockHistoryModel } from "../../lib/charts/stock-history";
import { minorUnitExponent } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";

/** Whole major units, the cents dropped as dayMoney drops them; another language its own way. */
function wholeUnits(minor: number, currency: string, locale: AppLocale): string {
  if (locale === "en") return dayMoney(minor, currency);
  const unit = 10 ** minorUnitExponent(currency);
  return moneyText(Math.trunc(Math.round(minor) / unit) * unit, currency, locale);
}

const W = 160;
const H = 32;

export function StockHistoryChart({ model }: { model: StockHistoryModel }) {
  const t = useTranslations("charts.stockHistory");
  const locale = useAppLocale();
  const cur = model.currency;
  const day = (d: string) => shortDate(d, locale);
  const money = (minor: number) => wholeUnits(minor, cur, locale);
  const d0 = Date.parse(`${model.dates[0]}T00:00:00Z`);
  const d1 = Date.parse(`${model.dates.at(-1)}T00:00:00Z`);
  const span = Math.max(1, d1 - d0);
  const x = (date: string) => 2 + ((Date.parse(`${date}T00:00:00Z`) - d0) / span) * (W - 4);
  return (
    <SheetCard
      className="sc"
      label={t("label", { count: model.dates.length })}
      title={t("title")}
      meta={
        <>
          {day(model.dates[0]!)} – {day(model.dates.at(-1)!)}
          <br />
          <span className="word">{t("observed")}</span> · {t("formula")}
        </>
      }
      foot={`${t("foot")}${model.other_currency > 0 ? ` ${t("otherCurrency", { count: model.other_currency })}` : ""}`}
    >
      <table className="rt rt-stack sc-stock">
        <caption className="sr-only">{model.summary}</caption>
        <thead>
          <tr>
            <th scope="col">{t("item")}</th>
            <th scope="col">{t("over")}</th>
            <th scope="col" className="num">
              {t("first", { currency: cur })}
            </th>
            <th scope="col" className="num">
              {t("latest", { currency: cur })}
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
                <td data-label={t("over")}>
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
                      ? t("oneCount", { day: day(first.date) })
                      : `${day(first.date)} → ${day(last.date)} · ${
                          last.cash_minor === first.cash_minor
                            ? t("unchanged")
                            : last.cash_minor < first.cash_minor
                              ? t("down", { amount: money(first.cash_minor - last.cash_minor) })
                              : t("up", { amount: money(last.cash_minor - first.cash_minor) })
                        }`}
                  </span>
                </td>
                <td className="num" data-label={t("first", { currency: cur })}>
                  {item.points.length === 1 ? "—" : money(first.cash_minor)}
                </td>
                <td className="num" data-label={t("latest", { currency: cur })}>
                  {money(last.cash_minor)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </SheetCard>
  );
}
