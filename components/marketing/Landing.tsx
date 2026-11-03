// The landing page — the owner's landing design (2026-10-17), built as
// app components: a hero with the product walkthrough, the store read as
// a candlestick chart, the nine panels, how it works, the price card,
// questions and the footer, alternating desk and paper bands.
//
// Placeholders the owner still has to supply print as the design's
// brackets — "[7]", "[3]", "[Company details]" — from
// lib/marketing/offer.ts, so nothing here invents a deadline or a
// promise. The price on every button is reportPrice(), the same value
// checkout charges. The business in the walkthrough and the chart is
// fictional and labelled as illustrative where it renders: a webshop by
// default, or a salon — the visitor switches between the two demos with
// the "A webshop / A salon" control in the hero or above the chart.
//
// L-3d: the page's words are the "landing" catalogue, its figures in the
// reader's language (./words.ts); English is what the page always said.

import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";
import { PANELS } from "../../lib/marketing/areas";
import { DELIVERY_DAYS, GUARANTEE } from "../../lib/marketing/offer";
import { isAppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { moneyText, num } from "../sheet/num";
import { DemoProvider, DemoSwitch } from "./Demos";
import { StoreChart } from "./StoreChart";
import { Walkthrough } from "./Walkthrough";
import { LANDING_FIGURES as F, PENDING_DAYS, PENDING_LEAKS, offerFigure, sizeUsd } from "./words";

/** The three steps of "How it works"; the last one's day is the delivery promise. */
const STEPS = ["connect", "questions", "results"] as const;

type LandingT = Tr & {
  rich: (key: string, values: Record<string, (chunks: ReactNode) => ReactNode>) => ReactNode;
};

export async function Landing({ price }: { price: { amount_minor: number; currency: string } }) {
  const t = (await getTranslations("landing" as "common")) as unknown as LandingT;
  const raw = await getLocale();
  const locale = isAppLocale(raw) ? raw : "en";
  const priceText = moneyText(price.amount_minor, price.currency, locale);
  const n = (v: number) => num(v, 0, locale);
  const daysText = offerFigure(DELIVERY_DAYS, PENDING_DAYS, locale);
  const days = DELIVERY_DAYS ?? PENDING_DAYS;
  const leaksText = offerFigure(GUARANTEE?.min_findings ?? null, PENDING_LEAKS, locale);
  const leaks = GUARANTEE?.min_findings ?? PENDING_LEAKS;
  const steps = STEPS.map((k) => ({
    k,
    when:
      k === "connect"
        ? t("steps.whenMinutes", { day: n(0), minutes: n(F.connectMinutes) })
        : k === "questions"
          ? t("steps.whenMinutes", { day: n(0), minutes: n(F.questionsMinutes) })
          : t("steps.whenDay", { day: daysText }),
    t: t(`steps.${k}.t`),
    d: t(`steps.${k}.d`),
  }));
  const included: [string, string][] = [
    [t("price.markers", { count: F.markers }), "✓"],
    [t("price.chart"), "✓"],
    [t("price.fixes", { count: F.fixes }), "✓"],
    [t("price.walkthrough", { minutes: n(F.walkthroughMinutes) }), "✓"],
    [t("price.subscription"), t("price.none")],
  ];
  const faq: [string, string][] = [
    [t("faq.passwordQ"), t("faq.passwordA")],
    [t("faq.changeQ"), t("faq.changeA")],
    [
      t("faq.sizeQ"),
      t("faq.sizeA", { low: sizeUsd(F.sizeLowUsd, locale), high: sizeUsd(F.sizeHighUsd, locale) }),
    ],
  ];

  return (
    <div className="ll">
      <header className="ll-head">
        <div className="ll-w ll-head-in">
          <a href="#top" className="ll-s ll-logo">
            SYB
          </a>
          <nav aria-label={t("nav.label")} className="ll-nav">
            <a className="ll-nl" href="#chart">
              {t("nav.chart")}
            </a>
            <a className="ll-nl" href="#panels">
              {t("nav.panels")}
            </a>
            <a className="ll-nl" href="#price">
              {t("nav.price")}
            </a>
            <Link className="ll-nl" href="/login">
              {t("nav.signIn")}
            </Link>
          </nav>
        </div>
      </header>

      <DemoProvider>
        <main>
          <section id="top" className="ll-w ll-hero" aria-labelledby="ll-h1">
            <div className="ll-hero-copy">
              <div className="ll-m ll-pill">
                <span className="ll-beat" aria-hidden="true" />
                {t("hero.pill")}
              </div>
              <h1 id="ll-h1" className="ll-s ll-hd">
                {t("hero.titleA")}
                <br />
                {t.rich("hero.titleB", {
                  em: (chunks) => (
                    <span style={{ fontStyle: "italic", color: "#FF9C8F" }}>{chunks}</span>
                  ),
                })}
              </h1>
              <p className="ll-lede">{t("hero.lede", { checks: n(F.checks), daysText, days })}</p>
              <div className="ll-ctas">
                <Link className="ll-go" href="/signup">
                  {t("hero.book", { price: priceText })} <span aria-hidden="true">→</span>
                </Link>
                <a className="ll-go line" href="#chart">
                  {t("hero.see")}
                </a>
              </div>
              <div className="ll-m ll-trust">
                <span>
                  <span style={{ color: "#9FD7B3" }}>✓</span> {t("hero.trustReadOnly")}
                </span>
                <span>
                  <span style={{ color: "#9FD7B3" }}>✓</span> {t("hero.trustSigned")}
                </span>
                <span>
                  <span style={{ color: "#9FD7B3" }}>✓</span> {t("hero.trustRefund")}
                </span>
              </div>
            </div>
            <div className="ll-hero-demo">
              <DemoSwitch />
              <Walkthrough />
            </div>
          </section>

          <section id="chart" className="ll-band-deep" aria-labelledby="ll-h-chart">
            <div className="ll-w ll-pad-chart">
              <div className="ll-sec-top">
                <div>
                  <div className="ll-k" style={{ color: "#8FA8FF" }}>
                    {t("chart.kicker")}
                  </div>
                  <h2 id="ll-h-chart" className="ll-s ll-h2" style={{ maxWidth: "13em" }}>
                    {t("chart.title")}
                  </h2>
                </div>
                <div className="ll-sec-side">
                  <p className="ll-sec-aside">{t("chart.aside")}</p>
                  <DemoSwitch />
                </div>
              </div>
              <StoreChart />
            </div>
          </section>

          <section id="panels" className="ll-paper" aria-labelledby="ll-h-panels">
            <div className="ll-w ll-pad-96">
              <div className="ll-k" style={{ color: "#3E5248" }}>
                {t("panels.kicker")}
              </div>
              <h2 id="ll-h-panels" className="ll-s ll-h2" style={{ maxWidth: "14em" }}>
                {t("panels.title")}
              </h2>
              <ol className="ll-panels">
                {PANELS.map((p) => (
                  <li key={p.no} className="ll-panel">
                    <span className="ll-m ll-panel-no">{p.no}</span>
                    <span className="ll-s ll-panel-name">{t(`panels.p${p.no}.name`)}</span>
                    <span className="ll-m ll-panel-markers">{t(`panels.p${p.no}.markers`)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section id="read" className="ll-w ll-pad-104" aria-labelledby="ll-h-read">
            <div className="ll-k" style={{ color: "#A9BDB2" }}>
              {t("steps.kicker")}
            </div>
            <h2 id="ll-h-read" className="ll-s ll-h2" style={{ maxWidth: "13em" }}>
              {t("steps.title")}
            </h2>
            <ol className="ll-steps">
              {steps.map((s) => (
                <li key={s.k} className="ll-step">
                  <div className="ll-m ll-step-when">{s.when}</div>
                  <h3 className="ll-s ll-step-t">{s.t}</h3>
                  <p className="ll-step-d">{s.d}</p>
                </li>
              ))}
            </ol>
          </section>

          <section id="price" className="ll-paper" aria-labelledby="ll-h-price">
            <div className="ll-w ll-pad-96 ll-price">
              <div className="ll-price-head">
                <div className="ll-k" style={{ color: "#3E5248" }}>
                  {t("price.kicker")}
                </div>
                <h2 id="ll-h-price" className="ll-s ll-h2">
                  {t("price.titleA")}
                  <br />
                  {t("price.titleB")}
                </h2>
              </div>
              <div className="ll-price-card">
                <div className="ll-price-top">
                  <span className="ll-s" style={{ fontSize: 24, fontWeight: 600 }}>
                    {t("price.card")}
                  </span>
                  <span>
                    <span className="ll-s ll-price-fig">{priceText}</span>{" "}
                    <span className="ll-m" style={{ fontSize: 13, color: "#3E5248" }}>
                      {t("price.once")}
                    </span>
                  </span>
                </div>
                <ul className="ll-m ll-included">
                  {included.map(([what, mark]) => (
                    <li key={what}>
                      <span>{what}</span>
                      <span>{mark}</span>
                    </li>
                  ))}
                </ul>
                <Link className="ll-go ink ll-go-full" href="/signup">
                  {t("price.book")} <span aria-hidden="true">→</span>
                </Link>
                <p className="ll-refund">{t("price.refund", { leaksText, leaks })}</p>
              </div>
            </div>
          </section>

          <section className="ll-w ll-faq" aria-labelledby="ll-h-faq">
            <h2 id="ll-h-faq" className="ll-s ll-faq-h">
              {t("faq.title")}
            </h2>
            <div className="ll-faq-list">
              {faq.map(([q, a]) => (
                <details key={q}>
                  <summary>
                    {q}
                    <span className="ll-pm" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </section>
        </main>
      </DemoProvider>

      <footer className="ll-foot">
        <div className="ll-w ll-foot-in">
          <span className="ll-s" style={{ fontSize: 20, fontWeight: 700 }}>
            SYB
          </span>
          <Link className="ll-go line" href="/signup" style={{ minHeight: 46 }}>
            {t("foot.book", { price: priceText })} →
          </Link>
          <span className="ll-m" style={{ fontSize: 11.5, color: "#A9BDB2" }}>
            {t("foot.company")} · <Link href="/terms">{t("foot.terms")}</Link> ·{" "}
            <Link href="/privacy">{t("foot.privacy")}</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
