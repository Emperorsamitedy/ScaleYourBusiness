"use client";

// Insights · Watching — the owner's Watching design (2026-10-17) on the
// watch status screen of Session H (P1-47/48) and P2-24. Answers "what is
// it doing right now" with real activity only: the day count comes from
// the mode decision, every signal is a series a connection actually
// holds (judged by the anomaly layer's own rules, lib/watch/watch-view),
// every note and log line is a watch_activity row for work performed.
// Module selection (P1-48) stays at the foot: it has no other home, and
// the weekly summary email's switch (idea 42) sits beside it, because the
// email is this screen's week, sent. Phone alerts (idea 53) follow it: the
// other way the owner hears from SYB without opening it.
//
// L-3a: the screen's words are the "watch" catalogue in the reader's
// language, and every figure and date their own writing. A signal's noun,
// a rule's text and a log line are written by lib/ (L-4 of
// TASKS-LANGUAGES.md) or stored as they happened; L-4a reads them in the
// reader's language through lib/watch/words ("watchWords").

import "../../app/watch.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { PhoneAlertsCard } from "./PhoneAlertsCard";
import { moneyText, num } from "../sheet/num";
import { useAppLocale, useTr } from "../sheet/useTr";
import { minorUnitExponent } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { WatchReading } from "../../lib/watch/signals";
import type { SignalStatus, WatchDays, WatchSignal } from "../../lib/watch/watch-view";
import {
  NOTED_KINDS,
  dayOfWatch,
  notedLines,
  parseInstant,
  watchDays,
} from "../../lib/watch/watch-view";
import { MIN_BASELINE_DAYS, RUN_DAYS } from "../../lib/anomaly/baseline";
import type { WatchWords } from "../../lib/watch/words";
import { logWords, moduleWords, ruleWords, signalNoun, sourceWords } from "../../lib/watch/words";

/** L-4a: the watch's lib-built words in the reader's language. */
function useWatchWords(): WatchWords {
  return useTr("watchWords");
}

interface LogEntry {
  at: string;
  kind: string;
  detail: string;
  /** What the line is about, when the line itself doesn't say (a goal's statement). */
  subject?: string | null;
}
interface WatchView {
  decision: {
    mode: "instant" | "watching";
    watch_weeks: number | null;
    review_at: string;
  } | null;
  days_remaining: number | null;
  /** P2-24: each rule says whether code enforces it yet. */
  thresholds: { text: string; enforced: boolean }[];
  /** Open anomalies that crossed an enforced rule. */
  interruptions: { id: string; detail: string; detected_at: string; metric_key: string }[];
  log: LogEntry[];
}
interface ModulesView {
  /** `why` marks a switch that isn't "for when I start acting" (P5-18's team module). */
  modules: { module: string; enabled: boolean; why?: string }[];
  analytics: { enabled: boolean; fixed: boolean; why: string };
}
/** Idea 42: the weekly summary email switch (GET /api/summary). */
interface SummaryView {
  enabled: boolean;
  owner: boolean;
  in_care: boolean;
  sending: boolean;
  configured: boolean;
  last_sent_at: string | null;
}

const DAY_MS = 86_400_000;
/** The window THIN is judged over (lib/watch/watch-view THIN_RULE). */
const THIN_WINDOW_DAYS = 28;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "26 Oct" / "Mon 26 Oct", in UTC so server and browser agree; another language writes its own. */
export function dayText(iso: string, weekday = false, locale: AppLocale = "en"): string {
  const d = new Date(parseInstant(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
  if (locale !== "en") {
    return new Intl.DateTimeFormat(intlTag(locale), {
      day: "numeric",
      month: "short",
      ...(weekday ? { weekday: "short" as const } : {}),
      timeZone: "UTC",
    }).format(d);
  }
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]} ${day}` : day;
}

const STATUS_CLASS: Record<SignalStatus, string> = {
  steady: "ok",
  drifting: "drift",
  interrupted: "alarm",
  thin: "low",
};
const STATUS_ORDER: SignalStatus[] = ["steady", "drifting", "interrupted", "thin"];

/** A per-day figure: whole units from 100 up, cents below; counts to one decimal when small. */
function perDay(signal: WatchSignal, value: number, locale: AppLocale): string {
  if (signal.currency === null) return num(value, value < 100 ? 1 : 0, locale);
  const exp = minorUnitExponent(signal.currency);
  const major = value / 10 ** exp;
  return Math.abs(major) < 100
    ? moneyText(Math.round(value), signal.currency, locale)
    : moneyText(Math.round(major) * 10 ** exp, signal.currency, locale);
}

function weeks(signal: WatchSignal, locale: AppLocale): string {
  if (signal.last_week === null) return "—";
  const last = perDay(signal, signal.last_week, locale);
  return signal.first_week === null
    ? last
    : `${perDay(signal, signal.first_week, locale)} → ${last}`;
}

function DayStrip({ w }: { w: WatchDays }) {
  const t = useTranslations("watch");
  const locale = useAppLocale();
  return (
    <section className="wt-days" aria-label={t("days.label", { day: w.day, of: w.of })}>
      <ol className="wt-strip" style={{ ["--wt-of" as string]: w.of }}>
        {Array.from({ length: w.of }, (_, i) => i + 1).map((d) => (
          <li
            key={d}
            className={`wt-day${d < w.day ? " past" : ""}${d === w.day ? " today" : ""}`}
            aria-current={d === w.day ? "date" : undefined}
          >
            {num(d, 0, locale)}
          </li>
        ))}
      </ol>
      <p className="wt-days-cap">
        <span>{t("days.started", { date: dayText(w.start, false, locale) })}</span>
        <span>{t("days.legend")}</span>
        <span>{t("days.ends", { date: dayText(w.end, false, locale) })}</span>
      </p>
    </section>
  );
}

function SignalsCard({ reading }: { reading: WatchReading }) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  const locale = useAppLocale();
  const { signals } = reading;
  const hasThin = signals.some((s) => s.status === "thin");
  const hasDrift = signals.some((s) => s.status === "drifting" || s.status === "interrupted");
  const tally = STATUS_ORDER.map((s) => [s, signals.filter((x) => x.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => t(`tally.${s}`, { count: n }))
    .join(" · ");
  const foot =
    hasThin || hasDrift ? (
      <>
        {hasThin && <>{t("signals.thinRule", { min: MIN_BASELINE_DAYS, of: THIN_WINDOW_DAYS })} </>}
        {hasDrift && <>{t("signals.driftRule", { days: RUN_DAYS })}</>}
      </>
    ) : undefined;
  return (
    <SheetCard
      label={t("signals.label")}
      title={
        signals.length === 0
          ? t("signals.nothing")
          : reading.connections > 0
            ? t("signals.titleRead", { count: signals.length })
            : t("signals.titleNotRead", { count: signals.length })
      }
      meta={signals.length > 0 ? tally : undefined}
      foot={foot}
    >
      {signals.length === 0 ? (
        <p className="wt-empty">
          {reading.connections === 0
            ? t.rich("signals.connect", {
                a: (chunks) => <Link href="/connections">{chunks}</Link>,
              })
            : t("signals.noDaily")}
        </p>
      ) : (
        <div className="wt-table-wrap" tabIndex={0} aria-label={t("signals.tableLabel")}>
          <table className="rt wt-table">
            <thead>
              <tr>
                <th scope="col">{t("signals.col.signal")}</th>
                <th scope="col">{t("signals.col.from")}</th>
                <th scope="col" className="num">
                  {t("signals.col.days")}
                </th>
                <th scope="col" className="num wt-wrap">
                  {t("signals.col.perDay", { week: 1 })}
                </th>
                <th scope="col">{t("signals.col.status")}</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.key}>
                  <th scope="row">
                    {signalNoun(s.metric_key, s.noun, ww)}
                    {s.currency && signals.filter((x) => x.noun === s.noun).length > 1
                      ? ` (${s.currency})`
                      : ""}
                  </th>
                  <td className="src">{sourceWords(s.read_from, ww)}</td>
                  <td className="num">{num(s.readings, 0, locale)}</td>
                  <td className="num">{weeks(s, locale)}</td>
                  <td>
                    <span
                      className={`word ${STATUS_CLASS[s.status]}`}
                      title={
                        s.since
                          ? t(s.direction === "drop" ? "signals.below" : "signals.above", {
                              date: dayText(s.since, false, locale),
                            })
                          : undefined
                      }
                    >
                      {t(`status.${s.status}`)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SheetCard>
  );
}

function NotedCard({ log, w }: { log: LogEntry[]; w: WatchDays }) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  const noted = notedLines(log, w);
  const newest = noted[0];
  const fresh = newest ? Date.now() - parseInstant(newest.at) < 2 * DAY_MS : false;
  return (
    <SheetCard label={t("noted.label")} title={t("noted.title")}>
      {noted.length === 0 ? (
        <p className="wt-empty">{t("noted.empty")}</p>
      ) : (
        <ul className="wt-notes">
          {noted.map((e, i) => (
            <li key={`${e.at}-${e.kind}`}>
              <span className="wt-at">
                {t("noted.day", { day: dayOfWatch(e.at, w.start, w.of) ?? 0 })}
              </span>
              <p>
                {i === 0 && fresh ? (
                  <span className="marked">{logWords(e.detail, ww)}</span>
                ) : (
                  logWords(e.detail, ww)
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

/**
 * I-45b: what was noticed when no watch is running (instant mode, or no
 * decision yet), review alerts among them. Dated by day, since there is no
 * watch day to number them by; drawn only when there is a line to show.
 */
function NoticedCard({ log }: { log: LogEntry[] }) {
  const t = useTranslations("watchNoticed");
  const locale = useAppLocale();
  const noted = notedLines(log, null);
  const newest = noted[0];
  if (!newest) return null;
  const fresh = Date.now() - parseInstant(newest.at) < 2 * DAY_MS;
  return (
    <SheetCard label={t("label")} title={t("title")}>
      <ul className="wt-notes">
        {noted.map((e, i) => (
          <li key={`${e.at}-${e.kind}`}>
            <span className="wt-at">{dayText(e.at, false, locale)}</span>
            <p>{i === 0 && fresh ? <span className="marked">{e.detail}</span> : e.detail}</p>
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

function WhenCard({ w }: { w: WatchDays }) {
  const t = useTranslations("watch");
  const locale = useAppLocale();
  return (
    <SheetCard
      label={t("when.label")}
      foot={
        <span className="wt-foot-row">
          <span>{t("when.foot")}</span>
          <Link className="act" href="/mode">
            {t("when.link")}
          </Link>
        </span>
      }
    >
      <ul className="wt-when">
        <li>
          <span className="wt-at">{dayText(w.end, false, locale)}</span>
          <span>{t("when.ends")}</span>
        </li>
        <li>
          <span className="wt-at">{t("when.after")}</span>
          <span>{t("when.afterText")}</span>
        </li>
        <li>
          <span className="wt-at">{t("when.always")}</span>
          <span>{t("when.alwaysText")}</span>
        </li>
      </ul>
    </SheetCard>
  );
}

function ActivityCard({ log }: { log: LogEntry[] }) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  const locale = useAppLocale();
  const work = log.filter((e) => !NOTED_KINDS.has(e.kind));
  return (
    <SheetCard label={t("activity.label")} title={t("activity.title")}>
      {work.length === 0 ? (
        <p className="wt-empty">{t("activity.empty")}</p>
      ) : (
        <ul className="wt-notes">
          {work.slice(0, 12).map((e, i) => (
            <li key={`${e.at}-${e.kind}-${i}`}>
              <span className="wt-at">{dayText(e.at, false, locale)}</span>
              <p>
                {e.subject ? `${e.subject} · ` : ""}
                {logWords(e.detail, ww)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

function RulesCard({ thresholds }: { thresholds: WatchView["thresholds"] }) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  return (
    <SheetCard label={t("rules.label")}>
      <ul className="wt-rules">
        {thresholds.map((r) => (
          <li key={r.text}>
            <span>{ruleWords(r.text, ww)}</span>
            <span className={`word ${r.enforced ? "ok" : "low"}`}>
              {r.enforced ? t("rules.checked") : t("rules.notChecked")}
            </span>
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

function ModulesCard({
  modules,
  onToggle,
}: {
  modules: ModulesView;
  onToggle: (module: string, enabled: boolean) => void;
}) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  return (
    <SheetCard label={t("modules.label")} title={t("modules.title")}>
      <fieldset className="wt-modules">
        <legend className="sr-only">{t("modules.label")}</legend>
        {modules.modules
          .filter((m) => !m.why)
          .map((m) => (
            <label key={m.module} className="wt-module">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => onToggle(m.module, e.target.checked)}
              />
              <span>{t("modules.name", { module: m.module })}</span>
            </label>
          ))}
        <label className="wt-module fixed" title={moduleWords(modules.analytics.why, ww)}>
          <input type="checkbox" checked disabled />
          <span>{t("modules.analytics")}</span>
        </label>
      </fieldset>
      <p className="wt-why">{moduleWords(modules.analytics.why, ww)}</p>
      {modules.modules
        .filter((m) => m.why)
        .map((m) => (
          <div key={m.module} className="wt-module-now">
            <label className="wt-module">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => onToggle(m.module, e.target.checked)}
              />
              <span>{t("modules.rolesNotPeople", { module: m.module })}</span>
            </label>
            <p className="wt-why">
              {moduleWords(m.why ?? "", ww)}
              {m.enabled && (
                <>
                  {" "}
                  <Link href="/team">{t("modules.teamLink")}</Link>
                </>
              )}
            </p>
          </div>
        ))}
    </SheetCard>
  );
}

function SummaryCard({
  summary,
  onToggle,
}: {
  summary: SummaryView;
  onToggle: (enabled: boolean) => void;
}) {
  const t = useTranslations("watch.summary");
  const locale = useAppLocale();
  const status = !summary.owner
    ? t("signUp")
    : !summary.enabled
      ? t("off")
      : !summary.in_care
        ? t("notDecided")
        : !summary.configured
          ? t("noEmail")
          : summary.last_sent_at
            ? t("lastSent", { date: dayText(summary.last_sent_at, false, locale) })
            : t("first");
  return (
    <SheetCard label={t("label")} title={t("title")}>
      <label className="wt-module">
        <input
          type="checkbox"
          checked={summary.enabled}
          disabled={!summary.owner}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>{t("switch")}</span>
      </label>
      <p className="wt-why">
        {t("lede")} {status}
      </p>
    </SheetCard>
  );
}

function Frame({
  title,
  notes,
  children,
}: {
  title: ReactNode;
  notes?: ReactNode;
  children?: ReactNode;
}) {
  const t = useTranslations("watch");
  return (
    <main className="screen wt-screen">
      <PageHead kicker={t("kicker")} title={title}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

export function WatchScreen({ reading }: { reading: WatchReading | null }) {
  const t = useTranslations("watch");
  const locale = useAppLocale();
  const [view, setView] = useState<WatchView | null>(null);
  const [modules, setModules] = useState<ModulesView | null>(null);
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, m] = await Promise.all([fetch("/api/watch"), fetch("/api/modules")]);
      if (w.status === 401) return setFailed("signed_out");
      if (!w.ok || !m.ok) return setFailed("error");
      setView((await w.json()) as WatchView);
      setModules((await m.json()) as ModulesView);
    } catch {
      setFailed("error");
    }
    // The summary switch is optional: the screen stands without it.
    try {
      const s = await fetch("/api/summary");
      setSummary(s.ok ? ((await s.json()) as SummaryView) : null);
    } catch {
      setSummary(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (module: string, enabled: boolean) => {
    await fetch("/api/modules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ module, enabled }),
    });
    await load();
  };

  const toggleSummary = async (enabled: boolean) => {
    await fetch("/api/summary", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    await load();
  };

  if (failed === "signed_out") {
    return (
      <Frame title={t("signedOut.title")}>
        <p className="wt-wait">
          {t.rich("signedOut.lede", { a: (chunks) => <Link href="/intake">{chunks}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={t("failed.title")}>
        <p className="wt-wait">{t("failed.lede")}</p>
      </Frame>
    );
  }
  if (!view || !modules) {
    return <Frame title={t("reading")} />;
  }

  const w = watchDays(view.decision, new Date());
  const lower = (
    <div className="wt-grid">
      <ActivityCard log={view.log} />
      <div className="wt-side">
        {!w && <NoticedCard log={view.log} />}
        <RulesCard thresholds={view.thresholds} />
        <ModulesCard modules={modules} onToggle={(m, on) => void toggle(m, on)} />
        {summary && <SummaryCard summary={summary} onToggle={(on) => void toggleSummary(on)} />}
        <PhoneAlertsCard />
      </div>
    </div>
  );

  if (!w) {
    return (
      <Frame
        title={view.decision === null ? t("none.title") : t("none.instantTitle")}
        notes={
          <p>
            {view.decision === null ? t("none.notDecided") : t("none.instant")}{" "}
            <Link href="/mode">{t("none.link")}</Link>
          </p>
        }
      >
        {lower}
      </Frame>
    );
  }

  const ran = reading?.executions_since_start ?? 0;
  const complete = w.days_remaining === 0;
  const title = complete
    ? t("title.complete", { of: w.of })
    : ran === 0
      ? t("title.untouched", { day: w.day, of: w.of })
      : t("title.changes", { day: w.day, of: w.of, count: ran });
  const conns = reading?.connections ?? 0;
  const ends = dayText(w.end, true, locale);

  return (
    <Frame
      title={title}
      notes={
        <>
          <p>{t("notes.hold")}</p>
          <p className="wt-live">
            <span className="wt-sq" aria-hidden="true" />
            {conns > 0 ? (
              <span>
                {complete
                  ? t("notes.readingEnded", { count: conns, date: ends })
                  : t("notes.readingEnds", { count: conns, date: ends })}
              </span>
            ) : (
              <span>
                {t.rich(complete ? "notes.noneEnded" : "notes.noneEnds", {
                  date: ends,
                  a: (chunks) => <Link href="/connections">{chunks}</Link>,
                })}
              </span>
            )}
          </p>
        </>
      }
    >
      <DayStrip w={w} />
      <div className="wt-grid">
        {reading ? (
          <SignalsCard reading={reading} />
        ) : (
          <SheetCard label={t("signals.label")} title={t("signals.nothing")} />
        )}
        <div className="wt-side">
          <NotedCard log={view.log} w={w} />
          <WhenCard w={w} />
        </div>
      </div>
      {lower}
    </Frame>
  );
}
