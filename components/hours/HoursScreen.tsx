"use client";

// Insights · Trading hours — the owner's Trading hours design (2026-10-17)
// on Phase 2 Session F (P2-26..30) and the trials of P3-41. The week as a
// grid: every open hour's mean takings, less what an open hour costs when
// the owner has said (lib/hours/grid). Beside it, the signals the
// analysis fired, in words. The honest limit stays on the screen: a
// closed hour records no sales, so this suggests and a trial proves — folded
// with the window, the cost and the arithmetic under "How this works"
// (decluttered 2026-11-09 on the owner's instruction).
// Read-only — a trial is a proposal in "Waiting for you".
//
// L-3b: the screen's own words are the "hours" catalogue; weekday names,
// dates and figures in the reader's locale, money in the business's
// currency. What lib/hours words (the reasons, the coverage and the limit,
// a trial's summary and verdict) stays English until L-4.

import "../../app/hours.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { delta, moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { minorUnitExponent } from "../../lib/core/money";
import { dayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import type { Weekday } from "../../lib/hours/schedule";
import type { WeekdayAnalysis } from "../../lib/hours/trading";
import type { GridRow, WeekGrid } from "../../lib/hours/grid";
import { EVEN_SHARE, bestHour, hourHead, weekGrid } from "../../lib/hours/grid";
import { hoursLineWords } from "../../lib/hours/words";

interface Trial {
  id: string;
  summary: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  verdict: { verdict: string; arithmetic: string } | null;
}
interface HoursView {
  trials: Trial[];
  schedule: {
    days: Record<Weekday, { open: string; close: string }[]>;
    unstated: Weekday[];
    unparsed: string[];
  } | null;
  schedule_note: string | null;
  timezone: { zone: string | null; reason?: string };
  analysis:
    | { status: "unmeasured" | "too_early"; reason: string }
    | {
        status: "ok";
        zone: string;
        currency: string;
        from: string;
        to: string;
        weekdays: WeekdayAnalysis[];
        coverage: string;
        limit: string;
      };
}

/** The owner's stated cost of one open hour, read on the server (./page). */
export interface HourCost {
  amount_minor: number;
  currency: string;
}

/** The screen's words and the reader's locale: the "hours" catalogue. */
export interface HoursWords {
  tr: Tr;
  locale: AppLocale;
}
const ENGLISH = (): HoursWords => ({ tr: englishTr("hours"), locale: "en" });

const SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "Mon" — in another language, Intl's short weekday (1 Jan 2024 was a Monday). */
function shortDay(d: Weekday, locale: AppLocale): string {
  if (locale === "en") return SHORT[d];
  const day = new Date(Date.UTC(2024, 0, 1 + ORDER.indexOf(d)));
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: "short", timeZone: "UTC" }).format(
    day,
  );
}

/** "Fridays", "Fridays and Saturdays", "Tuesdays to Saturdays" (three or more in a row). */
export function daysText(days: readonly Weekday[], w: HoursWords = ENGLISH()): string {
  const { tr, locale } = w;
  const idx = days.map((d) => ORDER.indexOf(d)).sort((a, b) => a - b);
  const consecutive = idx.every((v, i) => i === 0 || v === (idx[i - 1] ?? -2) + 1);
  const names = idx.map((i) => tr(`weekdays.${ORDER[i] as Weekday}`));
  if (names.length >= 3 && consecutive) {
    return tr("daysRange", { from: names[0] ?? "", to: names.at(-1) ?? "" });
  }
  if (names.length <= 1) return names.join("");
  if (locale !== "en") {
    return new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(names);
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree; in another language, its own. */
function dayText(iso: string, locale: AppLocale): string {
  if (locale !== "en") return dayMonth(iso, locale);
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A cell's figure in whole currency units, signed when it is a net. */
function cellFig(minor: number, currency: string, signed: boolean, locale: AppLocale): string {
  const major = Math.round(minor / 10 ** minorUnitExponent(currency));
  if (signed) return delta(major, 0, locale);
  return locale === "en" ? String(major) : num(major, 0, locale);
}

/** The currency's sign for a column head: "€" for euros, the code otherwise; Intl's elsewhere. */
function unitOf(currency: string, locale: AppLocale): string {
  if (locale === "en") return currency === "EUR" ? "€" : currency;
  const part = new Intl.NumberFormat(intlTag(locale), {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  })
    .formatToParts(0)
    .find((p) => p.type === "currency");
  return part?.value ?? currency;
}

interface Reading {
  key: string;
  head: string;
  /** The weekdays in words, for the card's title. */
  days: string;
  word: string;
  cls: string;
  sub: string;
}

function readingsOf(
  weekdays: readonly WeekdayAnalysis[],
  grid: WeekGrid,
  currency: string,
  cost: number | null,
  w: HoursWords,
): Reading[] {
  const { tr, locale } = w;
  const ok = weekdays.filter((wd) => wd.verdict === "ok");
  const fired = (pick: (wd: WeekdayAnalysis) => boolean) =>
    ORDER.filter((d) => ok.some((wd) => wd.weekday === d && pick(wd)));
  const out: Reading[] = [];
  const closing = fired((wd) => wd.closing_signal === true);
  if (closing.length > 0) {
    const days = daysText(closing, w);
    out.push({
      key: "closing",
      head: tr("read.closing.head", { days }),
      days,
      word: tr("read.closing.word"),
      cls: "alarm",
      sub:
        cost !== null
          ? tr("read.closing.subCost", { cost: moneyText(cost, currency, locale) })
          : tr("read.closing.sub"),
    });
  }
  const opening = fired((wd) => wd.opening_signal);
  if (opening.length > 0) {
    const days = daysText(opening, w);
    out.push({
      key: "opening",
      head: tr("read.opening.head", { days }),
      days,
      word: tr("read.opening.word"),
      cls: "drift",
      sub: tr("read.opening.sub"),
    });
  }
  const attention = fired((wd) => wd.attention_signal === true);
  if (attention.length > 0) {
    const days = daysText(attention, w);
    out.push({
      key: "attention",
      head: tr("read.attention.head", { days }),
      days,
      word: tr("read.attention.word"),
      cls: "low",
      sub: tr("read.attention.sub"),
    });
  }
  const best = bestHour(grid);
  if (best) {
    const days = daysText(best.weekdays, w);
    out.push({
      key: "best",
      head: tr("read.best.head", { days, clock: `${hourHead(best.hour)}:00` }),
      days,
      word: tr("read.best.word"),
      cls: "ok",
      sub: tr("read.best.sub", { money: moneyText(best.net_minor, currency, locale) }),
    });
  }
  const early = ORDER.filter((d) =>
    weekdays.some((wd) => wd.weekday === d && wd.verdict === "too_early"),
  );
  if (early.length > 0) {
    const days = daysText(early, w);
    out.push({
      key: "early",
      head: days,
      days,
      word: tr("read.early.word"),
      cls: "low",
      sub: tr("read.early.sub"),
    });
  }
  return out;
}

function readingTitle(readings: readonly Reading[], tr: Tr): string {
  const first = readings.find((r) => r.key !== "best" && r.key !== "early");
  if (!first) return tr("title.none");
  if (first.key === "closing") return tr("title.closing", { days: first.days });
  if (first.key === "opening") return tr("title.opening", { days: first.days });
  return tr("title.attention", { days: first.days });
}

function Row({
  row,
  currency,
  judged,
  maxNet,
}: {
  row: GridRow;
  currency: string;
  judged: boolean;
  maxNet: number;
}) {
  const { tr, locale } = useTr("hours");
  const note =
    row.verdict === "hours_unknown" || row.verdict === "missing"
      ? tr("row.notStated")
      : row.verdict === "too_early"
        ? tr("row.days", { count: row.days_measured })
        : row.verdict === "closed"
          ? tr("row.closed")
          : null;
  return (
    <tr className={row.verdict === "too_early" ? "early" : undefined}>
      <th scope="row">
        {shortDay(row.weekday, locale)}
        {note && <span className="hr-rownote">{note}</span>}
      </th>
      {row.cells.map((c) => {
        if (row.verdict === "hours_unknown" || row.verdict === "missing") {
          return <td key={c.hour} className="unknown" aria-label={tr("row.notStated")} />;
        }
        if (!c.open) {
          return (
            <td key={c.hour} className="closed" aria-label={tr("row.closed")}>
              {c.takings_minor ? cellFig(c.takings_minor, currency, false, locale) : ""}
            </td>
          );
        }
        if (judged && c.net_minor !== null && c.band) {
          // A paying hour deepens with what it nets; the figure carries the meaning.
          const k = c.band === "pays" ? 45 + Math.round((55 * c.net_minor) / maxNet) : null;
          return (
            <td
              key={c.hour}
              className={c.band}
              style={k === null ? undefined : { ["--hr-k" as string]: `${k}%` }}
            >
              {cellFig(c.net_minor, currency, true, locale)}
            </td>
          );
        }
        return (
          <td key={c.hour} className="open">
            {c.takings_minor === null ? "" : cellFig(c.takings_minor, currency, false, locale)}
          </td>
        );
      })}
    </tr>
  );
}

/** Shown only when the zone can't be derived — a country with several, or none given. */
function ZonePicker({ onSaved }: { onSaved: () => void }) {
  const { tr } = useTr("hours");
  const zones =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const [zone, setZone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    const res = await fetch("/api/hours", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: zone }),
    });
    if (!res.ok)
      return setError(((await res.json()) as { error?: string }).error ?? tr("zone.failed"));
    onSaved();
  };
  return (
    <form
      className="hr-zone"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label htmlFor="hr-zone">{tr("zone.label")}</label>
      <select id="hr-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
        <option value="">{tr("zone.choose")}</option>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <button className="act" disabled={zone === ""}>
        {tr("zone.save")}
      </button>
      {error && <p className="hr-copy">{error}</p>}
    </form>
  );
}

function TrialsCard({ trials }: { trials: Trial[] }) {
  const { tr } = useTr("hours");
  return (
    <section className="hr-inset" aria-labelledby="hr-trials-head">
      <h2 id="hr-trials-head">{trials.length > 0 ? tr("trials.title") : tr("trials.none")}</h2>
      {trials.length > 0 && (
        <ul className="hr-trials">
          {trials.map((t) => (
            <li key={t.id}>
              <span>
                {t.summary}
                {t.verdict && (
                  <span className="hr-trial-sub">
                    {t.verdict.verdict.replace("_", " ")}: {t.verdict.arithmetic}
                  </span>
                )}
              </span>
              <span className="word boxed low">{t.status}</span>
            </li>
          ))}
        </ul>
      )}
      <Link className="act" href="/proposals">
        {tr("trials.waiting")}
      </Link>
    </section>
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
  const { tr } = useTr("hours");
  return (
    <main className="screen hr-screen">
      <PageHead kicker={tr("kicker")} title={title}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

export function HoursScreen({ cost }: { cost: HourCost | null }) {
  const { tr, locale } = useTr("hours");
  const hw = useTr("hoursWords").tr;
  const t = useTranslations("hours");
  const words: HoursWords = { tr, locale };
  const [view, setView] = useState<HoursView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/hours");
        if (res.status === 401) return setFailed("signed_out");
        if (!res.ok) return setFailed("error");
        setView((await res.json()) as HoursView);
      } catch {
        setFailed("error");
      }
    })();
  }, []);

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut.title")}>
        <p className="hr-wait">
          {t.rich("signedOut.body", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("error.title")}>
        <p className="hr-wait">{tr("error.body")}</p>
      </Frame>
    );
  }
  if (!view) {
    return <Frame title={tr("loading")} />;
  }

  const a = view.analysis;
  if (a.status !== "ok") {
    return (
      <Frame
        title={view.schedule ? tr("notOk.notEnough") : tr("notOk.unknown")}
        notes={<p>{view.schedule_note ?? tr("notOk.notYet", { reason: a.reason })}</p>}
      >
        <div className="hr-grid">
          <SheetCard title={tr("needs.title")}>
            <p className="hr-copy">
              {/* The reason is in the head unless the schedule's own note took its place. */}
              {tr("needs.body")}{" "}
              {view.schedule_note && `${a.reason.charAt(0).toUpperCase() + a.reason.slice(1)}. `}
              <Link href="/connections">{tr("connections")}</Link>
            </p>
            {view.timezone.zone === null && <ZonePicker onSaved={() => location.reload()} />}
          </SheetCard>
          <div className="hr-side">
            <TrialsCard trials={view.trials} />
          </div>
        </div>
      </Frame>
    );
  }

  const hourCost = cost && cost.currency === a.currency ? cost.amount_minor : null;
  const grid = weekGrid({ schedule: view.schedule, weekdays: a.weekdays, hourCostMinor: hourCost });
  const judged = hourCost !== null;
  const readings = readingsOf(a.weekdays, grid, a.currency, hourCost, words);
  const weeks = Math.round((Date.parse(a.to) - Date.parse(a.from)) / (7 * 86_400_000));

  const title = !judged
    ? tr("week.titleAll", { count: grid.open_hours })
    : grid.losing_hours === 0
      ? tr("week.titlePay", { count: grid.open_hours })
      : tr("week.titleLose", { losing: grid.losing_hours, count: grid.open_hours });
  const unit = unitOf(a.currency, locale);
  const maxNet = Math.max(
    1,
    ...grid.rows.flatMap((r) => r.cells.map((c) => (c.open ? (c.net_minor ?? 0) : 0))),
  );
  const evenText =
    grid.even_within_minor !== null ? moneyText(grid.even_within_minor, a.currency, locale) : null;
  const evenPct = Math.round(EVEN_SHARE * 100 * 10) / 10;
  const evenPctText =
    locale === "en"
      ? String(evenPct)
      : new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 1 }).format(evenPct);
  const period = tr("week.period", {
    weeks,
    from: dayText(a.from, locale),
    to: dayText(a.to, locale),
    zone: a.zone.replace(/_/g, " "),
  });
  const costPart =
    hourCost !== null
      ? tr("week.costStated", { cost: moneyText(hourCost, a.currency, locale) })
      : tr("week.costNone");

  return (
    <Frame title={title}>
      <div className="hr-grid">
        <SheetCard
          label={judged ? tr("week.labelNet", { unit }) : tr("week.labelTakings", { unit })}
          meta={
            judged && evenText ? (
              <ul className="hr-legend" aria-label={tr("legend.label")}>
                <li>
                  <span className="hr-sw loses" aria-hidden="true" />
                  {tr("legend.loses", { even: evenText })}
                </li>
                <li>
                  <span className="hr-sw even" aria-hidden="true" />
                  {tr("legend.even")}
                </li>
                <li>
                  <span className="hr-sw pays" aria-hidden="true" />
                  {tr("legend.pays")}
                </li>
              </ul>
            ) : undefined
          }
          foot={
            <>
              {t.rich("foot.wrong", { link: (c) => <Link href="/profile">{c}</Link> })}
              <Fold summary={tr("how")}>
                <p>{`${period} · ${costPart}`}</p>
                <p>
                  {judged
                    ? tr("foot.meanJudged", {
                        coverage: hoursLineWords(a.coverage, hw, locale),
                        pct: evenPctText,
                      })
                    : tr("foot.mean", { coverage: hoursLineWords(a.coverage, hw, locale) })}{" "}
                  {tr("foot.legend")} {hoursLineWords(a.limit, hw, locale)}
                  {view.schedule && view.schedule.unparsed.length > 0 && (
                    <>
                      {" "}
                      {tr("foot.unparsed", {
                        list: view.schedule.unparsed.map((u) => `"${u}"`).join(", "),
                      })}
                    </>
                  )}
                </p>
              </Fold>
            </>
          }
        >
          {grid.hours.length === 0 ? (
            <p className="hr-copy">{tr("week.empty")}</p>
          ) : (
            <div className="hr-wrap" tabIndex={0} aria-label={tr("week.title")}>
              <table className="hr-week" style={{ minWidth: 60 + grid.hours.length * 38 }}>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">{tr("week.day")}</span>
                    </th>
                    {grid.hours.map((h) => (
                      <th key={h} scope="col">
                        {hourHead(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row) => (
                    <Row
                      key={row.weekday}
                      row={row}
                      currency={a.currency}
                      judged={judged}
                      maxNet={maxNet}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SheetCard>
        <div className="hr-side">
          <SheetCard title={readingTitle(readings, tr)}>
            {readings.length === 0 ? (
              <p className="hr-copy">{tr("read.none")}</p>
            ) : (
              <ul className="hr-reads">
                {readings.map((r) => (
                  <li key={r.key}>
                    <div className="hr-read-head">
                      <span>{r.head}</span>
                      <span className={`word ${r.cls}`}>{r.word}</span>
                    </div>
                    <p className="hr-read-sub">{r.sub}</p>
                  </li>
                ))}
              </ul>
            )}
          </SheetCard>
          <TrialsCard trials={view.trials} />
        </div>
      </div>
    </Frame>
  );
}
