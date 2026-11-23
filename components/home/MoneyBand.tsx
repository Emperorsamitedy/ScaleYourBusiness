"use client";

// Home's money picture, the first thing on the page (2026-11-23, the owner:
// "something bold at the very top"; he picked the cash chart, then "too big
// in height", "too much unnecessary text"). One row: the headline, then the
// three figures an owner looks for (cash today, the lowest point, the line
// they keep), how far ahead, and the way to the cash flow screen. Under it
// the forecast's own chart, short: the band from the cautious to the hopeful
// end, the line, the weeks that dip, and the bills pinned on the days they
// fall due. Everything is the forecast's (/api/cash); nothing is added.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CashChart } from "../charts/CashChart";
import type { CashChartModel } from "../charts/CashChart";
import { shortDate } from "../../lib/charts/model";
import { useTr } from "../sheet/useTr";
import { Skeleton } from "../ui/Skeleton";
import { FailedRead } from "./FailedRead";
import { whole } from "./format";
import { firstTight, moneyHeadline, moneyPins } from "./money-model";
import type { MoneyForecast } from "./money-model";
import type { Read } from "./home-model";

/** /api/cash as the band reads it: the forecast, ready or refused. */
export interface MoneyView {
  forecast: ({ status: "ready" } & MoneyForecast) | { status: "refused" };
}

/** How far ahead the band draws, in weeks; the forecast runs thirteen. */
const HORIZONS = [8, 13] as const;
type Horizon = (typeof HORIZONS)[number];
const HORIZON_KEY = "scalex.home.money_weeks";

export function MoneyBand({ read, onRetry }: { read: Read<MoneyView>; onRetry: () => void }) {
  const t = useTranslations("home");
  const nav = useTranslations("nav");
  const { tr: cash, locale } = useTr("cash");
  const tc = useTranslations("charts.cash");
  const [weeks, setWeeks] = useState<Horizon>(8);

  useEffect(() => {
    try {
      const kept = Number(window.localStorage.getItem(HORIZON_KEY));
      if (kept === 8 || kept === 13) setWeeks(kept);
    } catch {
      /* storage blocked: eight weeks show */
    }
  }, []);
  const choose = (w: Horizon) => {
    setWeeks(w);
    try {
      window.localStorage.setItem(HORIZON_KEY, String(w));
    } catch {
      /* not kept: the choice lasts for this visit */
    }
  };

  if (read.state === "reading") {
    return (
      <section className="cs hm-money" aria-busy="true" aria-label={t("money.label")}>
        <Skeleton lines={4} />
      </section>
    );
  }
  if (read.state !== "read") {
    return (
      <section className="cs hm-money" aria-label={t("money.label")}>
        <FailedRead onRetry={onRetry} />
      </section>
    );
  }
  const f = read.data.forecast;
  if (f.status !== "ready") {
    return (
      <section className="cs hm-money hm-money-thin" aria-label={t("money.label")}>
        <p className="hm-money-title">{t("money.refused")}</p>
        <Link href="/cash" className="home-link">
          {nav("item.cash")}
        </Link>
      </section>
    );
  }

  const money = (minor: number) => whole(minor, f.currency, locale);
  const head = moneyHeadline(f);
  const title = head.week
    ? t(`money.${head.key}`, { date: shortDate(head.week, locale) })
    : t(`money.${head.key}`);
  const shown = f.weeks.slice(0, weeks);
  const lowest = Math.min(f.start.amount_minor, ...shown.map((w) => w.balance.low));
  const tight = firstTight(f, weeks);
  const model: CashChartModel = {
    label: t("money.label"),
    title,
    meta: "",
    foot: "",
    summary: title,
    points: [
      {
        label: cash("view.today"),
        start: f.today,
        low: f.start.amount_minor,
        high: f.start.amount_minor,
      },
      ...shown.map((w) => ({
        label: cash("view.weekOf", { day: shortDate(w.start, locale) }),
        start: w.start,
        low: w.balance.low,
        high: w.balance.high,
      })),
    ],
    line: { amount: f.line.amount_minor, label: f.line.kind === "buffer" ? "BUFFER" : "ZERO" },
    tight: tight === null ? null : tight + 1,
    currency: f.currency,
  };
  const pins = moneyPins(f, weeks).map((p) => ({
    at: p.at,
    text: `${shortDate(p.on, locale)} · ${tc("bills", { amount: money(p.amount_minor) })}`,
  }));

  return (
    <section className="cs hm-money" aria-labelledby="hm-money-title">
      <div className="hm-money-head">
        <h1 className="hm-money-title" id="hm-money-title">
          {title}
        </h1>
        <div className="hm-money-figs">
          <p className="hm-fig">
            <span className="hm-fig-lab">{t("readings.cash")}</span>
            <span className="hm-fig-val">{money(f.start.amount_minor)}</span>
          </p>
          <p className="hm-fig">
            <span className="hm-fig-lab">{t("money.lowest")}</span>
            <span className={lowest < f.line.amount_minor ? "hm-fig-val hm-under" : "hm-fig-val"}>
              {money(lowest)}
            </span>
          </p>
          {f.line.kind === "buffer" && (
            <p className="hm-fig">
              <span className="hm-fig-lab">{t("money.buffer")}</span>
              <span className="hm-fig-val">{money(f.line.amount_minor)}</span>
            </p>
          )}
          <div className="home-period" role="group" aria-label={t("money.horizon")}>
            {HORIZONS.map((w) => (
              <button key={w} type="button" aria-pressed={w === weeks} onClick={() => choose(w)}>
                {t("money.weeks", { count: w })}
              </button>
            ))}
          </div>
          <Link href="/cash" className="home-link">
            {nav("item.cash")}
          </Link>
        </div>
      </div>
      <CashChart model={model} tightWord={t("flag.tight")} bare pins={pins} />
    </section>
  );
}
