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
// Said plainly on 2026-11-28 (the canvas design the owner approved): the
// grid holds only the open hours, each "+€72" after what an open hour
// costs (a closed hour's bare takings sat in the same grid and read as the
// same thing); the title counts the hours that pay and the line under it
// names the one that doesn't; "What Lex noticed" says each signal in plain
// words, with what came in while closed; the method folds under "How Lex
// worked this out". The analysis and its rules are unchanged.
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
import { moneyText } from "../sheet/num";
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
import { firstHourShares, losingHours, openOnly, takenWhileClosed } from "./hours-view";
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

const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

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

type OkAnalysis = Extract<HoursView["analysis"], { status: "ok" }>;

/** "Thursday" — the weekday on its own, in the reader's language (1 Jan 2024 was a Monday). */
function dayLong(d: Weekday, locale: AppLocale): string {
  const day = new Date(Date.UTC(2024, 0, 1 + ORDER.indexOf(d)));
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: "long", timeZone: "UTC" }).format(day);
}

/** Money in whole units, in the business's currency. */
function whole(minor: number, currency: string, locale: AppLocale): string {
  const unit = 10 ** minorUnitExponent(currency);
  return moneyText(Math.round(minor / unit) * unit, currency, locale);
}

/** "+€72", "−€9": an open hour's net, signed, in whole units. */
function signedMoney(minor: number, currency: string, locale: AppLocale): string {
  const unit = 10 ** minorUnitExponent(currency);
  const v = Math.round(minor / unit) * unit;
  const s = moneyText(Math.abs(v), currency, locale);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

const pctOf = (share: number, locale: AppLocale) =>
  new Intl.NumberFormat(intlTag(locale), { style: "percent", maximumFractionDigits: 0 }).format(
    share,
  );

interface Note {
  key: string;
  tone: "alarm" | "warn" | "good" | "plain";
  head: string;
  body: string;
  next?: string;
}

/** What Lex noticed, in plain words: the signals the analysis fired, the best hour, what came in while closed. */
function notesOf(
  a: OkAnalysis,
  grid: WeekGrid,
  cost: number | null,
  weeks: number,
  w: HoursWords,
): Note[] {
  const { tr, locale } = w;
  const ok = a.weekdays.filter((wd) => wd.verdict === "ok");
  const fired = (pick: (wd: WeekdayAnalysis) => boolean) =>
    ORDER.filter((d) => ok.some((wd) => wd.weekday === d && pick(wd)));
  const out: Note[] = [];
  const closing = fired((wd) => wd.closing_signal === true);
  if (closing.length > 0) {
    out.push({
      key: "closing",
      tone: "alarm",
      head: tr("note.closing.head", { days: daysText(closing, w) }),
      body:
        cost !== null
          ? tr("note.closing.bodyCost", { cost: whole(cost, a.currency, locale) })
          : tr("note.closing.body"),
      next: tr("note.trialLater"),
    });
  }
  const first = firstHourShares(a.weekdays);
  if (first) {
    const days = daysText(first.days, w);
    out.push({
      key: "opening",
      tone: "warn",
      head: tr("note.opening.head"),
      body:
        Math.round(first.low * 100) === Math.round(first.high * 100)
          ? tr("note.opening.bodyOne", { days, share: pctOf(first.low, locale) })
          : tr("note.opening.body", {
              days,
              low: pctOf(first.low, locale),
              high: pctOf(first.high, locale),
            }),
      next: tr("note.trialEarlier"),
    });
  }
  const attention = fired((wd) => wd.attention_signal === true);
  if (attention.length > 0) {
    out.push({
      key: "attention",
      tone: "plain",
      head: tr("note.attention.head"),
      body: tr("note.attention.body", { days: daysText(attention, w) }),
    });
  }
  const best = bestHour(grid);
  if (best) {
    out.push({
      key: "best",
      tone: "good",
      head: tr("note.best.head", {
        days: daysText(best.weekdays, w),
        clock: `${hourHead(best.hour)}:00`,
      }),
      body: tr("note.best.body", { money: whole(best.net_minor, a.currency, locale) }),
    });
  }
  const early = ORDER.filter((d) =>
    a.weekdays.some((wd) => wd.weekday === d && wd.verdict === "too_early"),
  );
  if (early.length > 0) {
    out.push({
      key: "early",
      tone: "plain",
      head: tr("note.early.head", { days: daysText(early, w) }),
      body: tr("note.early.body"),
    });
  }
  const closed = takenWhileClosed(a.weekdays);
  if (closed.total_minor > 0) {
    const amount = whole(closed.total_minor, a.currency, locale);
    out.push({
      key: "closed",
      tone: "plain",
      head: tr("note.closed.head"),
      body: closed.perDay
        ? tr("note.closed.bodyDay", {
            amount,
            weeks,
            perDay: whole(closed.perDay.minor, a.currency, locale),
            days: daysText([closed.perDay.weekday], w),
          })
        : tr("note.closed.body", { amount, weeks }),
      next: tr("note.closed.next"),
    });
  }
  return out;
}

function PlainRow({
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
  return (
    <tr className={row.verdict === "too_early" ? "early" : undefined}>
      <th scope="row">
        {dayLong(row.weekday, locale)}
        {row.verdict === "too_early" && (
          <span className="hr-rownote">{tr("row.days", { count: row.days_measured })}</span>
        )}
      </th>
      {row.verdict === "hours_unknown" ? (
        <td colSpan={row.cells.length} className="hr-unstated">
          {tr("row.notStated")}
        </td>
      ) : (
        row.cells.map((c) => {
          if (!c.open) {
            return (
              <td key={c.hour} className="closed">
                <span className="sr-only">{tr("row.closed")}</span>
              </td>
            );
          }
          if (judged && c.net_minor !== null && c.band) {
            // A paying hour deepens with what it nets; the figure carries the meaning.
            const k = c.band === "pays" ? 25 + Math.round((75 * c.net_minor) / maxNet) : null; // not money: a colour depth in percent
            return (
              <td
                key={c.hour}
                className={`${c.band}${k !== null && k >= 70 ? " deep" : ""}`}
                style={k === null ? undefined : { ["--hr-k" as string]: `${k}%` }}
              >
                {signedMoney(c.net_minor, currency, locale)}
              </td>
            );
          }
          return (
            <td key={c.hour} className="open">
              {c.takings_minor === null ? "" : whole(c.takings_minor, currency, locale)}
            </td>
          );
        })
      )}
    </tr>
  );
}

function Trials({ trials }: { trials: Trial[] }) {
  const { tr } = useTr("hours");
  if (trials.length === 0) {
    return (
      <div className="hr-trial-row">
        <p>{tr("trials.noneRunning")}</p>
        <Link className="act" href="/proposals">
          {tr("trials.open")}
        </Link>
      </div>
    );
  }
  return (
    <div className="hr-trial-list">
      <h3 className="hr-h3">{tr("trials.title")}</h3>
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
      <Link className="act" href="/proposals">
        {tr("trials.open")}
      </Link>
    </div>
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
          {t.rich("signedOut.body", { link: (c) => <Link href="/start">{c}</Link> })}
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
  const weeks = Math.round((Date.parse(a.to) - Date.parse(a.from)) / (7 * 86_400_000));
  const plain = openOnly(grid);
  const losing = judged ? losingHours(grid) : [];
  const first = firstHourShares(a.weekdays);
  const notes = notesOf(a, grid, hourCost, weeks, words);

  const title = !judged
    ? tr("week.titleAll", { count: grid.open_hours })
    : grid.losing_hours === 0
      ? tr("plain.titleAll", { count: grid.open_hours })
      : tr("plain.titleSome", {
          paying: grid.open_hours - grid.losing_hours,
          count: grid.open_hours,
        });
  const lede: string[] = [];
  const worst = losing[0];
  if (worst && hourCost !== null) {
    const parts = {
      day: dayLong(worst.weekday, locale),
      clock: `${hourHead(worst.hour)}:00`,
      short: whole(worst.short_minor, a.currency, locale),
      cost: whole(hourCost, a.currency, locale),
    };
    lede.push(
      losing.length === 1
        ? tr("plain.ledeOne", parts)
        : tr("plain.ledeSome", { ...parts, count: losing.length }),
    );
  }
  if (first) {
    lede.push(
      tr(lede.length > 0 ? "plain.ledeEarlyAlso" : "plain.ledeEarly", {
        days: daysText(first.days, words),
      }),
    );
  }
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
  const span = { weeks, from: dayText(a.from, locale), to: dayText(a.to, locale) };

  return (
    <Frame
      title={title}
      notes={lede.length > 0 ? <p className="hr-lede">{lede.join(" ")}</p> : undefined}
    >
      <SheetCard className="hr-card" title={tr("plain.gridTitle")}>
        <p className="hr-src">
          {judged
            ? tr("plain.srcJudged", { ...span, cost: whole(hourCost, a.currency, locale) })
            : tr("plain.src", span)}
        </p>
        {plain.hours.length === 0 ? (
          <p className="hr-copy">{tr("week.empty")}</p>
        ) : (
          <div className="hr-wrap" tabIndex={0} aria-label={tr("plain.gridTitle")}>
            <table className="hr-plain">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{tr("week.day")}</span>
                  </th>
                  {plain.hours.map((h) => (
                    <th key={h} scope="col">
                      {`${hourHead(h)}:00`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plain.rows.map((row) => (
                  <PlainRow
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
        {judged && evenText && (
          <ul className="hr-key" aria-label={tr("legend.label")}>
            <li>
              <span className="hr-sw pays" aria-hidden="true" />
              {tr("plain.keyPays")}
            </li>
            <li>
              <span className="hr-sw even" aria-hidden="true" />
              {tr("plain.keyEven", { even: evenText })}
            </li>
            <li>
              <span className="hr-sw loses" aria-hidden="true" />
              {tr("plain.keyLoses")}
            </li>
            <li>
              <span className="hr-sw closed" aria-hidden="true" />
              {tr("plain.keyClosed")}
            </li>
          </ul>
        )}
        <p className="hr-note">
          {plain.closedDays.length > 0 && (
            <>{tr("plain.closed", { days: daysText(plain.closedDays, words) })} </>
          )}
          {t.rich("foot.wrong", { link: (c) => <Link href="/profile">{c}</Link> })}
        </p>
      </SheetCard>

      <SheetCard className="hr-card" title={tr("plain.notesTitle")}>
        {notes.length === 0 ? (
          <p className="hr-copy">{tr("read.none")}</p>
        ) : (
          <div className="hr-notes">
            {notes.map((n) => (
              <div key={n.key} className={`hr-n hr-n-${n.tone}`}>
                <p className="hr-n-head">{n.head}</p>
                <p>{n.body}</p>
                {n.next && <p className="hr-muted">{n.next}</p>}
              </div>
            ))}
          </div>
        )}
        <Trials trials={view.trials} />
      </SheetCard>

      <Fold className="hr-how" summary={tr("plain.how")}>
        <ul className="hr-list">
          <li>{`${period} · ${costPart}`}</li>
          <li>
            {judged
              ? tr("foot.meanJudged", {
                  coverage: hoursLineWords(a.coverage, hw, locale),
                  pct: evenPctText,
                })
              : tr("foot.mean", { coverage: hoursLineWords(a.coverage, hw, locale) })}
          </li>
          <li>
            {tr("plain.foldLegend")} {hoursLineWords(a.limit, hw, locale)}
          </li>
          {view.schedule && view.schedule.unparsed.length > 0 && (
            <li>
              {tr("foot.unparsed", {
                list: view.schedule.unparsed.map((u) => `"${u}"`).join(", "),
              })}
            </li>
          )}
          {/* The analysis's own working is written in English (lib/hours/trading). */}
          {locale === "en" &&
            a.weekdays
              .filter((wd) => wd.arithmetic.length > 0)
              .map((wd) => (
                <li key={wd.weekday}>
                  <b>{dayLong(wd.weekday, locale)}:</b> {wd.arithmetic.join("; ")}.
                </li>
              ))}
        </ul>
      </Fold>
    </Frame>
  );
}
