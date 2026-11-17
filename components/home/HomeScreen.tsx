"use client";

// Home — /home, the first screen after sign-in. Rebuilt 2026-11-17 around
// the conversation (the owner: "chatbot centred", approvals as an
// exchange, graphs few and simple). Lex speaks first: what needs the owner
// today, as the headline. Under it the composer, and the latest exchange
// with the cards it carried, a proposal it became decided right there.
// Beside it, Lex's side: what needs your yes (decided where it stands),
// what is being done now, and what was done. Then the readings, the sales
// line and, folded, where the money slips.
//
// It reads screens that already exist (/api/nav, /api/proposals,
// /api/cash, /api/charts, /api/chat) and adds no figure of its own. A part
// whose read fails is left out in silence; the rest still shows. A read
// still out is never taken for an answer ("nothing to decide" needs a
// counted zero), and a refused one means the sign-in is gone: Home sends
// the visitor to sign in rather than standing empty (page.tsx checks
// first, on the server).

import "../../app/home.css";
import "../../app/charts.css";
import "../../app/chat.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { NavCounts } from "../../app/api/nav/route";
import type { ChartsBundle } from "../../lib/charts/load";
import { ASSISTANT } from "../../lib/core/assistant";
import { businessNoun } from "../../lib/core/business-noun";
import { Mark } from "../brand/Mark";
import { HBars, Trend } from "../charts/Viz";
import type { BarRow } from "../charts/Viz";
import { ChatBusy, ChatTurn } from "../chat/ChatTurn";
import { Composer } from "../chat/Composer";
import { latestExchange, latestQuestion } from "../chat/chat-view";
import { useChat } from "../chat/useChat";
import { basisName, BASES } from "../report/basis";
import type { Basis } from "../report/basis";
import { Fold } from "../sheet/Fold";
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
import { DecisionCard } from "./DecisionCard";
import type { CashLike, DoneLike, DoneWord, PendingLike, Read } from "./home-model";
import {
  cashReading,
  dataOf,
  doneRows,
  rankPending,
  readOutcome,
  signedOut,
  waitingCount,
  waitingLine,
} from "./home-model";
import { LiveVisitors } from "./LiveVisitors";

/** One read of a JSON route; `version` re-reads it, keeping what it had meanwhile. */
function useRead<T>(url: string, version = 0): Read<T> {
  const [read, setRead] = useState<Read<T>>({ state: "reading" });
  useEffect(() => {
    let alive = true;
    fetch(url, { cache: "no-store" })
      .then(async (r): Promise<Read<T>> => {
        const outcome = readOutcome(r.status);
        return outcome === "read"
          ? { state: "read", data: (await r.json()) as T }
          : { state: outcome };
      })
      .then((next) => {
        if (alive) setRead(next);
      })
      .catch(() => {
        if (alive) setRead({ state: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [url, version]);
  return read;
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
  action: { kind?: string; summary: string; detail?: unknown };
  expires_at: string | null;
}

/** The queue as /api/proposals returns it: what waits, and what was answered. */
interface Queue {
  pending: Pending[];
  decided: DoneLike[];
  expired: DoneLike[];
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
/** The tint behind each recorded word; the word carries the meaning. */
const DONE_TONE: Readonly<Record<DoneWord, string>> = {
  approved: "ok",
  done: "ok",
  declined: "low",
  changes: "low",
  expired: "drift",
  blocked: "drift",
};

export function HomeScreen() {
  const t = useTranslations("home");
  const { tr: rtr, locale } = useTr("report");
  const { tr: ctr } = useTr("charts.market");
  const { tr: sheet } = useTr("sheet");
  const { tr: chatTr } = useTr("chat");
  const tChat = useTranslations("chat");
  const router = useRouter();
  // The queue is read again after an answer here, or a request that became a proposal.
  const [version, setVersion] = useState(0);
  const reread = useCallback(() => setVersion((v) => v + 1), []);
  const navRead = useRead<NavCounts>("/api/nav", version);
  const queueRead = useRead<Queue>("/api/proposals", version);
  const cashRead = useRead<CashLike>("/api/cash");
  const chartsRead = useRead<ChartsBundle>("/api/charts");
  const chat = useChat();
  const [why, setWhy] = useState<WhyContent | null>(null);
  const shut = useCallback(() => setWhy(null), []);
  // A refused read means the sign-in ended while the page was open: page.tsx
  // already sent anyone signed out away before the first render.
  const out = signedOut([navRead, queueRead, cashRead, chartsRead]);
  useEffect(() => {
    if (out) router.replace("/login");
  }, [out, router]);

  const nav = dataOf(navRead);
  const queue = dataOf(queueRead);
  const cashView = dataOf(cashRead);
  const charts = dataOf(chartsRead);
  const ranked = rankPending(queue?.pending ?? []);
  const waiting = waitingCount(navRead, queueRead);
  const count = waiting.state === "known" ? waiting.count : null;
  const top = ranked[0]?.range ?? null;
  const line = waitingLine(count, top !== null);
  const cash = cashReading(cashView);
  const done = doneRows([...(queue?.decided ?? []), ...(queue?.expired ?? [])]);
  const signedIn = nav?.access?.signed_in === true;
  const basis = (b: string) =>
    (BASES as readonly string[]).includes(b) ? basisName(b as Basis, rtr) : b;
  const range = (r: {
    low: { amount_minor: number; currency: string };
    high: { amount_minor: number; currency: string };
  }) =>
    `${signed(r.low.amount_minor, r.low.currency, locale)} – ${signed(r.high.amount_minor, r.high.currency, locale)}`;

  // The conversation: the latest exchange under the composer, and the
  // proposal a request just became, decided right there.
  const turns = chat.state.phase === "ready" ? chat.state.turns : [];
  const exchange = latestExchange(turns);
  const question = latestQuestion(turns);
  const busy = chat.state.phase === "ready" && chat.state.busy;
  const justProposed = chat.state.phase === "ready" ? chat.state.lastProposal : null;
  useEffect(() => {
    if (justProposed) reread();
  }, [justProposed, reread]);
  const proposed = justProposed
    ? (queue?.pending.find((p) => p.id === justProposed) ?? null)
    : null;
  const proposedRange = proposed ? ranked.find((r) => r.proposal.id === proposed.id)?.range : null;
  // "your salon", "your gym" from the business_type answer in English; "your business" elsewhere.
  const noun = locale === "en" ? businessNoun(nav?.business_type ?? null) : chatTr("yourBusiness");
  const now = Date.now();

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

  if (out) return null;
  return (
    <main className="screen home">
      <header className="home-head">
        <p className="home-kicker">
          <span className="home-lex">
            <span className="home-lex-mark" aria-hidden="true">
              <Mark size={14} onDark />
            </span>
            {ASSISTANT}
          </span>
          <span>{t("kicker", { date: longDay(new Date(), locale) })}</span>
        </p>
        <h1 className="home-title">
          {count !== null
            ? t("title", { count })
            : waiting.state === "unread"
              ? t("unread.title")
              : t("reading")}
        </h1>
        {top && <p className="home-ans">{t("biggest", { range: range(top) })}</p>}
        {waiting.state === "unread" && <p className="home-ans">{t("unread.body")}</p>}
      </header>

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
            {t("cash.open")}
          </Link>
        </section>
      )}

      <div className="home-main">
        <section className="cs home-ask" aria-labelledby="home-ask-title">
          <header className="cs-head">
            <div>
              <p className="cs-label">{t("ask.label")}</p>
              <h2 className="cs-title home-ask-title" id="home-ask-title">
                {question ?? t("ask.title")}
              </h2>
            </div>
            {turns.length > 0 && (
              <div className="cs-meta">
                <Link href="/chat" className="home-link">
                  {chatTr("earlier")}
                </Link>
              </div>
            )}
          </header>
          {chat.state.phase === "ready" ? (
            <>
              <Composer
                id="home-ask"
                label={chatTr("composer.label", { noun })}
                draft={chat.state.draft}
                busy={chat.state.busy}
                setDraft={chat.setDraft}
                draftRef={chat.draftRef}
                onSend={() => void chat.send(chatTr("sendFailed"))}
                tr={chatTr}
                intro={
                  turns.length === 0 ? (
                    <p>{tChat.rich("empty", { noun, em: (chunks) => <em>{chunks}</em> })}</p>
                  ) : undefined
                }
              />
              {(exchange.length > 0 || busy) && (
                <div className="home-thread" aria-live="polite">
                  {exchange.map((turn, i) => (
                    <ChatTurn
                      key={turn.id}
                      turn={turn}
                      cards={chat.state.phase === "ready" ? chat.state.cards : []}
                      onChanged={chat.onChanged}
                      now={now}
                      locale={locale}
                      tr={chatTr}
                    >
                      {i === exchange.length - 1 && turn.role === "system" && justProposed && (
                        <>
                          <p className="ak-queued inset">{chatTr("queued.text")}</p>
                          {proposed ? (
                            <DecisionCard
                              proposal={proposed}
                              range={proposedRange ? range(proposedRange) : null}
                              by={
                                proposed.expires_at
                                  ? t("decisions.by", {
                                      date: shortDay(proposed.expires_at, locale),
                                    })
                                  : null
                              }
                              signedIn={signedIn}
                              onDecided={reread}
                            />
                          ) : (
                            <p className="ak-queued-link">
                              <Link href="/proposals">{chatTr("queued.link")}</Link>
                            </p>
                          )}
                        </>
                      )}
                    </ChatTurn>
                  ))}
                  {busy && <ChatBusy text={chatTr("thinking")} />}
                </div>
              )}
            </>
          ) : (
            <p className="home-empty">
              {chat.state.phase === "loading"
                ? chatTr("loading")
                : chat.state.phase === "signedout"
                  ? chatTr("signedOut.copy")
                  : chatTr("error.copy")}
            </p>
          )}
        </section>

        <section className="cs home-readings" aria-label={t("readings.label")}>
          <LiveVisitors />
          <div className="home-strip">
            {waiting.state !== "unread" && (
              <div className="home-reading">
                <p className="home-r-lab">{t("readings.waiting")}</p>
                <p className="home-r-val">{count ?? "—"}</p>
                <p className="home-r-cmp">
                  {line === "none"
                    ? t("readings.waitingNone")
                    : line === "biggest" && top
                      ? t("readings.waitingCmp", { range: range(top) })
                      : null}
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
            )}
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
        </section>

        {market && latest && (
          <section className="cs home-sales" aria-label={t("trend.label")}>
            <header className="cs-head">
              <div>
                <p className="cs-label">{t("trend.label")}</p>
                <h2 className="cs-title">{ctr("daysMeasured", { count: recent.length })}</h2>
              </div>
              <div className="cs-meta">
                <Link href="/watch" className="home-link">
                  {t("trend.market")}
                </Link>
              </div>
            </header>
            <div className="home-trends">
              <div className="home-trend">
                <p className="home-r-lab">{priceLabel}</p>
                <p className="home-r-val">
                  {dayMoney(latest.value_minor, market.currency, locale)}
                </p>
                <p className="home-r-cmp">
                  {shortDate(latest.date, locale)} · {market.price.source} ·{" "}
                  <span className="word">{sheet(`basis.${market.price.basis}`)}</span>
                </p>
                <Trend
                  points={recent.map((d, i) => ({
                    label: dayLabels[i] ?? "",
                    value: d.value_minor,
                  }))}
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
          </section>
        )}

        {market && priced.length > 0 && (
          <section className="cs home-slips" aria-label={t("slips.label")}>
            <div className="cs-body">
              <Fold summary={t("slips.label")} className="home-fold">
                <p className="home-slips-meta">{ctr("colMonth", { currency: market.currency })}</p>
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
              </Fold>
            </div>
          </section>
        )}
      </div>

      <aside className="home-side" aria-label={t("side.label")}>
        <section className="cs home-decisions" aria-labelledby="home-dec-label">
          <header className="cs-head">
            <div>
              <p className="cs-label" id="home-dec-label">
                {t("side.decisions")}
              </p>
              <h2 className="cs-title">
                {count !== null
                  ? t("side.decisionsCount", { count })
                  : waiting.state === "unread"
                    ? t("side.unread")
                    : t("reading")}
              </h2>
            </div>
            {ranked.length > 0 && (
              <div className="cs-meta">
                <Link href="/proposals" className="home-link">
                  {t("decisions.all")}
                </Link>
              </div>
            )}
          </header>
          {queue && ranked.length === 0 && <p className="home-empty">{t("decisions.empty")}</p>}
          {ranked.length > 0 && (
            <div className="home-cards">
              {ranked.map(({ proposal: p, range: r }) => (
                <DecisionCard
                  key={p.id}
                  proposal={p}
                  range={r ? range(r) : null}
                  by={
                    p.expires_at
                      ? t("decisions.by", { date: shortDay(p.expires_at, locale) })
                      : null
                  }
                  signedIn={signedIn}
                  onDecided={reread}
                />
              ))}
            </div>
          )}
        </section>

        <section className="cs home-doing" aria-labelledby="home-doing-label">
          <header className="cs-head">
            <div>
              <p className="cs-label" id="home-doing-label">
                {t("side.doing")}
              </p>
              <h2 className="cs-title">
                {nav?.watch
                  ? t("watch.title", { day: nav.watch.day, of: nav.watch.of })
                  : nav
                    ? t("doing.idle")
                    : t("reading")}
              </h2>
            </div>
          </header>
          <div className="cs-body">
            {nav?.watch && (
              <div className="home-days" aria-hidden="true">
                {Array.from({ length: nav.watch.of }, (_, i) => (
                  <i
                    key={i}
                    className={i < nav.watch!.day - 1 ? "d" : i === nav.watch!.day - 1 ? "n" : ""}
                  />
                ))}
              </div>
            )}
            <p className="home-note">{nav?.watch ? t("watch.note") : t("doing.idleNote")}</p>
            {nav && (
              <p className="home-note">
                {nav.needs_reconnect > 0
                  ? t("doing.paused", { count: nav.needs_reconnect })
                  : t("doing.connections", { count: nav.connections })}
              </p>
            )}
            <Link href="/watch" className="home-link">
              {t("watch.open")}
            </Link>
          </div>
        </section>

        <section className="cs home-done" aria-labelledby="home-done-label">
          <header className="cs-head">
            <div>
              <p className="cs-label" id="home-done-label">
                {t("side.done")}
              </p>
            </div>
            <div className="cs-meta">
              <Link href="/history" className="home-link">
                {t("side.history")}
              </Link>
            </div>
          </header>
          {queue && done.length === 0 && <p className="home-empty">{t("done.empty")}</p>}
          {done.length > 0 && (
            <ul className="home-done-rows">
              {done.map((d) => (
                <li key={d.id}>
                  <span className={`flag ${DONE_TONE[d.word]}`}>{t(`done.${d.word}`)}</span>
                  <span className="home-done-ti">{d.title}</span>
                  {d.at && <span className="home-done-at">{shortDay(d.at, locale)}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>

      <WhySheet content={why} onClose={shut} />
    </main>
  );
}
