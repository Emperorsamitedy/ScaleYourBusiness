"use client";

// Insights · Trading hours — the owner's Trading hours design (2026-10-17)
// on Phase 2 Session F (P2-26..30) and the trials of P3-41. The week as a
// grid: every open hour's mean takings, less what an open hour costs when
// the owner has said (lib/hours/grid). Beside it, the signals the
// analysis fired, in words. The honest limit stays on the screen: a
// closed hour records no sales, so this suggests and a trial proves.
// Read-only — a trial is a proposal in "Waiting for you".

import "../../app/hours.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { delta, moneyText } from "../sheet/num";
import { minorUnitExponent } from "../../lib/core/money";
import type { Weekday } from "../../lib/hours/schedule";
import type { WeekdayAnalysis } from "../../lib/hours/trading";
import type { GridRow, WeekGrid } from "../../lib/hours/grid";
import { EVEN_SHARE, bestHour, hourHead, weekGrid } from "../../lib/hours/grid";

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

const SHORT: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};
const PLURAL: Record<Weekday, string> = {
  mon: "Mondays",
  tue: "Tuesdays",
  wed: "Wednesdays",
  thu: "Thursdays",
  fri: "Fridays",
  sat: "Saturdays",
  sun: "Sundays",
};
const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** "Fridays", "Fridays and Saturdays", "Tuesdays to Saturdays" (three or more in a row). */
export function daysText(days: readonly Weekday[]): string {
  const idx = days.map((d) => ORDER.indexOf(d)).sort((a, b) => a - b);
  const consecutive = idx.every((v, i) => i === 0 || v === (idx[i - 1] ?? -2) + 1);
  const names = idx.map((i) => PLURAL[ORDER[i] as Weekday]);
  if (names.length >= 3 && consecutive) return `${names[0]} to ${names.at(-1)}`;
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree. */
function dayText(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A cell's figure in whole currency units, signed when it is a net. */
function cellFig(minor: number, currency: string, signed: boolean): string {
  const major = Math.round(minor / 10 ** minorUnitExponent(currency));
  return signed ? delta(major, 0) : String(major);
}

interface Reading {
  key: string;
  head: string;
  word: string;
  cls: string;
  sub: string;
}

function readingsOf(
  weekdays: readonly WeekdayAnalysis[],
  grid: WeekGrid,
  currency: string,
  cost: number | null,
): Reading[] {
  const ok = weekdays.filter((w) => w.verdict === "ok");
  const fired = (pick: (w: WeekdayAnalysis) => boolean) =>
    ORDER.filter((d) => ok.some((w) => w.weekday === d && pick(w)));
  const out: Reading[] = [];
  const closing = fired((w) => w.closing_signal === true);
  if (closing.length > 0) {
    out.push({
      key: "closing",
      head: `The last hour, ${daysText(closing)}`,
      word: "Loses money",
      cls: "alarm",
      sub: `takes less than an open hour costs${cost !== null ? ` (${moneyText(cost, currency)})` : ""} on most measured days`,
    });
  }
  const opening = fired((w) => w.opening_signal);
  if (opening.length > 0) {
    out.push({
      key: "opening",
      head: `The first hour, ${daysText(opening)}`,
      word: "Busy at opening",
      cls: "drift",
      sub: "already takes most of what the best hour takes: demand probably starts before you open",
    });
  }
  const attention = fired((w) => w.attention_signal === true);
  if (attention.length > 0) {
    out.push({
      key: "attention",
      head: `Before opening, ${daysText(attention)}`,
      word: "Looked up early",
      cls: "low",
      sub: "a large share of that day's website visits come in the hours just before you open",
    });
  }
  const best = bestHour(grid);
  if (best) {
    out.push({
      key: "best",
      head: `${daysText(best.weekdays)}, ${hourHead(best.hour)}:00`,
      word: "Pays best",
      cls: "ok",
      sub: `+${moneyText(best.net_minor, currency)} an hour over its cost, on average`,
    });
  }
  const early = ORDER.filter((d) =>
    weekdays.some((w) => w.weekday === d && w.verdict === "too_early"),
  );
  if (early.length > 0) {
    out.push({
      key: "early",
      head: daysText(early),
      word: "Too early",
      cls: "low",
      sub: "too few measured days to judge yet",
    });
  }
  return out;
}

function readingTitle(readings: readonly Reading[]): string {
  const first = readings.find((r) => r.key !== "best" && r.key !== "early");
  if (!first) return "No signal fires on the measured days";
  if (first.key === "closing")
    return `The last hour doesn't pay on ${first.head.replace("The last hour, ", "")}`;
  if (first.key === "opening")
    return `Demand starts before you open on ${first.head.replace("The first hour, ", "")}`;
  return `People look you up before you open on ${first.head.replace("Before opening, ", "")}`;
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
  const note =
    row.verdict === "hours_unknown" || row.verdict === "missing"
      ? "hours not stated"
      : row.verdict === "too_early"
        ? `${row.days_measured} days`
        : row.verdict === "closed"
          ? "closed"
          : null;
  return (
    <tr className={row.verdict === "too_early" ? "early" : undefined}>
      <th scope="row">
        {SHORT[row.weekday]}
        {note && <span className="hr-rownote">{note}</span>}
      </th>
      {row.cells.map((c) => {
        if (row.verdict === "hours_unknown" || row.verdict === "missing") {
          return <td key={c.hour} className="unknown" aria-label="hours not stated" />;
        }
        if (!c.open) {
          return (
            <td key={c.hour} className="closed" aria-label="closed">
              {c.takings_minor ? cellFig(c.takings_minor, currency, false) : ""}
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
              {cellFig(c.net_minor, currency, true)}
            </td>
          );
        }
        return (
          <td key={c.hour} className="open">
            {c.takings_minor === null ? "" : cellFig(c.takings_minor, currency, false)}
          </td>
        );
      })}
    </tr>
  );
}

/** Shown only when the zone can't be derived — a country with several, or none given. */
function ZonePicker({ onSaved }: { onSaved: () => void }) {
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
      return setError(((await res.json()) as { error?: string }).error ?? "That didn't save.");
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
      <label htmlFor="hr-zone">Which timezone is the business in?</label>
      <select id="hr-zone" value={zone} onChange={(e) => setZone(e.target.value)}>
        <option value="">Choose…</option>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <button className="act" disabled={zone === ""}>
        Save
      </button>
      {error && <p className="hr-copy">{error}</p>}
    </form>
  );
}

function TrialsCard({ trials }: { trials: Trial[] }) {
  return (
    <section className="hr-inset" aria-labelledby="hr-trials-head">
      <h2 id="hr-trials-head">{trials.length > 0 ? "Trials" : "Not a proposal yet"}</h2>
      {trials.length === 0 ? (
        <p>
          A signal is never a change taken on faith. It becomes a four-week trial in &ldquo;Waiting
          for you&rdquo;, with its numbers, and nothing changes your hours unless you do.
        </p>
      ) : (
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
        Waiting for you →
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
  return (
    <main className="screen hr-screen">
      <PageHead kicker="Insights · Trading hours" title={title}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

export function HoursScreen({ cost }: { cost: HourCost | null }) {
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
      <Frame title="There's no business here yet.">
        <p className="hr-wait">
          <Link href="/intake">Start with the interview</Link>, and your hours are read from it.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Your trading hours didn't load.">
        <p className="hr-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) {
    return <Frame title="Reading your trading hours…" />;
  }

  const a = view.analysis;
  if (a.status !== "ok") {
    return (
      <Frame
        title={
          view.schedule
            ? "Not enough to read your hours yet."
            : "Your opening hours aren't known yet."
        }
        notes={<p>{view.schedule_note ?? `Not yet: ${a.reason}.`}</p>}
      >
        <div className="hr-grid">
          <SheetCard label="Margin by the hour" title="What this needs">
            <p className="hr-copy">
              Your opening hours from the interview, your timezone, and hourly card sales from a
              connected till, payment account or online shop.{" "}
              {a.reason.charAt(0).toUpperCase() + a.reason.slice(1)}.{" "}
              <Link href="/connections">Connections</Link>
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
  const readings = readingsOf(a.weekdays, grid, a.currency, hourCost);
  const weeks = Math.round((Date.parse(a.to) - Date.parse(a.from)) / (7 * 86_400_000));

  const title = !judged
    ? `Your ${grid.open_hours} weekly open hours, hour by hour.`
    : grid.losing_hours === 0
      ? `All ${grid.open_hours} of your weekly open hours pay for themselves.`
      : `${grid.losing_hours} of your ${grid.open_hours} weekly open hours don't pay for themselves.`;
  const unit = a.currency === "EUR" ? "€" : a.currency;
  const maxNet = Math.max(
    1,
    ...grid.rows.flatMap((r) => r.cells.map((c) => (c.open ? (c.net_minor ?? 0) : 0))),
  );
  const evenText =
    grid.even_within_minor !== null ? moneyText(grid.even_within_minor, a.currency) : null;

  return (
    <Frame
      title={title}
      notes={
        <p>
          Last {weeks} weeks · {dayText(a.from)} to {dayText(a.to)} · in {a.zone.replace(/_/g, " ")}
          {hourCost !== null
            ? ` · opening cost ${moneyText(hourCost, a.currency)} / hour (your answer)`
            : " · no opening cost stated, so nothing is judged"}
        </p>
      }
    >
      <div className="hr-grid">
        <SheetCard
          label={
            judged ? `Takings minus opening cost, ${unit} per hour` : `Takings, ${unit} per hour`
          }
          title="The week, hour by hour"
          meta={
            judged && evenText ? (
              <ul className="hr-legend" aria-label="Legend">
                <li>
                  <span className="hr-sw loses" aria-hidden="true" />
                  loses &gt; {evenText}
                </li>
                <li>
                  <span className="hr-sw even" aria-hidden="true" />
                  about even
                </li>
                <li>
                  <span className="hr-sw pays" aria-hidden="true" />
                  pays
                </li>
              </ul>
            ) : undefined
          }
          foot={
            <>
              Mean takings in each hour over that weekday&apos;s measured days, {a.coverage}; an
              hour with no sales counts as zero
              {judged
                ? `, and "about even" is within an eighth (${Math.round(EVEN_SHARE * 100 * 10) / 10}%) of the hour's cost`
                : ""}
              . DERIVED. Hatched = closed. Takings, not margin. {a.limit}
              {view.schedule && view.schedule.unparsed.length > 0 && (
                <> Couldn&apos;t read: {view.schedule.unparsed.map((u) => `"${u}"`).join(", ")}.</>
              )}{" "}
              Wrong hours? Change your answer on the <Link href="/profile">Fact sheet</Link>.
            </>
          }
        >
          {grid.hours.length === 0 ? (
            <p className="hr-copy">
              No open hours are stated and no sales are measured by the hour.
            </p>
          ) : (
            <div className="hr-wrap" tabIndex={0} aria-label="The week, hour by hour">
              <table className="hr-week" style={{ minWidth: 60 + grid.hours.length * 38 }}>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Day</span>
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
          <SheetCard label="Reading" title={readingTitle(readings)}>
            {readings.length === 0 ? (
              <p className="hr-copy">
                Nothing in your hours stands out on the measured days. The watch checks again every
                week.
              </p>
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
