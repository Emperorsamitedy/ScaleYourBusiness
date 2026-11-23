"use client";

// Insights · Watching — the owner's Watching design (2026-10-17) on the
// watch status screen of Session H (P1-47/48) and P2-24. Answers "what is
// it doing right now" with real activity only: the day count comes from
// the mode decision, every signal is a series a connection actually
// holds (judged by the anomaly layer's own rules, lib/watch/watch-view),
// every note and log line is a watch_activity row for work performed.
// Module selection (P1-48), the weekly summary's switch (idea 42) and
// phone alerts (idea 53) moved to their own settings screen on 2026-11-15
// (/settings/alerts, WatchSettingsScreen below): this screen says what is
// being watched, and one line at its foot points to where they now live.
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
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { PhoneAlertsCard } from "./PhoneAlertsCard";
import { Spark, Trend } from "../charts/Viz";
import { Sheet } from "../ui/Sheet";
import { WhyFold } from "../report/WhyFold";
import { moneyText, num } from "../sheet/num";
import { useAppLocale, useTr } from "../sheet/useTr";
import { minorUnitExponent } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { WatchReading } from "../../lib/watch/signals";
import type { SignalStatus, WatchDays, WatchSignal } from "../../lib/watch/watch-view";
import {
  NOTED_KINDS,
  anomalySpan,
  notedLines,
  parseInstant,
  watchDays,
} from "../../lib/watch/watch-view";
import { MIN_BASELINE_DAYS, RUN_DAYS } from "../../lib/anomaly/baseline";
import type { WatchWords } from "../../lib/watch/words";
import {
  logWords,
  moduleWords,
  plainLogWords,
  plainRuleWords,
  ruleWords,
  signalNoun,
  sourceWords,
} from "../../lib/watch/words";

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
  /** A goal check's verdict (lib/care/progress), and the day judging starts while it is too soon. */
  verdict?: string;
  judged_from?: string;
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
  /** P6-07: email (the default), WhatsApp, or both. */
  channel?: "email" | "whatsapp" | "both";
  /** Warnings sent at once (2026-11-20): one email the day a warning appears. On unless switched off. */
  warnings?: boolean;
  whatsapp?: {
    /** The settings this server lacks, by name. Empty = WhatsApp can go. */
    missing: string[];
    opted_in: boolean;
    /** The last three digits only ("•••123"). */
    number: string | null;
    opted_in_at: string | null;
    /** The caller is the owner the summary goes to: only they can give a number. */
    yours: boolean;
  };
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

/** A signal's state said plainly: a drift says which way it went (2026-11-23). */
function statusKey(s: WatchSignal): "steady" | "interrupted" | "thin" | "up" | "down" | "unusual" {
  if (s.status !== "drifting") return s.status;
  return s.direction === "drop" ? "down" : s.direction === "spike" ? "up" : "unusual";
}

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
  if (signal.last_week === null) return "-";
  const last = perDay(signal, signal.last_week, locale);
  return signal.first_week === null
    ? last
    : `${perDay(signal, signal.first_week, locale)} → ${last}`;
}

/** One day's figure: a count is whole, so it is printed whole. */
function dayFigure(signal: WatchSignal, value: number, locale: AppLocale): string {
  return signal.currency === null && Number.isInteger(value)
    ? num(value, 0, locale)
    : perDay(signal, value, locale);
}

/** The signal's days since the watch began, the open anomaly's days tinted. */
function SignalSpark({ signal, label }: { signal: WatchSignal; label: string }) {
  const locale = useAppLocale();
  const days = signal.series ?? [];
  return (
    <Spark
      values={days.map((p) => p.value)}
      labels={days.map((p) => dayText(p.date, false, locale))}
      format={(v) => dayFigure(signal, v, locale)}
      label={label}
      span={anomalySpan(days, signal.since)}
      width={96}
    />
  );
}

/**
 * A signal opened in place (docs/DASHBOARD-OVERHAUL.md, L9): the days the
 * row's small line is drawn from, large enough to read, with the figures the
 * row states and each day's own reading. Nothing is worked out here that the
 * row does not already hold: the series is the one the watch read.
 */
function SignalSheet({
  signal,
  name,
  onClose,
}: {
  signal: WatchSignal | null;
  /** The signal as the table names it. */
  name: string;
  onClose: () => void;
}) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  // The sheet itself stays in the page and is only opened and closed: taken
  // away whole, it could not hand the cursor back to the row that opened it.
  return (
    <Sheet
      open={signal !== null}
      onClose={onClose}
      title={name}
      kicker={
        signal ? `${t("signals.col.from")} · ${sourceWords(signal.read_from, ww)}` : undefined
      }
      width={560}
    >
      {signal && <SignalDays signal={signal} name={name} />}
    </Sheet>
  );
}

function SignalDays({ signal, name }: { signal: WatchSignal; name: string }) {
  const t = useTranslations("watch");
  const locale = useAppLocale();
  const days = signal.series ?? [];
  const read = days.flatMap((p) => (p.value === null ? [] : [{ date: p.date, value: p.value }]));
  const latest = read.at(-1) ?? null;
  const high = read.reduce<(typeof read)[number] | null>(
    (best, p) => (best === null || p.value > best.value ? p : best),
    null,
  );
  const low = read.reduce<(typeof read)[number] | null>(
    (best, p) => (best === null || p.value < best.value ? p : best),
    null,
  );
  const figure = (p: { date: string; value: number } | null): string =>
    p === null ? "-" : `${dayFigure(signal, p.value, locale)} · ${dayText(p.date, false, locale)}`;
  return (
    <>
      <p className="wt-sig-status">
        <span className={`word ${STATUS_CLASS[signal.status]}`}>
          {t(`status.${statusKey(signal)}`)}
        </span>
        {signal.since && (
          <span>
            {t(signal.direction === "drop" ? "signals.below" : "signals.above", {
              date: dayText(signal.since, false, locale),
            })}
          </span>
        )}
      </p>
      <Trend
        points={days.map((p) => ({ label: dayText(p.date, false, locale), value: p.value }))}
        format={(v) => dayFigure(signal, v, locale)}
        label={`${name} · ${t("signals.col.daily")}`}
        columns={[t("signals.col.daily"), name]}
        step={signal.currency === null ? 1 : 10 ** minorUnitExponent(signal.currency)}
      />
      <dl className="wt-sig-figs">
        <div>
          <dt>{t("signals.col.perDay", { week: 1 })}</dt>
          <dd>{weeks(signal, locale)}</dd>
        </div>
        <div>
          <dt>{t("signals.latest")}</dt>
          <dd>{figure(latest)}</dd>
        </div>
        <div>
          <dt>{t("signals.high")}</dt>
          <dd>{figure(high)}</dd>
        </div>
        <div>
          <dt>{t("signals.low")}</dt>
          <dd>{figure(low)}</dd>
        </div>
        <div>
          <dt>{t("signals.col.days")}</dt>
          <dd>{num(signal.readings, 0, locale)}</dd>
        </div>
      </dl>
      {read.length > 0 && (
        <Fold summary={t("signals.col.daily")}>
          <table className="rt wt-sig-days">
            <tbody>
              {[...read].reverse().map((p) => (
                <tr key={p.date}>
                  <th scope="row">{dayText(p.date, true, locale)}</th>
                  <td className="num">{dayFigure(signal, p.value, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Fold>
      )}
    </>
  );
}

/**
 * The weeks as one bar (2026-11-23, said plainly): how many days are left,
 * when it started and ends, and what happens after.
 */
function DayStrip({ w }: { w: WatchDays }) {
  const t = useTranslations("watch");
  const locale = useAppLocale();
  const complete = w.days_remaining === 0;
  const span = { start: dayText(w.start, true, locale), end: dayText(w.end, true, locale) };
  return (
    <section className="wt-days" aria-label={t("days.label", { day: w.day, of: w.of })}>
      <p className="wt-days-head">
        <b>
          {complete
            ? t("days.allDone", { count: w.of })
            : t("days.left", { count: w.days_remaining })}
        </b>
        <span>{t(complete ? "days.spanDone" : "days.span", span)}</span>
      </p>
      <ol className="wt-strip" aria-hidden="true" style={{ ["--wt-of" as string]: w.of }}>
        {Array.from({ length: w.of }, (_, i) => i + 1).map((d) => (
          <li
            key={d}
            className={`wt-day${d < w.day || complete ? " past" : ""}${d === w.day && !complete ? " today" : ""}`}
          />
        ))}
      </ol>
      <p className="wt-after">
        {complete
          ? t("days.afterDone")
          : t.rich("days.after", {
              date: dayText(w.end, false, locale),
              b: (chunks) => <b>{chunks}</b>,
            })}
      </p>
    </section>
  );
}

/** What Lex reads every day: one card a signal, its figure now and which way it is going. */
function SignalsCard({ reading }: { reading: WatchReading }) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  const locale = useAppLocale();
  const { signals } = reading;
  // The signal opened in place, by its key: read again from the list, so the
  // sheet shows the latest reading when the watch is read again behind it.
  const [open, setOpen] = useState<string | null>(null);
  const opened = signals.find((x) => x.key === open) ?? null;
  /** A signal as the cards name it: with its currency when two share a noun. */
  const nameOf = (x: WatchSignal): string =>
    signalNoun(x.metric_key, x.noun, ww) +
    (x.currency && signals.filter((y) => y.noun === x.noun).length > 1 ? ` (${x.currency})` : "");
  const hasThin = signals.some((s) => s.status === "thin");
  const hasDrift = signals.some((s) => s.status === "drifting" || s.status === "interrupted");
  const foot =
    hasThin || hasDrift ? (
      <WhyFold>
        {hasThin && (
          <p>{t("signals.thinRule", { min: MIN_BASELINE_DAYS, of: THIN_WINDOW_DAYS })}</p>
        )}
        {hasDrift && <p>{t("signals.driftRule", { days: RUN_DAYS })}</p>}
      </WhyFold>
    ) : undefined;
  return (
    <SheetCard title={t("signals.label")} foot={foot}>
      {signals.length === 0 ? (
        <p className="wt-empty">
          {reading.connections === 0
            ? t.rich("signals.connect", {
                a: (chunks) => <Link href="/connections">{chunks}</Link>,
              })
            : t("signals.noDaily")}
        </p>
      ) : (
        <ul className="wt-sigs">
          {signals.map((s) => {
            const source = sourceWords(s.read_from, ww);
            const name = t("signals.name", { noun: nameOf(s) });
            return (
              <li
                key={s.key}
                className={`wt-sig ${STATUS_CLASS[s.status]}${open === s.key ? " on" : ""}`}
              >
                {/* The name is the card's control, and it covers the whole card. */}
                <button
                  type="button"
                  className="wt-pick"
                  aria-haspopup="dialog"
                  onClick={() => setOpen(s.key)}
                >
                  {name}
                </button>
                <p className="wt-sig-now">
                  {s.last_week === null ? "-" : perDay(s, s.last_week, locale)}
                </p>
                <p
                  className={`word ${STATUS_CLASS[s.status]}`}
                  title={
                    s.since
                      ? t(s.direction === "drop" ? "signals.below" : "signals.above", {
                          date: dayText(s.since, false, locale),
                        })
                      : undefined
                  }
                >
                  {t(`status.${statusKey(s)}`)}
                </p>
                <p className="wt-sig-was">
                  {s.first_week === null
                    ? t("signals.from", { source })
                    : t("signals.firstWeek", { value: perDay(s, s.first_week, locale), source })}
                </p>
                <div className="wt-spark">
                  <SignalSpark signal={s} label={`${name}: ${weeks(s, locale)}`} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SignalSheet
        signal={opened}
        name={opened ? nameOf(opened) : ""}
        onClose={() => setOpen(null)}
      />
    </SheetCard>
  );
}

/**
 * What Lex noticed and left alone. An anomaly line is said as what happened
 * (lib/watch/words plainLogWords); its working, as stored, one press away.
 */
function NotedCard({ log, w }: { log: LogEntry[]; w: WatchDays }) {
  const t = useTranslations("watch");
  const { tr: said } = useTr("watch");
  const ww = useWatchWords();
  const locale = useAppLocale();
  const noted = notedLines(log, w);
  const newest = noted[0];
  const fresh = newest ? Date.now() - parseInstant(newest.at) < 2 * DAY_MS : false;
  return (
    <SheetCard title={t("noted.title")}>
      <p className="wt-sub">{t("noted.sub")}</p>
      {noted.length === 0 ? (
        <p className="wt-empty">{t("noted.empty")}</p>
      ) : (
        <ul className="wt-notes">
          {noted.map((e, i) => {
            const plain = plainLogWords(e.detail, ww, (k, v) => said(`plain.${k}`, v));
            const line = plain ?? logWords(e.detail, ww);
            return (
              <li key={`${e.at}-${e.kind}`}>
                <span className="wt-at">{dayText(e.at, false, locale)}</span>
                <div>
                  <p>{i === 0 && fresh ? <span className="marked">{line}</span> : line}</p>
                  {plain !== null && (
                    <Fold summary={t("noted.how")}>
                      <p className="wt-work">{logWords(e.detail, ww)}</p>
                    </Fold>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SheetCard>
  );
}

/**
 * Each goal once, with its latest weekly check (2026-11-23): the log used to
 * carry every goal's line every week. Drawn only when a goal has been checked.
 */
function GoalsCard({ log }: { log: LogEntry[] }) {
  const t = useTranslations("watch");
  const { tr: goalTr } = useTr("goalsWords");
  const ww = useWatchWords();
  const locale = useAppLocale();
  const seen = new Set<string>();
  const goals = log.filter((e) => {
    if (e.kind !== "goal_progress" || !e.subject || seen.has(e.subject)) return false;
    seen.add(e.subject);
    return true;
  });
  if (goals.length === 0) return null;
  return (
    <SheetCard title={t("goals.title")}>
      <ul className="wt-goals">
        {goals.map((g) => (
          <li key={g.subject}>
            <Link href="/progress">{g.subject}</Link>
            <span>
              {g.verdict ? goalTr(`check.verdict.${g.verdict}`) : logWords(g.detail, ww)}
              {g.judged_from && (
                <> · {t("goals.from", { date: dayText(g.judged_from, false, locale) })}</>
              )}
            </span>
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

/** Everything Lex read and checked: folded, for anyone who wants it. */
function ActivityCard({ log }: { log: LogEntry[] }) {
  const t = useTranslations("watch");
  const ww = useWatchWords();
  const locale = useAppLocale();
  const work = log.filter((e) => !NOTED_KINDS.has(e.kind) && e.kind !== "goal_progress");
  const row = (e: LogEntry, i: number) => (
    <li key={`${e.at}-${e.kind}-${i}`}>
      <span className="wt-at">{dayText(e.at, false, locale)}</span>
      <p>
        {e.subject ? `${e.subject} · ` : ""}
        {logWords(e.detail, ww)}
      </p>
    </li>
  );
  return (
    <section className="wt-log">
      <Fold summary={t("activity.label")}>
        {work.length === 0 ? (
          <p className="wt-empty">{t("activity.empty")}</p>
        ) : (
          <>
            <ul className="wt-notes">{work.slice(0, 8).map(row)}</ul>
            {work.length > 8 && (
              <Fold summary={t("activity.more", { count: Math.min(work.length, 20) - 8 })}>
                <ul className="wt-notes">{work.slice(8, 20).map(row)}</ul>
              </Fold>
            )}
          </>
        )}
      </Fold>
    </section>
  );
}

/** What would end the watch early, said plainly; the rule as code still decides. */
function RulesCard({ thresholds }: { thresholds: WatchView["thresholds"] }) {
  const t = useTranslations("watch");
  const { tr: said } = useTr("watch");
  const ww = useWatchWords();
  return (
    <SheetCard
      title={t("rules.label")}
      foot={
        <p className="wt-how">
          {t.rich("rules.how", { a: (chunks) => <Link href="/mode">{chunks}</Link> })}
        </p>
      }
    >
      <ul className="wt-rules">
        {thresholds.map((r) => (
          <li key={r.text}>
            <span>
              {plainRuleWords(r.text, (k, v) => said(`plain.${k}`, v)) ?? ruleWords(r.text, ww)}
            </span>
            <span className={`word ${r.enforced ? "ok" : "low"}`}>
              {r.enforced ? t("rules.checked") : t("rules.notChecked")}
            </span>
          </li>
        ))}
      </ul>
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
    <SheetCard label={t("modules.label")}>
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
            {m.enabled && (
              <p className="wt-why">
                <Link href="/team">{t("modules.teamLink")}</Link>
              </p>
            )}
          </div>
        ))}
      <WhyFold className="wt-fold">
        <p>{moduleWords(modules.analytics.why, ww)}</p>
        {modules.modules
          .filter((m) => m.why)
          .map((m) => (
            <p key={m.module}>{moduleWords(m.why ?? "", ww)}</p>
          ))}
      </WhyFold>
    </SheetCard>
  );
}

function SummaryCard({
  summary,
  onToggle,
  onWarnings,
  onChanged,
}: {
  summary: SummaryView;
  onToggle: (enabled: boolean) => void;
  /** The email a warning sends the day it appears. */
  onWarnings: (enabled: boolean) => void;
  onChanged: () => void;
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
  const warningsNote = !summary.owner
    ? t("signUp")
    : summary.warnings === false
      ? t("warningsOff")
      : !summary.configured
        ? t("noEmail")
        : t("warningsWhy");
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
      <p className="wt-why">{status}</p>
      {/* Warnings sent at once: a warning that looks ahead is worth one email the day it appears. */}
      <label className="wt-module">
        <input
          type="checkbox"
          checked={summary.owner && summary.warnings !== false}
          disabled={!summary.owner}
          onChange={(e) => onWarnings(e.target.checked)}
        />
        <span>{t("warningsSwitch")}</span>
      </label>
      {/* The same sentence twice reads as a slip: said once, it covers both switches. */}
      {warningsNote !== status && <p className="wt-why">{warningsNote}</p>}
      {summary.owner && summary.whatsapp && (
        <WhatsAppSettings summary={summary} onChanged={onChanged} />
      )}
    </SheetCard>
  );
}

const CHANNELS = ["email", "whatsapp", "both"] as const;

/**
 * P6-07: the channel, beside the switch, and the WhatsApp yes (rule 19):
 * the number, and the exact sentence agreed to — sent back as shown, so the
 * server records the words the owner read. Withdrawing is one click.
 */
function WhatsAppSettings({ summary, onChanged }: { summary: SummaryView; onChanged: () => void }) {
  const t = useTranslations("watch.summary");
  const locale = useAppLocale();
  const wa = summary.whatsapp!;
  const channel = summary.channel ?? "email";
  const [number, setNumber] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consent = t("whatsapp.consent");

  const call = async (init: RequestInit, url = "/api/summary/whatsapp") => {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setProblem(
          body.error === "invalid_number"
            ? t("whatsapp.invalid")
            : body.error === "consent_mismatch"
              ? t("whatsapp.changed")
              : t("whatsapp.failed"),
        );
        return;
      }
      setNumber("");
      setAgreed(false);
      onChanged();
    } catch {
      setProblem(t("whatsapp.failed"));
    } finally {
      setBusy(false);
    }
  };

  const setChannel = (c: (typeof CHANNELS)[number]) =>
    void call(
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: c }),
      },
      "/api/summary",
    );

  return (
    <div className="wt-whatsapp">
      <fieldset className="wt-modules">
        <legend>{t("channel.legend")}</legend>
        {CHANNELS.map((c) => (
          <label key={c} className="wt-module">
            <input
              type="radio"
              name="summary-channel"
              checked={channel === c}
              disabled={busy}
              onChange={() => setChannel(c)}
            />
            <span>{t(`channel.${c}`)}</span>
          </label>
        ))}
      </fieldset>
      {channel !== "email" && wa.missing.length > 0 && (
        <p className="wt-why">{t("whatsapp.notSetUp", { keys: wa.missing.join(", ") })}</p>
      )}
      {wa.opted_in ? (
        <>
          <p className="wt-why">
            {t("whatsapp.on", {
              number: wa.number ?? "",
              date: wa.opted_in_at ? dayText(wa.opted_in_at, false, locale) : "",
            })}
          </p>
          {wa.yours && (
            <p className="wt-actions">
              <button type="button" disabled={busy} onClick={() => void call({ method: "DELETE" })}>
                {t("whatsapp.withdraw")}
              </button>{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void call({ method: "DELETE" }, "/api/summary/whatsapp?erase=1")}
              >
                {t("whatsapp.forget")}
              </button>
            </p>
          )}
        </>
      ) : (
        <>
          <p className="wt-why">
            {channel === "email" ? t("whatsapp.none") : t("whatsapp.needsYes")}
          </p>
          {wa.yours ? (
            <form
              className="wt-whatsapp-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!agreed) return;
                void call({
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ number, locale, consent }),
                });
              }}
            >
              <label>
                <span>{t("whatsapp.numberLabel")}</span>
                <input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                />
              </label>
              <p className="wt-why">{t("whatsapp.numberHint")}</p>
              <label className="wt-module">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span>{consent}</span>
              </label>
              <button type="submit" disabled={busy || !agreed || number.trim() === ""}>
                {t("whatsapp.agree")}
              </button>
            </form>
          ) : (
            <p className="wt-why">{t("whatsapp.notYours")}</p>
          )}
        </>
      )}
      {problem && (
        <p className="wt-why" role="alert">
          {problem}
        </p>
      )}
    </div>
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

/**
 * The settings that used to sit at the foot of Watching (2026-11-15):
 * which modules SYB works in, the weekly summary and phone alerts. Same
 * cards, same APIs, now on /settings/alerts under Your business.
 */
export function WatchSettingsScreen() {
  const t = useTranslations("watch");
  const a = useTranslations("alerts");
  const [modules, setModules] = useState<ModulesView | null>(null);
  const [summary, setSummary] = useState<SummaryView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await fetch("/api/modules");
      if (!m.ok) return setFailed(true);
      setModules((await m.json()) as ModulesView);
    } catch {
      setFailed(true);
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

  const toggleWarnings = async (warnings: boolean) => {
    await fetch("/api/summary", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warnings }),
    });
    await load();
  };

  return (
    <main className="screen wt-screen">
      <PageHead kicker={a("kicker")} title={a("title")} />
      {failed ? (
        <p className="wt-wait">{t("failed.lede")}</p>
      ) : !modules ? (
        <p className="wt-wait">{t("reading")}</p>
      ) : (
        <div className="wt-settings">
          <ModulesCard modules={modules} onToggle={(m, on) => void toggle(m, on)} />
          {summary && (
            <SummaryCard
              summary={summary}
              onToggle={(on) => void toggleSummary(on)}
              onWarnings={(on) => void toggleWarnings(on)}
              onChanged={() => void load()}
            />
          )}
          <PhoneAlertsCard />
        </div>
      )}
    </main>
  );
}

export function WatchScreen({ reading }: { reading: WatchReading | null }) {
  const t = useTranslations("watch");
  const [view, setView] = useState<WatchView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  const load = useCallback(async () => {
    try {
      const w = await fetch("/api/watch");
      if (w.status === 401) return setFailed("signed_out");
      if (!w.ok) return setFailed("error");
      setView((await w.json()) as WatchView);
    } catch {
      setFailed("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
  if (!view) {
    return <Frame title={t("reading")} />;
  }

  const w = watchDays(view.decision, new Date());
  const moved = (
    <p className="wt-moved">
      {t("moved")} <Link href="/settings/alerts">{t("movedLink")}</Link>
    </p>
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
        <div className="wt-body">
          <div className="wt-grid">
            <div className="wt-side">
              <NoticedCard log={view.log} />
              <GoalsCard log={view.log} />
            </div>
            <div className="wt-side">
              <RulesCard thresholds={view.thresholds} />
            </div>
          </div>
          <ActivityCard log={view.log} />
          {moved}
        </div>
      </Frame>
    );
  }

  const ran = reading?.executions_since_start ?? 0;
  const complete = w.days_remaining === 0;
  const conns = reading?.connections ?? 0;

  return (
    <Frame
      title={complete ? t("title.learned") : t("title.learning", { day: w.day, of: w.of })}
      notes={
        <>
          <p className="wt-lede">{t("lede")}</p>
          {conns === 0 && (
            <p className="wt-live">
              <span className="wt-sq" aria-hidden="true" />
              <span>
                {t.rich("notes.none", {
                  a: (chunks) => <Link href="/connections">{chunks}</Link>,
                })}
              </span>
            </p>
          )}
          {ran > 0 && (
            <p className="wt-live">
              <span className="wt-sq" aria-hidden="true" />
              <span>{t("notes.changes", { count: ran })}</span>
            </p>
          )}
        </>
      }
    >
      <div className="wt-body">
        <DayStrip w={w} />
        {reading ? (
          <SignalsCard reading={reading} />
        ) : (
          <SheetCard title={t("signals.label")}>
            <p className="wt-empty">{t("signals.nothing")}</p>
          </SheetCard>
        )}
        <div className="wt-grid">
          <div className="wt-side">
            <NotedCard log={view.log} w={w} />
          </div>
          <div className="wt-side">
            <GoalsCard log={view.log} />
            <RulesCard thresholds={view.thresholds} />
          </div>
        </div>
        <ActivityCard log={view.log} />
        {moved}
      </div>
    </Frame>
  );
}
