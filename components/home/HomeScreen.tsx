"use client";

// Home — /home, the first screen after sign-in (2026-11-15, the owner:
// "retention matters the most"). It answers one question: what needs me
// today. Top to bottom, the same order every screen now follows: the
// answer as the headline, the one warning, a strip of readings, then the
// detail — the business read like a stock, the watch, the waiting
// decisions. Each reading's working-out is behind "Why", in the Why sheet.
//
// It reads screens that already exist (/api/nav, /api/proposals,
// /api/cash, /api/charts) and adds no figure of its own. A part whose read
// fails or refuses is left out in silence; the rest still shows.

import "../../app/home.css";
import "../../app/charts.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { NavCounts } from "../../app/api/nav/route";
import type { ChartsBundle } from "../../lib/charts/load";
import { MarketChart } from "../charts/MarketChart";
import { HBars, Trend } from "../charts/Viz";
import type { BarRow } from "../charts/Viz";
import { basisName, BASES } from "../report/basis";
import type { Basis } from "../report/basis";
import { PageHead } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { WhySheet } from "../sheet/WhySheet";
import type { WhyContent } from "../sheet/WhySheet";
import { minorUnitExponent } from "../../lib/core/money";
import { dayMoney, shortDate, volumeWord } from "../../lib/charts/model";
import { niceTicks } from "../../lib/charts/ticks";
import { rangeWhole } from "../../lib/charts/opportunity";
import type { ComponentKey, PricedComponent } from "../../lib/charts/opportunity";
import { intlTag } from "../../lib/i18n/locales";
import type { AppLocale } from "../../lib/i18n/locales";
import type { CashLike, PendingLike } from "./home-model";
import { cashReading, rankPending } from "./home-model";
import { LiveVisitors } from "./LiveVisitors";

function useRead<T>(url: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : null))
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [url]);
  return data;
}

const tagOf = (locale: AppLocale) => (locale === "en" ? "en-GB" : intlTag(locale));
const shortDay = (iso: string, locale: AppLocale) =>
  new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString(tagOf(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const longDay = (d: Date, locale: AppLocale) =>
  d.toLocaleDateString(tagOf(locale), { weekday: "short", day: "numeric", month: "short" });
/** Whole major units, as every reading on the page prints them (the currency's own exponent). */
const whole = (minor: number, currency: string, locale: AppLocale) => {
  const unit = 10 ** minorUnitExponent(currency);
  const text = moneyText(Math.abs(Math.round(minor / unit)) * unit, currency, locale);
  return minor < 0 ? `−${text}` : text;
};
const signed = (minor: number, currency: string, locale: AppLocale) =>
  `${minor > 0 ? "+" : minor < 0 ? "−" : ""}${whole(Math.abs(minor), currency, locale)}`;

interface Pending extends PendingLike {
  expires_at: string | null;
}

const SPARK_DAYS = 30;
const PRICE_KEY: Readonly<Record<string, string>> = {
  "revenue.daily": "revenue",
  "booking_revenue.daily": "bookingRevenue",
};
/** The screen that owns each priced part of the month. */
const COMPONENT_HREF: Readonly<Record<ComponentKey, string>> = {
  revenue_dips: "/watch",
  no_shows: "/profile",
  late_cancellations: "/profile",
  empty_capacity: "/profile",
  losing_ads: "/profile",
  slow_stock: "/stock",
  on_the_table: "/proposals",
};

export function HomeScreen() {
  const t = useTranslations("home");
  const { tr: rtr, locale } = useTr("report");
  const { tr: ctr } = useTr("charts.market");
  const { tr: sheet } = useTr("sheet");
  const nav = useRead<NavCounts>("/api/nav");
  const queue = useRead<{ pending: Pending[] }>("/api/proposals");
  const cashView = useRead<CashLike>("/api/cash");
  const charts = useRead<ChartsBundle>("/api/charts");
  const [why, setWhy] = useState<WhyContent | null>(null);
  const shut = useCallback(() => setWhy(null), []);

  const ranked = rankPending(queue?.pending ?? []);
  const count = nav?.pending ?? queue?.pending.length ?? null;
  const top = ranked[0]?.range ?? null;
  const cash = cashReading(cashView);
  const basis = (b: string) =>
    (BASES as readonly string[]).includes(b) ? basisName(b as Basis, rtr) : b;
  const range = (r: {
    low: { amount_minor: number; currency: string };
    high: { amount_minor: number; currency: string };
  }) =>
    `${signed(r.low.amount_minor, r.low.currency, locale)} – ${signed(r.high.amount_minor, r.high.currency, locale)}`;

  const market = charts?.market.status === "drawn" ? charts.market : null;
  const recent = market ? market.days.slice(-SPARK_DAYS) : [];
  const latest = recent.at(-1) ?? null;
  const dayLabels = recent.map((d) => shortDate(d.date, locale));
  const priceKey = market ? PRICE_KEY[market.price.metric] : undefined;
  const priceLabel = market ? (priceKey ? ctr(`price.${priceKey}`) : market.price.label) : "";
  const priced = (market?.components ?? []).filter(
    (c): c is PricedComponent => c.status === "priced" && c.total.currency === market?.currency,
  );
  const partRow = (c: PricedComponent, r: PricedComponent["total"]): BarRow => ({
    key: c.key,
    label: ctr(`component.${c.key}`),
    note: <span className="word">{sheet(`basis.${c.basis}`)}</span>,
    value: r.high_minor,
    low: r.low_minor,
    display: rangeWhole(r, locale),
    tone: c.kind === "forecast" ? "okband" : c.kind === "stock" ? "ink" : "drift",
    href: COMPONENT_HREF[c.key],
  });
  const unit = market ? 10 ** minorUnitExponent(market.currency) : 1;
  const monthRows = priced.flatMap((c) => (c.monthly ? [partRow(c, c.monthly)] : []));
  const stockRows = priced.flatMap((c) => (c.monthly ? [] : [partRow(c, c.total)]));

  return (
    <main className="screen home">
      <PageHead
        kicker={t("kicker", { date: longDay(new Date(), locale) })}
        title={count === null ? t("reading") : t("title", { count })}
        aside={
          count !== null && count > 0 ? (
            <Link href="/proposals" className="home-act home-act-desk">
              {t("review")} <span aria-hidden="true">→</span>
            </Link>
          ) : undefined
        }
      >
        {top && <p className="home-ans">{t("biggest", { range: range(top) })}</p>}
      </PageHead>

      {cash?.tight && (
        <section className="home-alert" aria-labelledby="home-alert-title">
          <div className="home-alert-tx">
            <p className="flag drift">{t("cash.flag")}</p>
            <h2 id="home-alert-title" className="home-alert-title">
              {t("cash.title", { date: shortDay(cash.tight.start, locale) })}
            </h2>
            <p className="home-alert-line">
              {cash.lineKind === "buffer"
                ? t("cash.line", {
                    low: whole(cash.tight.low, cash.currency, locale),
                    line: whole(cash.line, cash.currency, locale),
                  })
                : t("cash.lineZero", { low: whole(cash.tight.low, cash.currency, locale) })}
            </p>
          </div>
          <Link href="/cash" className="home-act">
            {t("cash.open")} <span aria-hidden="true">→</span>
          </Link>
        </section>
      )}

      <section className="cs home-readings" aria-label={t("readings.label")}>
        <LiveVisitors />
        <div className="home-strip">
          <div className="home-reading">
            <p className="home-r-lab">{t("readings.waiting")}</p>
            <p className="home-r-val">{count ?? "—"}</p>
            <p className="home-r-cmp">
              {top ? t("readings.waitingCmp", { range: range(top) }) : t("readings.waitingNone")}
            </p>
            {ranked[0]?.range && (
              <button
                type="button"
                className="home-why"
                onClick={() => {
                  const p = ranked[0]!.proposal;
                  setWhy({
                    title: p.action.summary,
                    value: range(ranked[0]!.range!),
                    rows: [{ label: t("why.basis"), value: basis("ESTIMATED") }],
                    lines: [
                      p.scenario.downside_case?.formula,
                      p.scenario.upside_case?.formula,
                    ].filter((l): l is string => typeof l === "string" && l.length > 0),
                  });
                }}
              >
                {t("why.open")}
              </button>
            )}
          </div>
          {cash && (
            <div className="home-reading">
              <p className="home-r-lab">{t("readings.cash")}</p>
              <p className="home-r-val">{whole(cash.today, cash.currency, locale)}</p>
              <p className="home-r-cmp">
                {cash.lineKind === "buffer"
                  ? t("readings.cashCmp", { line: whole(cash.line, cash.currency, locale) })
                  : t("readings.cashZero")}
              </p>
              <div className="home-r-foot">
                <span className={`flag ${cash.under ? "alarm" : "ok"}`}>
                  {cash.under ? t("flag.under") : t("flag.above")}
                </span>
                <button
                  type="button"
                  className="home-why"
                  onClick={() =>
                    setWhy({
                      title: t("readings.cash"),
                      value: whole(cash.today, cash.currency, locale),
                      rows: [
                        { label: t("why.basis"), value: basis(cash.source.basis) },
                        { label: t("why.from"), value: cash.source.source },
                        ...(cash.source.on
                          ? [{ label: t("why.when"), value: shortDay(cash.source.on, locale) }]
                          : []),
                      ],
                    })
                  }
                >
                  {t("why.open")}
                </button>
              </div>
            </div>
          )}
          {cash && (
            <div className="home-reading">
              <p className="home-r-lab">{t("readings.lowest")}</p>
              <p className="home-r-val">{whole(cash.lowest.low, cash.currency, locale)}</p>
              <p className="home-r-cmp">
                {t("readings.lowestCmp", { date: shortDay(cash.lowest.start, locale) })}
              </p>
              <div className="home-r-foot">
                <span className={`flag ${cash.lowest.under ? "drift" : "ok"}`}>
                  {cash.lowest.under ? t("flag.tight") : t("flag.clear")}
                </span>
              </div>
            </div>
          )}
          {nav?.watch && (
            <div className="home-reading">
              <p className="home-r-lab">{t("readings.watch")}</p>
              <p className="home-r-val">
                {nav.watch.day} / {nav.watch.of}
              </p>
              <p className="home-r-cmp">{t("readings.watchCmp")}</p>
            </div>
          )}
        </div>
        {market && latest && (
          <div className="home-trends">
            <div className="home-trend">
              <p className="home-r-lab">{priceLabel}</p>
              <p className="home-r-val">{dayMoney(latest.value_minor, market.currency, locale)}</p>
              <p className="home-r-cmp">
                {shortDate(latest.date, locale)} · {market.price.source} ·{" "}
                <span className="word">{sheet(`basis.${market.price.basis}`)}</span>
              </p>
              <Trend
                points={recent.map((d, i) => ({ label: dayLabels[i] ?? "", value: d.value_minor }))}
                format={(v) => dayMoney(v, market.currency, locale)}
                step={10 ** minorUnitExponent(market.currency)}
                label={`${priceLabel} · ${ctr("daysMeasured", { count: recent.length })}`}
                columns={[ctr("table.day"), priceLabel]}
              />
            </div>
            {market.volume && latest.volume !== null && (
              <div className="home-trend">
                <p className="home-r-lab">{volumeWord(market.volume.word, ctr)}</p>
                <p className="home-r-val">{num(latest.volume, 0, locale)}</p>
                <p className="home-r-cmp">
                  {shortDate(latest.date, locale)} · {market.volume.source}
                </p>
                <Trend
                  points={recent.map((d, i) => ({ label: dayLabels[i] ?? "", value: d.volume }))}
                  format={(v) => num(v, 0, locale)}
                  label={`${volumeWord(market.volume.word, ctr)} · ${ctr("daysMeasured", { count: recent.length })}`}
                  columns={[ctr("table.day"), volumeWord(market.volume.word, ctr)]}
                />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="cs home-decisions">
        <header className="cs-head">
          <div>
            <p className="cs-label">{t("decisions.label")}</p>
          </div>
          {ranked.length > 0 && (
            <div className="cs-meta">
              <Link href="/proposals" className="home-link">
                {t("decisions.all")} →
              </Link>
            </div>
          )}
        </header>
        {queue && ranked.length === 0 && <p className="home-empty">{t("decisions.empty")}</p>}
        <ul className="home-rows">
          {ranked.map(({ proposal: p, range: r }) => (
            <li key={p.id}>
              <div className="home-row-tx">
                {p.expires_at && (
                  <p className="home-row-lab">
                    {t("decisions.by", { date: shortDay(p.expires_at, locale) })}
                  </p>
                )}
                <p className="home-row-ti">{p.action.summary}</p>
              </div>
              {r && <p className="home-row-amt">{range(r)}</p>}
              <Link href="/proposals" className="home-act home-act-sm">
                {t("decisions.open")} <span aria-hidden="true">→</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {market && priced.length > 0 && (
        <section className="cs home-money" aria-label={ctr("componentsCaption")}>
          <header className="cs-head">
            <p className="cs-label">{ctr("colWhere")}</p>
            <div className="cs-meta">{ctr("colMonth", { currency: market.currency })}</div>
          </header>
          <div className="cs-body">
            {monthRows.length > 0 && (
              <HBars
                rows={monthRows}
                label={ctr("componentsCaption")}
                axis={{
                  ticks: niceTicks(0, Math.max(...monthRows.map((r) => r.value)) / unit).map(
                    (v) => v * unit,
                  ),
                  format: (v) => dayMoney(v, market.currency, locale),
                }}
              />
            )}
            {stockRows.length > 0 && (
              <>
                <p className="vz-cap">
                  {ctr("apart")} · {ctr("row.tiedUp")}
                </p>
                <ul className="home-apart">
                  {stockRows.map((r) => (
                    <li key={r.key}>
                      <a href={r.href}>{r.label}</a>
                      {r.note}
                      <span className="vz-bar-fig">{r.display}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </section>
      )}

      <div className="home-grid">
        <div className="home-chart">{charts && <MarketChart model={charts.market} compact />}</div>
        {nav?.watch && (
          <section className="cs home-watch">
            <header className="cs-head">
              <div>
                <p className="cs-label">{t("watch.label")}</p>
                <h2 className="cs-title">
                  {t("watch.title", { day: nav.watch.day, of: nav.watch.of })}
                </h2>
              </div>
            </header>
            <div className="cs-body">
              <div className="home-days" aria-hidden="true">
                {Array.from({ length: nav.watch.of }, (_, i) => (
                  <i
                    key={i}
                    className={i < nav.watch!.day - 1 ? "d" : i === nav.watch!.day - 1 ? "n" : ""}
                  />
                ))}
              </div>
              <p className="home-note">{t("watch.note")}</p>
              <Link href="/watch" className="home-link">
                {t("watch.open")} →
              </Link>
            </div>
          </section>
        )}
      </div>

      <WhySheet content={why} onClose={shut} />
    </main>
  );
}
