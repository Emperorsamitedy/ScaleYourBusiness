"use client";

// Home — /home, the first screen after sign-in. Built around the
// conversation (2026-11-17, the owner: "chatbot centred"), made a workspace
// the same day ("improve the technicality of it and sort of make it
// interactive"; docs/DASHBOARD-OVERHAUL.md section C), and laid out again on
// 2026-11-18 from the mockups he picked ("a mix between A and B").
//
// Lex speaks first, in the middle of the page: the face, what needs the
// owner today as the headline, the box to ask with three questions one
// press away, and the latest exchange with the cards it carried. Under it,
// three columns, each with its name: what needs the owner (answered in
// place or opened for a full read); the numbers (two readings, each a
// button, the sales lines with a period switch and, folded, where the money
// slips); and Lex right now (the status card with "Read now", then the
// activity feed and everything Lex made, as two tabs).
//
// It reads screens that already exist (/api/nav, /api/proposals,
// /api/cash, /api/charts, /api/chat, /api/watch) and adds no figure of its
// own. What was read last shows at once on a return and is refreshed
// behind it; the queue, the counts and the feed read themselves again
// while the tab is open (useRead.ts). A read that fails with nothing to
// show says so in its card and offers Retry; a read still out is never
// taken for an answer ("nothing to decide" needs a counted zero); and a
// refused one means the sign-in is gone: Home sends the visitor to sign in
// rather than standing empty (page.tsx checks first, on the server).

import "../../app/home.css";
import "../../app/charts.css";
import "../../app/chat.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { NavCounts } from "../../app/api/nav/route";
import type { ChartsBundle } from "../../lib/charts/load";
import { ASSISTANT } from "../../lib/core/assistant";
import { businessNoun } from "../../lib/core/business-noun";
import { minorUnitExponent } from "../../lib/core/money";
import { dayMoney, shortDate, volumeWord } from "../../lib/charts/model";
import { niceTicks } from "../../lib/charts/ticks";
import { rangeWhole } from "../../lib/charts/opportunity";
import type { ComponentKey, PricedComponent } from "../../lib/charts/opportunity";
import type { LiveVisitors as LiveReading } from "../../lib/live/visitors";
import { LexFace, lexState } from "../brand/LexFace";
import { HBars, Trend } from "../charts/Viz";
import type { BarRow } from "../charts/Viz";
import { ChatBusy, ChatTurn } from "../chat/ChatTurn";
import { TryAgain } from "../chat/TryAgain";
import { Composer } from "../chat/Composer";
import { latestExchange, latestQuestion } from "../chat/chat-view";
import { useChat } from "../chat/useChat";
import { useLexBusy, useNavRefresh } from "../nav/NavContext";
import { ReviewSheet } from "../proposals/ReviewSheet";
import { basisName, BASES } from "../report/basis";
import type { Basis } from "../report/basis";
import { Fold } from "../sheet/Fold";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { WhySheet } from "../sheet/WhySheet";
import type { WhyContent } from "../sheet/WhySheet";
import { Skeleton } from "../ui/Skeleton";
import { TabPanel, Tabs } from "../ui/Tabs";
import { useToast } from "../ui/Toast";
import { attentionCount, attentionItems } from "../nav/attention";
import { ActivityFeed } from "./ActivityFeed";
import type { LogLike } from "./activity-model";
import { mergeFeed } from "./activity-model";
import { DecisionCard } from "./DecisionCard";
import { FailedRead } from "./FailedRead";
import { longDay, moneyRange, shortDay, whole } from "./format";
import type { CashLike, PendingLike } from "./home-model";
import {
  cashReading,
  dataOf,
  periodFor,
  periodOptions,
  rankPending,
  signedOut,
  waitingCount,
} from "./home-model";
import { LiveVisitors } from "./LiveVisitors";
import { MadeList } from "./MadeList";
import { madeRows } from "./made-model";
import { NeedsList } from "./NeedsList";
import { knowsNothing, nextSteps } from "./next-steps";
import { StatusCard } from "./StatusCard";
import { useAddressParam } from "./useAddressParam";
import { useFeedNews } from "./useFeedNews";
import { useRead } from "./useRead";

/** A proposal as the queue's lists carry it, whatever its state. */
interface QueueRow {
  id: string;
  status: string;
  module?: string | null;
  action: { kind?: string; summary: string; detail?: unknown };
  created_at?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  rejection_reason?: string | null;
  change_request?: string | null;
}

interface Pending extends PendingLike {
  status: string;
  action: { kind?: string; summary: string; detail?: unknown };
  expires_at: string | null;
  created_at?: string | null;
}

/** The queue as /api/proposals returns it. */
interface Queue {
  pending: Pending[];
  blocked?: QueueRow[];
  decided: QueueRow[];
  expired: QueueRow[];
}

/** Lex's two lists; what needs the owner has a column of its own. */
type WorkTab = "activity" | "made";
const isWorkTab = (v: string | null): v is WorkTab => v === "activity" || v === "made";

/** How often the open tab reads again. */
const EVERY = { counts: 60_000, queue: 60_000, feed: 30_000 } as const;
/** Where the sales period the owner chose last is kept. */
const PERIOD_KEY = "syb.home.sales_days";

const PRICE_KEY: Readonly<Record<string, string>> = {
  "revenue.daily": "revenue",
  "booking_revenue.daily": "bookingRevenue",
};
/** The screen that owns each priced part of the month. */
const COMPONENT_HREF: Readonly<Record<ComponentKey, string>> = {
  revenue_dips: "/watch",
  // The fact sheet's second part: its charts of bookings and ads.
  no_shows: "/profile?tab=charts",
  late_cancellations: "/profile?tab=charts",
  empty_capacity: "/profile?tab=charts",
  losing_ads: "/profile?tab=charts",
  slow_stock: "/stock",
  on_the_table: "/proposals",
};

export function HomeScreen() {
  const t = useTranslations("home");
  const navT = useTranslations("nav");
  const { locale } = useTr("report");
  const { tr: ctr } = useTr("charts.market");
  const { tr: sheet } = useTr("sheet");
  const { tr: chatTr } = useTr("chat");
  const router = useRouter();
  const toast = useToast();
  const refreshNav = useNavRefresh();

  const [navRead, reloadNav] = useRead<NavCounts>("/api/nav", { every: EVERY.counts });
  const [queueRead, reloadQueue] = useRead<Queue>("/api/proposals", { every: EVERY.queue });
  const [cashRead, reloadCash] = useRead<CashLike>("/api/cash");
  const [chartsRead, reloadCharts] = useRead<ChartsBundle>("/api/charts");
  const [watchRead, reloadWatch] = useRead<{ log?: LogLike[] }>("/api/watch", {
    every: EVERY.feed,
  });
  const chat = useChat();

  const [why, setWhy] = useState<WhyContent | null>(null);
  const shut = useCallback(() => setWhy(null), []);
  const [halted, setHalted] = useState(false);
  const [live, setLive] = useState<LiveReading["status"] | null>(null);
  const [savedPeriod, setSavedPeriod] = useState<number | null>(null);

  // The open tab and the decision opened in place live in the address.
  const [tabParam, setTabParam] = useAddressParam("tab");
  const tab: WorkTab = isWorkTab(tabParam) ? tabParam : "activity";
  const [review, setReview] = useAddressParam("review");
  /** Whether this page put the review into the history: then closing is Back. */
  const pushed = useRef(false);
  const openReview = useCallback(
    (id: string) => {
      pushed.current = true;
      setReview(id, "push");
    },
    [setReview],
  );
  const closeReview = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else setReview(null);
  }, [setReview]);
  const showTab = useCallback(
    (next: WorkTab) => {
      setTabParam(next === "activity" ? null : next);
    },
    [setTabParam],
  );

  // A refused read means the sign-in ended while the page was open: page.tsx
  // already sent anyone signed out away before the first render.
  const out = signedOut([navRead, queueRead, cashRead, chartsRead, watchRead]);
  useEffect(() => {
    if (out) router.replace("/login");
  }, [out, router]);

  useEffect(() => {
    try {
      const kept = Number(window.localStorage.getItem(PERIOD_KEY));
      if (Number.isInteger(kept) && kept > 0) setSavedPeriod(kept);
    } catch {
      /* storage blocked: the default window shows */
    }
  }, []);

  const nav = dataOf(navRead);
  const queue = dataOf(queueRead);
  const cashView = dataOf(cashRead);
  const charts = dataOf(chartsRead);
  const watch = dataOf(watchRead);
  const ranked = rankPending(queue?.pending ?? []);
  const waiting = waitingCount(navRead, queueRead);
  const count = waiting.state === "known" ? waiting.count : null;
  const top = ranked[0]?.range ?? null;
  const cash = cashReading(cashView);
  // Unknown until the menu has been read: only a counted "no" shows the sign-in note.
  const signedIn = nav ? nav.access?.signed_in === true : null;
  const basis = (b: string) =>
    (BASES as readonly string[]).includes(b) ? basisName(b as Basis, sheet) : b;

  // Lex's side: everything proposed, as a feed and as a list of what was made.
  const everything = useMemo(
    () =>
      queue ? [...queue.pending, ...(queue.blocked ?? []), ...queue.decided, ...queue.expired] : [],
    [queue],
  );
  const feed = useMemo(() => mergeFeed(watch?.log ?? [], everything), [watch, everything]);
  const made = useMemo(() => madeRows(everything), [everything]);
  // What arrived in the feed since it was last looked at, the tab closed or open.
  const news = useFeedNews(
    feed,
    { log: watch !== null, proposals: queue !== null },
    tab === "activity",
  );
  /** The row the open review came from: its title is on the sheet before the read returns. */
  const reviewed = review ? (everything.find((p) => p.id === review) ?? null) : null;
  const paused = nav?.needs_reconnect ?? 0;
  const tightWeek = cash?.tight?.start ?? null;
  // L8: a person who signs up lands here before any interview, and Lex offers it
  // in the headline. Known only once the menu has been read, and only while
  // nothing waits for a decision.
  const fresh = nav !== null && knowsNothing(nav.facts) && count === 0;
  const steps = nextSteps({
    pending: count,
    connections: nav ? nav.connections : null,
    live,
    buffer: cash ? cash.lineKind === "buffer" : null,
    goals: nav ? nav.goals : null,
  });
  // One definition with the bell (components/nav/attention.ts): decisions waiting,
  // connections paused, support tickets open. A tight week in the cash forecast is a
  // warning in the list, not a thing to answer, so it is not counted.
  const needsCount = nav ? attentionCount(attentionItems(nav)) : count;

  // An answered decision leaves the list, and the button it was answered on
  // goes with it. Focus lost that way is put on the column's own name, not
  // dropped to the top of the page for the next press of Tab.
  const holding = useRef(false);
  const holdFocus = useCallback(() => {
    const at = document.activeElement;
    if (at && at !== document.body) return;
    document.getElementById("home-needs-title")?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!holding.current) return;
    holdFocus();
    // Held until the list has been read again without the answered card.
    if (queueRead.state !== "read" || !queueRead.refreshing) holding.current = false;
  }, [queueRead, holdFocus]);

  // An answer recorded here: read everything it changed again.
  const afterAnswer = useCallback(() => {
    holding.current = true;
    window.requestAnimationFrame(holdFocus);
    reloadQueue();
    reloadNav();
    reloadWatch();
    refreshNav();
  }, [holdFocus, reloadQueue, reloadNav, reloadWatch, refreshNav]);

  // The conversation: the latest exchange under the composer, and the
  // proposal a request just became, answered or opened right there.
  const turns = chat.state.phase === "ready" ? chat.state.turns : [];
  const exchange = latestExchange(turns);
  const question = latestQuestion(turns);
  const busy = chat.state.phase === "ready" && chat.state.busy;
  // The face says what Lex is doing: grey when everything is stopped, cobalt while it answers.
  const lexBusy = useLexBusy();
  const face = lexState({ stopped: halted, working: busy || lexBusy });
  const justProposed = chat.state.phase === "ready" ? chat.state.lastProposal : null;
  useEffect(() => {
    if (justProposed) reloadQueue();
  }, [justProposed, reloadQueue]);
  const proposed = justProposed
    ? (queue?.pending.find((p) => p.id === justProposed) ?? null)
    : null;
  const proposedRange = proposed ? ranked.find((r) => r.proposal.id === proposed.id)?.range : null;
  // "your salon", "your gym" from the business_type answer in English; "your business" elsewhere.
  const noun = locale === "en" ? businessNoun(nav?.business_type ?? null) : chatTr("yourBusiness");
  const now = Date.now();
  const failedLine = chatTr("sendFailed");

  // "Your sales": the window the owner chose, as far as the measured days reach.
  const market = charts?.market.status === "drawn" ? charts.market : null;
  const periods = periodOptions(market?.days.length ?? 0);
  const period = periodFor(savedPeriod, periods);
  const recent = market && period ? market.days.slice(-period) : [];
  const choosePeriod = (days: number) => {
    setSavedPeriod(days);
    try {
      window.localStorage.setItem(PERIOD_KEY, String(days));
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  };
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

  const readingStrip = navRead.state === "reading" && cashRead.state === "reading";

  if (out) return null;
  return (
    <main className="screen home hx">
      <header className="hx-hero">
        <LexFace size={92} state={face} float title={ASSISTANT} />
        <p className="hx-kicker">
          <b>{ASSISTANT}</b> · {t("kicker", { date: longDay(new Date(), locale) })}
        </p>
        <h1 className="home-title">
          {fresh
            ? t("fresh.title")
            : count !== null
              ? t("title", { count })
              : waiting.state === "unread"
                ? t("unread.title")
                : t("reading")}
        </h1>
        {fresh && (
          <>
            <p className="home-ans">{t("fresh.lede")}</p>
            <p className="home-fresh-acts">
              <Link className="home-btn home-btn-desk home-btn-first" href="/chat?interview=1">
                {chatTr("interview.withLex")}
              </Link>
              <Link className="home-btn home-btn-desk" href="/intake">
                {t("fresh.start")}
              </Link>
            </p>
          </>
        )}
        {top && !fresh && (
          <p className="home-ans">{t("biggest", { range: moneyRange(top, locale) })}</p>
        )}
        {waiting.state === "unread" && (
          <button
            type="button"
            className="home-btn home-btn-desk"
            onClick={() => {
              reloadNav();
              reloadQueue();
            }}
          >
            {t("failed.retry")}
          </button>
        )}

        <section className="hx-ask" aria-label={t("ask.label")}>
          {chat.state.phase === "ready" ? (
            <>
              <Composer
                id="home-ask"
                label={chatTr("composer.label", { noun })}
                draft={chat.state.draft}
                busy={chat.state.busy}
                setDraft={chat.setDraft}
                draftRef={chat.draftRef}
                onSend={() => void chat.send(failedLine)}
                tr={chatTr}
                compact
              />
              {/* With nothing told yet there is nothing to answer these from (L8). */}
              <div className="home-chips" role="group" aria-label={t("ask.chips")} hidden={fresh}>
                {(["today", "sales", "first"] as const).map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    className="home-chip"
                    // Not `disabled`: a chip pressed from the keyboard keeps the focus while Lex writes.
                    aria-disabled={busy}
                    onClick={() => {
                      if (!busy) void chat.ask(t(`ask.chip.${chip}`), failedLine);
                    }}
                  >
                    {t(`ask.chip.${chip}`)}
                  </button>
                ))}
              </div>
              {(exchange.length > 0 || busy) && (
                <div className="home-thread" aria-live="polite">
                  {question && (
                    <p className="hx-thread-head">
                      <span>{question}</span>
                      <Link href="/chat" className="home-link">
                        {chatTr("earlier")}
                      </Link>
                    </p>
                  )}
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
                              range={proposedRange ? moneyRange(proposedRange, locale) : null}
                              by={
                                proposed.expires_at
                                  ? t("decisions.by", {
                                      date: shortDay(proposed.expires_at, locale),
                                    })
                                  : null
                              }
                              signedIn={signedIn}
                              onDecided={afterAnswer}
                              onReview={openReview}
                            />
                          ) : (
                            <p className="ak-queued-link">
                              <Link href="/proposals">{chatTr("queued.link")}</Link>
                            </p>
                          )}
                        </>
                      )}
                      <TryAgain
                        chat={chat}
                        turn={turn}
                        last={i === exchange.length - 1}
                        tr={chatTr}
                      />
                    </ChatTurn>
                  ))}
                  {busy && <ChatBusy text={chatTr("thinking")} />}
                </div>
              )}
            </>
          ) : chat.state.phase === "loading" ? (
            <div className="hx-ask-wait">
              <Skeleton lines={1} />
            </div>
          ) : chat.state.phase === "signedout" ? (
            <p className="home-empty">{chatTr("signedOut.copy")}</p>
          ) : (
            <FailedRead onRetry={() => void chat.reload()} />
          )}
        </section>
      </header>

      <div className="hx-cols">
        <section className="hx-col" aria-labelledby="home-needs-title">
          <header className="hx-col-head">
            <h2 className="hx-col-title" id="home-needs-title" tabIndex={-1}>
              {t("tabs.needs")}
              {needsCount !== null && needsCount > 0 && (
                <span className="hx-count">{needsCount}</span>
              )}
            </h2>
            <Link href="/proposals" className="hx-col-link">
              {navT("item.proposals")}
            </Link>
          </header>
          <div className="hx-needs" aria-busy={queueRead.state === "reading"}>
            {queue ? (
              <NeedsList
                ranked={ranked}
                total={count}
                signedIn={signedIn}
                paused={paused}
                support={nav?.support_open ?? 0}
                tightWeek={tightWeek}
                steps={steps}
                locale={locale}
                onDecided={afterAnswer}
                onReview={openReview}
              />
            ) : queueRead.state === "failed" ? (
              <div className="hx-card">
                <FailedRead onRetry={reloadQueue} />
              </div>
            ) : (
              <div className="hx-card">
                <Skeleton lines={5} />
              </div>
            )}
          </div>
        </section>

        <section className="hx-col" aria-labelledby="home-numbers-title">
          <header className="hx-col-head">
            <h2 className="hx-col-title" id="home-numbers-title">
              {t("readings.label")}
            </h2>
            <Link href="/cash" className="hx-col-link">
              {navT("item.cash")}
            </Link>
          </header>

          {readingStrip ? (
            <div className="hx-card">
              <Skeleton lines={2} />
            </div>
          ) : (
            <div className="hx-tiles">
              {cash && (
                <button
                  type="button"
                  className="home-reading home-tile"
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
                  <span className="home-r-lab">{t("readings.cash")}</span>
                  <span className="home-r-val">{whole(cash.today, cash.currency, locale)}</span>
                  <span className="home-r-cmp">
                    {cash.lineKind === "buffer"
                      ? t("readings.cashCmp", { line: whole(cash.line, cash.currency, locale) })
                      : t("readings.cashZero")}
                  </span>
                  <span className="home-r-foot">
                    <span className={`flag ${cash.under ? "alarm" : "ok"}`}>
                      {cash.under ? t("flag.under") : t("flag.above")}
                    </span>
                    <span className="home-r-more">{t("why.open")}</span>
                  </span>
                </button>
              )}
              {cash && (
                <Link className="home-reading home-tile" href="/cash">
                  <span className="home-r-lab">{t("readings.lowest")}</span>
                  <span className="home-r-val">
                    {whole(cash.lowest.low, cash.currency, locale)}
                  </span>
                  <span className="home-r-cmp">
                    {t(cash.lowest.aboveToday ? "readings.lowestAbove" : "readings.lowestCmp", {
                      date: shortDay(cash.lowest.start, locale),
                    })}
                  </span>
                  <span className="home-r-foot">
                    <span className={`flag ${cash.lowest.under ? "drift" : "ok"}`}>
                      {cash.lowest.under ? t("flag.tight") : t("flag.clear")}
                    </span>
                  </span>
                </Link>
              )}
              {cashRead.state === "reading" && (
                <div className="home-reading" aria-busy="true">
                  <Skeleton lines={3} className="home-tile-skel" />
                </div>
              )}
              {cashRead.state === "failed" && (
                <div className="hx-card hx-wide">
                  <FailedRead onRetry={reloadCash} />
                </div>
              )}
            </div>
          )}

          {chartsRead.state === "reading" && (
            <section className="cs home-sales" aria-busy="true" aria-label={t("trend.label")}>
              <header className="cs-head">
                <p className="cs-label">{t("trend.label")}</p>
              </header>
              <Skeleton lines={4} />
            </section>
          )}
          {chartsRead.state === "failed" && (
            <section className="cs home-sales" aria-label={t("trend.label")}>
              <header className="cs-head">
                <p className="cs-label">{t("trend.label")}</p>
              </header>
              <FailedRead onRetry={reloadCharts} />
            </section>
          )}
          {market && latest && (
            <section className="cs home-sales" aria-label={t("trend.label")}>
              <header className="cs-head">
                <div>
                  <p className="cs-label">{t("trend.label")}</p>
                  <h3 className="cs-title">{ctr("daysMeasured", { count: recent.length })}</h3>
                </div>
                <div className="cs-meta home-sales-meta">
                  {periods.length > 1 && (
                    <div className="home-period" role="group" aria-label={t("trend.period")}>
                      {periods.map((days) => (
                        <button
                          key={days}
                          type="button"
                          aria-pressed={days === period}
                          title={ctr("daysMeasured", { count: days })}
                          onClick={() => choosePeriod(days)}
                        >
                          {t("trend.days", { count: days })}
                        </button>
                      ))}
                    </div>
                  )}
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
                      points={recent.map((d, i) => ({
                        label: dayLabels[i] ?? "",
                        value: d.volume,
                      }))}
                      format={(v) => num(v, 0, locale)}
                      label={`${volumeWord(market.volume.word, ctr)} · ${ctr("daysMeasured", { count: recent.length })}`}
                      columns={[ctr("table.day"), volumeWord(market.volume.word, ctr)]}
                    />
                  </div>
                )}
              </div>
              <p className="hx-card-foot">
                <Link href="/watch" className="home-link">
                  {t("trend.market")}
                </Link>
              </p>
            </section>
          )}

          <section className="cs home-readings" aria-label={t("live.label")}>
            <LiveVisitors onStatus={setLive} />
          </section>

          {market && priced.length > 0 && (
            <section className="cs home-slips" aria-label={t("slips.label")}>
              <div className="cs-body">
                <Fold summary={t("slips.label")} className="home-fold">
                  <p className="home-slips-meta">
                    {ctr("colMonth", { currency: market.currency })}
                  </p>
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
        </section>

        <section className="hx-col" aria-labelledby="home-lex-title">
          <header className="hx-col-head">
            <h2 className="hx-col-title" id="home-lex-title">
              {t("now.label")}
            </h2>
            <Link href="/history" className="hx-col-link">
              {t("side.history")}
            </Link>
          </header>
          <StatusCard nav={nav} face={face} onHalted={setHalted} onRead={reloadWatch} />

          <div className="home-work" id="home-work">
            <Tabs<WorkTab>
              id="home-work"
              label={t("tabs.label")}
              tabs={[
                { key: "activity", label: t("tabs.activity") },
                { key: "made", label: t("tabs.made") },
              ]}
              value={tab}
              onChange={showTab}
            />
            <section className="cs home-panel" aria-busy={queueRead.state === "reading"}>
              <TabPanel id="home-work" tab="activity" open={tab === "activity"}>
                {queue || watch ? (
                  <ActivityFeed rows={feed} news={news} onReview={openReview} />
                ) : queueRead.state === "failed" && watchRead.state === "failed" ? (
                  <FailedRead
                    onRetry={() => {
                      reloadQueue();
                      reloadWatch();
                    }}
                  />
                ) : (
                  <Skeleton lines={6} />
                )}
              </TabPanel>
              <TabPanel id="home-work" tab="made" open={tab === "made"}>
                {queue ? (
                  <MadeList rows={made} onReview={openReview} />
                ) : queueRead.state === "failed" ? (
                  <FailedRead onRetry={reloadQueue} />
                ) : (
                  <Skeleton lines={5} />
                )}
              </TabPanel>
            </section>
          </div>
        </section>
      </div>

      <ReviewSheet
        id={review}
        known={
          reviewed
            ? {
                id: reviewed.id,
                summary: reviewed.action.summary,
                module: reviewed.module,
                status: reviewed.status,
                expires_at: reviewed.expires_at,
              }
            : null
        }
        halted={halted}
        returnTo={review ? `/home?review=${review}` : "/home"}
        onClose={closeReview}
        onAnswered={(_id, answer) => {
          closeReview();
          // The sheet closes on an answer, so the toast is its receipt.
          toast(answer === "approve" ? t("toast.approved") : t("toast.declined"));
          afterAnswer();
        }}
      />
      <WhySheet content={why} onClose={shut} />
    </main>
  );
}
