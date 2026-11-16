"use client";

// The v2 landing page, the front page (specs/ux-spec-v1.md §7.1b; previewed
// at /landing-v2, now a redirect to "/"): one filmed scene
// per section behind the page, and in front the copy and one ScaleX
// screen per section — the interview, the diagnosis, a finding, a
// decision, the market view, the Trust Ladder, the client book and the
// free check — drawn the way the app draws them.
//
// The store is fictional and labelled so (lib/marketing/landing-v2.ts);
// the footage is AI-generated and labelled so. Words are the
// "landingV2" catalogue (a few are the first landing's, reused word for
// word); every figure is formatted here in the reader's language and
// never typed into a message. Plan prices are the price book's, passed
// in by the page. What moves is landing-v2-motion.ts.

import Link from "next/link";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { dayMonth } from "../../lib/i18n/format";
import {
  V2,
  V2_CURRENCY,
  adLost_minor,
  adMonthly_minor,
  adReturnPerEuro_minor,
  adSplitPct,
  chartSeries,
  checkRange,
  mugAfter_minor,
  scanLeaks,
  type ScanLeak,
  type Severity,
} from "../../lib/marketing/landing-v2";
import { Mark } from "../brand/Mark";
import { ratioBp } from "../../lib/core/money";
import { moneyExact, moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { chartGeo, mountLandingV2, type MotionWords } from "./landing-v2-motion";

export interface Money {
  amount_minor: number;
  currency: string;
}

/** The price book's monthly prices for the reader's market; a tier is absent when it could not be read. */
export interface V2Prices {
  watch?: Money;
  act?: Money;
  autonomous?: Money;
  extra_business?: Money;
  report: Money;
}

type Rich = {
  rich: (key: string, values: Record<string, (chunks: ReactNode) => ReactNode>) => ReactNode;
};

const EM = { em: (chunks: ReactNode) => <em>{chunks}</em> };
const MEDIA = "/landing-v2";
const FLAG: Record<Severity, string> = { high: "alarm", medium: "drift", low: "low" };

/** The nine scenes, in section order: which are film, and how much each is dimmed behind the copy. */
const SCENES = [
  { g: 0, shade: 0.12, film: true, cls: "" },
  { g: 1, shade: 0.38, film: true, cls: "" },
  { g: 2, shade: 0.34, film: true, cls: "" },
  { g: 3, shade: 0.3, film: true, cls: "" },
  { g: 4, shade: 0.36, film: true, cls: "" },
  { g: 5, shade: 0.3, film: false, cls: " pan" },
  { g: 6, shade: 0.28, film: false, cls: " still" },
  { g: 7, shade: 0.36, film: false, cls: " still" },
  { g: 8, shade: 0.3, film: true, cls: "" },
] as const;

/** The client book's longest bar: the most any row leaks. */
const MAX_LEAK_MINOR = Math.max(...V2.firm.rows.map((r) => r.leaking_minor));

const RAIL = [
  "read",
  "learn",
  "scan",
  "leaks",
  "decide",
  "chart",
  "trust",
  "firms",
  "check",
  "start",
];
const TABS = ["connect", "facts", "diagnosis", "finding", "yes"] as const;
const PLANS = [
  { tier: "watch", step: 2 },
  { tier: "act", step: 3 },
  { tier: "autonomous", step: 4 },
] as const;
const LADDER = ["shadow", "watch", "act", "autonomous"] as const;

/** A stagger step for a row inside a scene or a screen. */
const at = (i: number) => ({ "--i": i }) as CSSProperties;
const width = (pct: number) => ({ "--w": `${pct}%` }) as CSSProperties;

function Pointer({ name }: { name: string }) {
  return (
    <svg className="cur" data-m={name} viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 1.5v14.2l3.9-3.4 2.5 5.9 2.3-1-2.5-5.8h5.2z"
        fill="#fff"
        stroke="#0D1321"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The app's masthead on a screen: the mark, whose screen it is, and a short note on the right. */
function Bar({ who, screen, children }: { who: string; screen: ReactNode; children?: ReactNode }) {
  return (
    <div className="bar">
      <Mark size={16} onDark />
      <span className="biz">{who}</span>
      <span className="sep">/</span>
      <span className="scr">{screen}</span>
      <span className="note">{children}</span>
    </div>
  );
}

export function LandingV2({ prices }: { prices: V2Prices }) {
  const { tr, locale } = useTr("landingV2");
  const { tr: first } = useTr("landing");
  const rich = useTranslations("landingV2" as "common") as unknown as Rich;
  const firstRich = useTranslations("landing" as "common") as unknown as Rich;
  const root = useRef<HTMLDivElement>(null);

  const eur = (minor: number) => moneyText(minor, V2_CURRENCY, locale);
  const range = (low: number, high: number) => `${eur(low)}–${eur(high)}`;
  const pct = (n: number, decimals = 0) => `${num(n, decimals, locale)}%`;
  const day = (iso: string) => dayMonth(iso, locale);
  const aMonth = (amount: string) => tr("aMonth", { amount });
  const price = (m: Money | undefined) => (m ? moneyText(m.amount_minor, m.currency, locale) : "—");

  const store = "Fernhill Ceramics";
  const monthly = adMonthly_minor();
  const split = adSplitPct();
  const series = chartSeries();
  const geo = chartGeo(series);
  const leaks = scanLeaks();
  const leakAmount = (l: ScanLeak): string => {
    if (l.low_minor === null || l.high_minor === null) {
      return tr(l.key === "breakage" ? "notPricedYet" : "notPriced");
    }
    if (l.key === "ads") return aMonth(`−${eur(l.low_minor)}`);
    return l.key === "pricing"
      ? `+${range(l.low_minor, l.high_minor)}`
      : range(l.low_minor, l.high_minor);
  };
  const tourLeaks = leaks.filter((l) => l.high_minor !== null);

  const words: MotionWords = {
    screens: [
      tr("tour.connections"),
      tr("factSheet"),
      tr("tour.tab.diagnosis"),
      tr("tour.tab.finding"),
      tr("decisions"),
    ],
    tourWaiting: tr("decide.nothing"),
    tourRecorded: tr("decide.recorded"),
    facts: (count) => tr("factCount", { count }),
    questions: [
      {
        question: tr("s1.q.shipping"),
        options: [
          tr("s1.under", { amount: eur(600) }),
          range(600, V2.shippingLow_minor),
          range(V2.shippingLow_minor, V2.shippingHigh_minor),
          tr("s1.dontKnow"),
        ],
        pick: 2,
        label: tr("fact.shipping"),
        value: range(V2.shippingLow_minor, V2.shippingHigh_minor),
        source: tr("s1.srcTold"),
      },
      {
        question: tr("s1.q.repeat"),
        options: [
          tr("s1.under", { amount: pct(20) }),
          `${pct(20)}–${pct(40)}`,
          tr("s1.over", { amount: pct(40) }),
          tr("s1.dontKnow"),
        ],
        pick: 3,
        label: tr("fact.repeat"),
        value: tr("s1.notKnown"),
        source: tr("s1.srcGap"),
      },
      {
        question: tr("s1.q.cash"),
        options: [...V2.cashOptions_minor.map(eur), tr("s1.dontKnow")],
        pick: 2,
        label: tr("s1.cash"),
        value: eur(V2.cashOptions_minor[2]),
        source: tr("s1.srcTold"),
      },
    ],
    leaking: tr("s3.leaking"),
    paused: tr("s3.paused"),
    approvePause: tr("s3.approvePause"),
    undoPause: tr("s3.undoPause"),
    leakAmount: eur(monthly),
    leakNone: eur(0),
    approve: tr("decide.approve"),
    undo: tr("decide.undo"),
    onRecord: (count) => tr("s4.onRecord", { count }),
    ledgerEntry: tr("s4.raiseShort", { pct: pct(V2.mug.risePct) }),
    byYou: tr("s4.byYou"),
    approved: tr("s4.approved"),
    scanned: (n) => tr("s2.scanned", { pct: pct(n) }),
    found: (count, unpriced) =>
      unpriced > 0
        ? `${tr("found", { count })} · ${tr("s2.unpriced", { count: unpriced })}`
        : tr("found", { count }),
    aMonth: (low, high) => aMonth(low === high ? eur(high) : range(low, high)),
    dayOf: (n) => tr("s5.dayOf", { day: num(n, 0, locale), days: num(V2.chartDays, 0, locale) }),
    money: eur,
    checkRange: (kind, sales) => {
      const r = checkRange(kind, sales);
      return range(r.low_minor, r.high_minor);
    },
    sorted: `${tr("s7.leaking")} ↓`,
    clock: () =>
      new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date()),
  };
  const wordsRef = useRef(words);
  wordsRef.current = words;

  useEffect(() => {
    if (!root.current) return;
    return mountLandingV2(root.current, wordsRef.current);
  }, []);

  const top = series.map((c, i) => `${geo.x(i).toFixed(1)},${geo.y(c.slipped_minor).toFixed(1)}`); // not money: a chart pixel
  const bottom = series
    .map((c, i) => `${geo.x(i).toFixed(1)},${geo.y(c.close_minor).toFixed(1)}`) // not money: a chart pixel
    .reverse();
  const candles = (
    <>
      <polygon points={[...top, ...bottom].join(" ")} fill="#F5A623" opacity=".28" />
      <polyline points={top.join(" ")} fill="none" stroke="#B26A00" strokeWidth="1.4" />
      {series.map((c, i) => {
        const x = geo.x(i);
        const y1 = geo.y(Math.max(c.open_minor, c.close_minor));
        const y2 = geo.y(Math.min(c.open_minor, c.close_minor));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={geo.y(c.high_minor)} y2={geo.y(c.low_minor)} stroke="#0D1321" />
            <rect
              x={x - geo.bw / 2}
              y={y1}
              width={geo.bw}
              height={Math.max(1.5, y2 - y1)}
              fill={c.close_minor >= c.open_minor ? "#00A86B" : "#0D1321"}
            />
          </g>
        );
      })}
    </>
  );

  const heading = (
    <>
      {first("hero.titleA")} {firstRich.rich("hero.titleB", EM)}
    </>
  );
  const run = (
    <Link className="btn go" href="/check">
      {tr("hero.run")} <span aria-hidden="true">→</span>
    </Link>
  );

  return (
    <div className="lx" ref={root}>
      <div className="lx-stage" aria-hidden="true">
        {SCENES.map((s) => (
          <div key={s.g} className={`bg${s.cls}`} data-g={s.g} data-shade={s.shade}>
            {/* A plain img: a fixed backdrop the motion code pans and fades; next/image's wrapper would break both. */}
            <img src={`${MEDIA}/g${s.g}.jpg`} alt="" loading={s.g === 0 ? "eager" : "lazy"} />
            {s.film && (
              <video muted loop playsInline preload="none">
                <source data-src={`${MEDIA}/g${s.g}.webm`} type="video/webm" />
                <source data-src={`${MEDIA}/g${s.g}.mp4`} type="video/mp4" />
              </video>
            )}
          </div>
        ))}
      </div>
      <div className="shade" data-m="shade" />
      <div className="prog" data-m="prog" />

      <header className="hd">
        <div className="in">
          <a className="logo" href="#s0" aria-label="ScaleX">
            <Mark size={32} onDark />
            <span>
              Scale<b>X</b>
            </span>
          </a>
          <nav className="nav" aria-label={first("nav.label")}>
            <a href="#s1">{tr("nav.how")}</a>
            <a href="#s6">{tr("nav.pricing")}</a>
            <a href="#s7">{tr("nav.firms")}</a>
            <Link href="/login">{first("nav.signIn")}</Link>
          </nav>
          <Link className="btn sm go" href="/check">
            {tr("nav.check")}
          </Link>
        </div>
      </header>

      <nav className="rail" aria-label={tr("nav.sections")}>
        {RAIL.map((k, i) => (
          <a key={k} href={`#s${i}`}>
            <i />
            <span>{tr(`rail.${k}`)}</span>
          </a>
        ))}
      </nav>
      <span className="ailabel">{tr("aiLabel")}</span>

      <main>
        {/* 0 · hero */}
        <section className="s hero" id="s0" data-g="0">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("hero.kicker")}</span>
              <h1 className="rv d1">{heading}</h1>
              <p className="lede rv d2">{tr("hero.lede")}</p>
              <div className="ctas rv d3">
                {run}
                <a className="btn" href="#s1">
                  {tr("hero.see")}
                </a>
              </div>
              <p className="trust rv d3">{tr("hero.trust")}</p>
            </div>
            <div className="tourwrap">
              <div className="win fx" data-m="tour" role="group" aria-label={tr("tour.aria")}>
                <Bar who={store} screen={<span data-m="tourScr">{tr("tour.connections")}</span>}>
                  {tr("tour.demo")}
                </Bar>
                <div className="tabs" role="tablist">
                  {TABS.map((k) => (
                    <button key={k} type="button" role="tab" aria-selected="false">
                      {tr(`tour.tab.${k}`)}
                      <i />
                    </button>
                  ))}
                </div>
                <div className="scenes">
                  <div className="scene">
                    <p className="lb st" style={at(0)}>
                      <span>{tr("tour.connections")}</span>
                      <span>{tr("tour.readsOnly")}</span>
                    </p>
                    {(
                      [
                        ["Shopify", "shopify"],
                        ["Google Analytics", "analytics"],
                        ["Meta Ads", "ads"],
                      ] as const
                    ).map(([name, k], i) => (
                      <div key={k} className="rw conn st" style={at(i + 1)}>
                        <span>
                          <b>{name}</b>
                          <small>{tr(`tour.reads.${k}`)}</small>
                        </span>
                        <span className="flag low a">{tr("tour.connecting")}</span>
                        <span className="flag ok b">{tr("tour.connected")}</span>
                      </div>
                    ))}
                    <p className="foot st" style={at(4)}>
                      {tr("tour.noPasswords")}
                    </p>
                  </div>
                  <div className="scene">
                    <p className="lb st" style={at(0)}>
                      <span>{tr("factSheet")}</span>
                      <span data-m="tourFacts">{tr("factCount", { count: 0 })}</span>
                    </p>
                    <div className="rw st" style={at(1)}>
                      <span>
                        {tr("fact.revenue", { days: num(V2.revenueDays, 0, locale) })}
                        <small>{tr("fact.revenueSrc")}</small>
                      </span>
                      <span className="v">{eur(V2.revenue_minor)}</span>
                    </div>
                    <div className="rw st" style={at(2)}>
                      <span>
                        {tr("fact.margin")}
                        <small>{tr("fact.marginSrc")}</small>
                      </span>
                      <span className="v">{pct(V2.marginPct, 1)}</span>
                    </div>
                    <div className="rw st" style={at(3)}>
                      <span>
                        {tr("fact.shipping")}
                        <small>{tr("fact.shippingSrc", { day: day(V2.toldOn) })}</small>
                      </span>
                      <span className="v">
                        {range(V2.shippingLow_minor, V2.shippingHigh_minor)}
                      </span>
                    </div>
                    <div className="rw st" style={at(4)}>
                      <span>
                        {tr("fact.repeat")}
                        <small>{tr("fact.repeatSrc")}</small>
                      </span>
                      <span className="flag low">{tr("fact.unknown")}</span>
                    </div>
                  </div>
                  <div className="scene">
                    <p className="lb st" style={at(0)}>
                      <span>{tr("tour.tab.diagnosis")}</span>
                      <span>{tr("found", { count: leaks.length })}</span>
                    </p>
                    <div className="meter auto">
                      <i />
                    </div>
                    {tourLeaks.map((l, i) => (
                      <div key={l.key} className="rw st" style={at(3 + i * 3)}>
                        <span>
                          {tr(`leak.${l.key}`)}
                          <small>{tr(`area.${l.area}`)}</small>
                        </span>
                        <span className="v">{leakAmount(l)}</span>
                      </div>
                    ))}
                    <p className="foot st" style={at(12)}>
                      {tr("tour.twoMore")}
                    </p>
                  </div>
                  <div className="scene">
                    <p className="lb st" style={at(0)}>
                      <span>
                        {tr("tour.tab.finding")} · {tr("area.marketing")}
                      </span>
                      <span className="flag alarm">{tr("sev.high")}</span>
                    </p>
                    <h3 className="st" style={at(1)}>
                      {tr("leak.ads")}
                    </h3>
                    <p className="big st" style={at(2)}>
                      −{eur(monthly)}
                      <small>{tr("s3.perMonth")}</small>
                    </p>
                    <div className="split st" style={at(3)}>
                      <i className="back" style={width(split.back)} />
                      <i className="lost" style={width(split.lost)} />
                    </div>
                    <p className="legend st" style={at(4)}>
                      <span>{tr("s3.cameBack", { amount: eur(V2.ad.back_minor) })}</span>
                      <span>
                        {tr("s3.lost", {
                          lost: eur(adLost_minor()),
                          spent: eur(V2.ad.spent_minor),
                        })}
                      </span>
                    </p>
                    <p className="foot st" style={at(5)}>
                      {tr("s3.source", { days: num(V2.ad.days, 0, locale) })}
                    </p>
                  </div>
                  <div className="scene">
                    <p className="lb st" style={at(0)}>
                      <span>{tr("decide.waiting")}</span>
                    </p>
                    <h3 className="st" style={at(1)}>
                      {tr("decide.pause")}
                    </h3>
                    <div className="rw st" style={at(2)}>
                      <span>{tr("decide.whatChanges")}</span>
                      <span>{tr("decide.stops")}</span>
                    </div>
                    <div className="rw st" style={at(3)}>
                      <span>{tr("decide.ifApprove")}</span>
                      <span className="v good">{tr("decide.kept", { amount: eur(monthly) })}</span>
                    </div>
                    <div className="rw st" style={at(4)}>
                      <span>{tr("decide.undo")}</span>
                      <span>{tr("decide.undoHow")}</span>
                    </div>
                    <button
                      className="lx-act st"
                      style={at(5)}
                      type="button"
                      data-m="tourBtn"
                      tabIndex={-1}
                    >
                      <span>{tr("decide.approve")}</span>
                      <span aria-hidden="true">→</span>
                    </button>
                    <p className="foot st" style={at(6)} data-m="tourLog">
                      {tr("decide.nothing")}
                    </p>
                    <div className="stamp">
                      <span>{tr("decide.stamp")}</span>
                    </div>
                  </div>
                  <Pointer name="tourCur" />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 1 · the interview, then the fact sheet */}
        <section className="s" id="s1" data-g="1">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("s1.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s1.title", EM)}</h2>
              <p className="lede rv d2">{tr("s1.lede")}</p>
            </div>
            <div className="demo">
              <div className="win fx pre" data-m="w1">
                <i className="scanline" />
                <Bar who={store} screen={tr("s1.interview")}>
                  <span data-m="factCount">{tr("factCount", { count: V2.facts })}</span>
                </Bar>
                <div className="sb ask">
                  <p className="lb st2">
                    <span>{tr("s1.asks")}</span>
                    <span>{tr("s1.oneAtATime")}</span>
                  </p>
                  <p className="lx-q st2" style={at(1)} data-m="qText" />
                  <div className="lx-opts st2" style={at(2)} data-m="qOpts" />
                  <Pointer name="qCur" />
                </div>
                <div className="sb">
                  <p className="lb st2" style={at(3)}>
                    <span>{tr("factSheet")}</span>
                    <span>{tr("s1.newest")}</span>
                  </p>
                  <div className="facts st2" style={at(4)} data-m="facts">
                    <div className="rw fact">
                      <span>
                        {tr("fact.revenue", { days: num(V2.revenueDays, 0, locale) })}
                        <small>{tr("fact.revenueSrc")}</small>
                      </span>
                      <span className="v">{eur(V2.revenue_minor)}</span>
                    </div>
                    <div className="rw fact">
                      <span>
                        {tr("fact.margin")}
                        <small>{tr("fact.marginSrc")}</small>
                      </span>
                      <span className="v">{pct(V2.marginPct, 1)}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 2 · the diagnosis */}
        <section className="s right tall" id="s2" data-g="2">
          <div className="in stickyin">
            <div className="copy">
              <span className="lab rv">{tr("s2.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s2.title", EM)}</h2>
              <p className="lede rv d2">{tr("s2.lede")}</p>
            </div>
            <div className="demo">
              <div className="win fx pre">
                <i className="scanline" />
                <Bar who={store} screen={tr("tour.tab.diagnosis")}>
                  <span data-m="scanPct">{tr("s2.scanned", { pct: pct(0) })}</span>
                </Bar>
                <div className="meter">
                  <i data-m="scanBar" />
                </div>
                <div className="sb rows">
                  {leaks.map((l) => (
                    <div key={l.key} className="leak">
                      <span className={`flag ${FLAG[l.severity]}`}>{tr(`sev.${l.severity}`)}</span>
                      <span className="t">
                        {tr(`leak.${l.key}`)}
                        <small>{tr(`area.${l.area}`)}</small>
                      </span>
                      <span className="e">{leakAmount(l)}</span>
                    </div>
                  ))}
                  <p className="total">
                    <span data-m="scanFound">{tr("found", { count: 0 })}</span>
                    <span className="m" data-m="scanSum">
                      —
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 3 · where the money goes */}
        <section className="s" id="s3" data-g="3">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("s3.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s3.title", EM)}</h2>
              <p className="lede rv d2">{tr("s3.lede")}</p>
            </div>
            <div className="demo">
              <div className="win fx pre">
                <i className="scanline" />
                <Bar who={store} screen={tr("tour.tab.finding")}>
                  {tr("area.marketing")}
                </Bar>
                <div className="sh">
                  <p className="lb st2">
                    <span>{tr("s3.kicker")}</span>
                    <span className="flag alarm" data-m="leakState">
                      {tr("s3.leaking")}
                    </span>
                  </p>
                  <h3 className="st2" style={at(1)}>
                    {tr("s3.returns", {
                      amount: moneyExact(adReturnPerEuro_minor(), V2_CURRENCY, locale),
                    })}
                  </h3>
                </div>
                <div className="sb">
                  <p className="big st2" style={at(2)}>
                    <span data-m="leakNum">{eur(monthly)}</span>
                    <small>{tr("s3.aMonthLeaking")}</small>
                  </p>
                  <div className="split st2" style={at(3)}>
                    <i className="back" data-m="splitBack" style={width(split.back)} />
                    <i className="lost" data-m="splitLost" style={width(split.lost)} />
                  </div>
                  <p className="legend st2" style={at(4)}>
                    <span>{tr("s3.cameBack", { amount: eur(V2.ad.back_minor) })}</span>
                    <span>
                      {tr("s3.lost", { lost: eur(adLost_minor()), spent: eur(V2.ad.spent_minor) })}
                    </span>
                  </p>
                  <p className="foot st2" style={at(5)}>
                    {tr("s3.working", {
                      lost: eur(adLost_minor()),
                      days: num(V2.ad.days, 0, locale),
                      month: num(V2.monthDays, 0, locale),
                      monthly: eur(monthly),
                    })}
                  </p>
                  <button className="lx-act st2" style={at(6)} data-m="sealBtn" type="button">
                    <span data-m="sealLabel">{tr("s3.approvePause")}</span>
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4 · your decision */}
        <section className="s right" id="s4" data-g="4">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("s4.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s4.title", EM)}</h2>
              <p className="lede rv d2">{tr("s4.lede")}</p>
              <div className="proofs rv d3">
                {(["readOnly", "graded", "undo", "labelled"] as const).map((k) => (
                  <div key={k}>
                    <b>{tr(`s4.proof.${k}`)}</b>
                    <span>{tr(`s4.proof.${k}Why`)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="demo">
              <div className="win fx pre">
                <i className="scanline" />
                <Bar who={store} screen={tr("decisions")}>
                  {tr("s4.waiting", { count: V2.ledger.waiting })}
                </Bar>
                <div className="dsheet" data-m="dsheet">
                  <div className="sh">
                    <p className="lb st2">
                      <span>{tr("s4.priceChange")}</span>
                      <span>{tr("s4.decideBy", { day: day(V2.decideBy) })}</span>
                    </p>
                    <h3 className="st2" style={at(1)}>
                      {tr("s4.raise", { pct: pct(V2.mug.risePct) })}
                    </h3>
                  </div>
                  <div className="sb">
                    <div className="rw st2" style={at(2)}>
                      <span>{tr("s4.now")}</span>
                      <span className="v">{moneyExact(V2.mug.now_minor, V2_CURRENCY, locale)}</span>
                    </div>
                    <div className="rw st2" style={at(3)}>
                      <span>{tr("s4.after")}</span>
                      <span className="v">
                        <span className="mk">
                          {moneyExact(mugAfter_minor(), V2_CURRENCY, locale)}
                        </span>
                      </span>
                    </div>
                    <div className="rw st2" style={at(4)}>
                      <span>{tr("decide.ifApprove")}</span>
                      <span className="v good">
                        {aMonth(`+${range(leaks[2]?.low_minor ?? 0, leaks[2]?.high_minor ?? 0)}`)}
                      </span>
                    </div>
                    <div className="rw st2" style={at(5)}>
                      <span>{tr("decide.undo")}</span>
                      <span>{tr("decide.undoHow")}</span>
                    </div>
                    <button className="lx-act st2" style={at(6)} data-m="approveBtn" type="button">
                      <span data-m="approveLabel">{tr("decide.approve")}</span>
                      <span aria-hidden="true">→</span>
                    </button>
                  </div>
                  <div className="stamp">
                    <span>{tr("decide.stamp")}</span>
                  </div>
                </div>
                <div className="ledger st2" style={at(7)} data-m="ledger">
                  <div className="ledger-head">
                    <span className="lb">
                      <span>{tr("s4.ledger")}</span>
                      <span data-m="ledgerCount">
                        {tr("s4.onRecord", { count: V2.ledger.onRecord })}
                      </span>
                    </span>
                  </div>
                  <div>
                    <span className="m">{day(V2.ledger.lastDay)}</span>
                    <span>{tr("s4.pausedOne")}</span>
                    <span className="flag ok">{tr("s4.approved")}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 5 · measured */}
        <section className="s tall" id="s5" data-g="5">
          <div className="in stickyin">
            <div className="copy">
              <span className="lab rv">{tr("s5.kicker")}</span>
              <h2 className="rv d1">{first("chart.title")}</h2>
              <p className="lede rv d2">{tr("s5.lede", { days: num(V2.chartDays, 0, locale) })}</p>
            </div>
            <div className="demo">
              <div className="win fx pre">
                <i className="scanline" />
                <Bar who={store} screen={tr("s5.marketView")}>
                  <span data-m="dayLabel">{words.dayOf(1)}</span>
                </Bar>
                <div className="sh plain">
                  <p className="lb">
                    <span>{tr("s5.salesADay", { days: num(V2.chartDays, 0, locale) })}</span>
                    <span>
                      <i className="swatch" />
                      {tr("s5.slipped")}
                    </span>
                  </p>
                </div>
                <svg
                  className="chart"
                  viewBox={`0 0 ${geo.W} ${geo.H}`}
                  role="img"
                  aria-label={tr("s5.chartAria", { days: num(V2.chartDays, 0, locale) })}
                >
                  <defs>
                    <clipPath id="lx-seen">
                      <rect data-m="chartSeen" x="0" y="0" width="0" height={geo.H} />
                    </clipPath>
                  </defs>
                  {[0, 1, 2, 3].map((k) => {
                    const y = geo.T + (k * (geo.H - geo.T - geo.B)) / 3;
                    return (
                      <line key={k} x1={geo.L} x2={geo.W - geo.R} y1={y} y2={y} stroke="#D5DAE2" />
                    );
                  })}
                  <g opacity=".16">{candles}</g>
                  <g clipPath="url(#lx-seen)">{candles}</g>
                  <line
                    data-m="chartHair"
                    y1={geo.T - 6}
                    y2={geo.H - geo.B + 4}
                    stroke="#0D1321"
                    strokeDasharray="3 3"
                  />
                  <circle data-m="chartDot" r="4" fill="#fff" stroke="#0D1321" strokeWidth="1.5" />
                  <text x={geo.L} y={geo.H - 6} className="axis">
                    {tr("s5.daysAgo", { days: num(V2.chartDays, 0, locale) })}
                  </text>
                  <text x={geo.W - geo.R} y={geo.H - 6} className="axis" textAnchor="end">
                    {tr("s5.today")}
                  </text>
                </svg>
                <div className="ohlc">
                  {(["open", "high", "low", "close"] as const).map((k) => (
                    <div key={k}>
                      <span className="k">{tr(`s5.${k}`)}</span>
                      <div className="v" data-m={`ohlc-${k}`}>
                        —
                      </div>
                    </div>
                  ))}
                </div>
                <div className="sb tight">
                  <div className="rw last">
                    <span>
                      {tr("s5.forecastFor", {
                        from: day(V2.forecast.from),
                        to: day(V2.forecast.to),
                      })}
                      <small className="strong">
                        {range(V2.forecast.low_minor, V2.forecast.high_minor)}
                      </small>
                    </span>
                    <span className="flag low">
                      {tr("s5.gradedAfter", { day: day(V2.forecast.to) })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 6 · the Trust Ladder, and what it costs */}
        <section className="s right" id="s6" data-g="6">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("s6.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s6.title", EM)}</h2>
              <p className="lede rv d2">{tr("s6.lede")}</p>
              {prices.extra_business && (
                <p className="fine rv d3">
                  {tr("s6.fine", {
                    extra: price(prices.extra_business),
                    report: price(prices.report),
                  })}
                </p>
              )}
            </div>
            <div className="demo">
              <div className="win fx pre">
                <i className="scanline" />
                <Bar who={store} screen={tr("s6.ladder")}>
                  {tr("s6.choose")}
                </Bar>
                <div className="ladder st2" data-m="ladder">
                  {LADDER.map((k, i) => (
                    <div key={k} data-here={tr("s6.yourStep")}>
                      {num(i + 1, 0, locale)} · {tr(`s6.step.${k}`)}
                    </div>
                  ))}
                </div>
                <div className="plans">
                  {PLANS.map((p, i) => (
                    <div
                      key={p.tier}
                      className={`plan st2${p.step === 3 ? " on" : ""}`}
                      style={at(i + 1)}
                      data-step={p.step}
                    >
                      <div>
                        <h3>
                          <span>{tr("s6.stepN", { n: num(p.step, 0, locale) })}</span>
                          {tr(`s6.step.${p.tier}`)}
                        </h3>
                        <p>
                          {p.tier === "autonomous"
                            ? tr("s6.what.autonomous", { times: num(V2.guaranteeTimes, 0, locale) })
                            : tr(`s6.what.${p.tier}`)}
                        </p>
                      </div>
                      <span className="pr">
                        {price(prices[p.tier])}
                        <small> {tr("s6.perMonth")}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 7 · for accounting firms */}
        <section className="s" id="s7" data-g="7">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("s7.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s7.title", EM)}</h2>
              <p className="lede rv d2">{tr("s7.lede")}</p>
            </div>
            <div className="demo">
              <div className="win fx pre" data-m="w7">
                <i className="scanline" />
                <Bar who={tr("s7.yourFirm")} screen={tr("s7.clientBook")}>
                  {tr("s7.clients", { count: V2.firm.clients })}
                </Bar>
                <div className="bk hdr">
                  <span>{tr("s7.business")}</span>
                  <span data-m="bookSort">{tr("s7.leaking")}</span>
                  <span className="n">{tr("s7.leaks")}</span>
                </div>
                <div className="book" data-m="book">
                  {V2.firm.rows.map((r) => (
                    <div key={r.key} className="bk" data-v={r.leaking_minor}>
                      <span>{tr(`s7.row.${r.key}`)}</span>
                      <span className="amt">
                        {eur(r.leaking_minor)}
                        <i style={width(ratioBp(r.leaking_minor, MAX_LEAK_MINOR) / 100)} />
                      </span>
                      <span className="n">{num(r.leaks, 0, locale)}</span>
                    </div>
                  ))}
                </div>
                <div className="sb tight">
                  <p className="foot">
                    {tr("s7.more", {
                      count: num(V2.firm.clients - V2.firm.rows.length, 0, locale),
                    })}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 8 · the free check */}
        <section className="s right" id="s8" data-g="8">
          <div className="in">
            <div className="copy">
              <span className="lab rv">{tr("s8.kicker")}</span>
              <h2 className="rv d1">{rich.rich("s8.title", EM)}</h2>
              <p className="lede rv d2">{tr("s8.lede")}</p>
              <div className="ctas rv d3">{run}</div>
            </div>
            <div className="demo">
              <div className="win fx pre">
                <i className="scanline" />
                <Bar who="ScaleX" screen={tr("nav.check")}>
                  {tr("s8.try")}
                </Bar>
                <div className="sb ck">
                  <label htmlFor="lx-kind" className="st2">
                    <span>{tr("s8.yourBusiness")}</span>
                  </label>
                  <select
                    id="lx-kind"
                    className="st2"
                    style={at(1)}
                    data-m="ckType"
                    defaultValue="shop"
                  >
                    <option value="shop">{tr("s8.shop")}</option>
                    <option value="salon">{tr("s8.salon")}</option>
                    <option value="cafe">{tr("s8.cafe")}</option>
                  </select>
                  <label htmlFor="lx-sales" className="st2" style={at(2)}>
                    <span>{tr("s8.sales")}</span>
                    <span className="m" data-m="ckRevOut">
                      {eur(V2.check.start_minor)}
                    </span>
                  </label>
                  <input
                    id="lx-sales"
                    className="st2"
                    style={at(3)}
                    data-m="ckRev"
                    type="range"
                    min={V2.check.min_minor}
                    max={V2.check.max_minor}
                    step={V2.check.step_minor}
                    defaultValue={V2.check.start_minor}
                  />
                  <div className="result st2" style={at(4)}>
                    <p className="big">
                      <span data-m="ckOut">{words.checkRange("shop", V2.check.start_minor)}</span>
                      <small>{tr("s8.likely")}</small>
                    </p>
                    <p className="foot">{tr("s8.rule")}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 9 · questions, then the closing call */}
        <section className="s" id="s9" data-g="0">
          <div className="in one">
            <div className="faq rv">
              <span className="lab">{first("faq.title")}</span>
              <details>
                <summary>{first("faq.passwordQ")}</summary>
                <p>{first("faq.passwordA")}</p>
              </details>
              <details>
                <summary>{first("faq.changeQ")}</summary>
                <p>{first("faq.changeA")}</p>
              </details>
              <details>
                <summary>{first("faq.sizeQ")}</summary>
                <p>{tr("s9.sizeA")}</p>
              </details>
              <details>
                <summary>{tr("s9.eraseQ")}</summary>
                <p>{tr("s9.eraseA")}</p>
              </details>
            </div>
            <div className="closing copy rv">
              <h2>{heading}</h2>
              <div className="ctas">
                {run}
                <a className="btn" href="#s1">
                  {tr("hero.see")}
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>
      <footer className="ft">
        <span>ScaleX · {first("foot.company")}</span>
        <span>
          <Link href="/terms">{first("foot.terms")}</Link> ·{" "}
          <Link href="/privacy">{first("foot.privacy")}</Link>
        </span>
      </footer>
    </div>
  );
}
