"use client";

// Insights · Team cover — P5-20 (Phase 5 Session E, rule 28), on the
// sheet system and the Trading hours grid's pattern. One weekday at a
// time: a role × hour grid, the hours tinted where demand ran short of
// the stated capacity or sat quiet, and beside it the reading in words
// ("Saturdays 10:00–14:00 ran 96% booked; one stylist covers about 1
// appointment an hour"). Roles and hours only: nothing on this screen is
// about a person, and every suggestion is a note for the owner to weigh.
// Read-only — nothing here changes a rota.
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "team"
// catalogue; weekdays, dates, percentages and figures in the reader's
// locale. The reading's sentences (headline, reasons, findings, notes,
// limits, season, assumptions, the demand source) are built in
// lib/team/coverage from the data, in the request's language since L-4c
// (the "teamWords" catalogue, through /api/team); role names are the
// owner's own answers.

import "../../app/team.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { dayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Weekday } from "../../lib/hours/schedule";
import type { CoverageResult, HourCell, WeekdayCover } from "../../lib/team/coverage";
import { TEAM, dayText } from "../../lib/team/coverage";
import type { TeamView } from "../../lib/team/load";

type Ok = Extract<CoverageResult, { status: "ok" }>;
type Refused = Extract<CoverageResult, { status: "refused" }>;

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
export function shortDay(d: Weekday, locale: AppLocale = "en"): string {
  if (locale === "en") return SHORT[d];
  const day = new Date(Date.UTC(2024, 0, 1 + ORDER.indexOf(d)));
  return new Intl.DateTimeFormat(intlTag(locale), { weekday: "short", timeZone: "UTC" }).format(
    day,
  );
}

/** "6 Nov" — lib's English, or the reader's own day and month. */
export function dayIn(day: string, locale: AppLocale = "en"): string {
  return locale === "en" ? dayText(day) : dayMonth(day, locale);
}

/** A share as a percentage: "96%" in English, Intl's elsewhere ("96 %"). */
export function pct(x: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${Math.round(x * 100)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(Math.round(x * 100) / 100);
}

/** A stated figure as the owner gave it ("37.5"), written the reader's way outside English. */
export function fig(n: number, locale: AppLocale = "en"): string {
  if (locale === "en") return String(n);
  return new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits: 2 }).format(n);
}

/** Pure: the weekday the screen opens on — the top finding's, else the first one read. */
export function pickWeekday(r: Ok): Weekday | null {
  return (
    r.findings[0]?.weekday ??
    r.weekdays.find((w) => w.verdict === "read")?.weekday ??
    r.weekdays.find((w) => w.verdict !== "closed")?.weekday ??
    null
  );
}

const one = (x: number, locale: AppLocale) =>
  locale === "en" ? (Math.round(x * 10) / 10).toFixed(1) : num(Math.round(x * 10) / 10, 1, locale);
const hh = (h: number) => String(h % 24).padStart(2, "0");

function cellClass(c: HourCell, verdict: WeekdayCover["verdict"]): string {
  if (verdict === "closed" || !c.open) return "closed";
  return c.band ?? "unread";
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
  const { tr } = useTr("team");
  return (
    <main className="screen tm-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={tr("aside")}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

function Limits({ limits }: { limits: readonly string[] }) {
  const t = useTranslations("team");
  return (
    <section className="tm-inset" aria-labelledby="tm-limits-head">
      <h2 id="tm-limits-head">{t("limits.head")}</h2>
      {limits.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <p>{t.rich("limits.switchOff", { link: (c) => <Link href="/watch">{c}</Link> })}</p>
    </section>
  );
}

function RefusedView({ r }: { r: Refused }) {
  const t = useTranslations("team");
  const { tr, locale } = useTr("team");
  return (
    <Frame
      title={r.headline}
      notes={
        <p>
          {r.reason}
          {r.ready_on ? ` ${tr("refused.readyOn", { day: dayIn(r.ready_on, locale) })}` : ""}
        </p>
      }
    >
      <div className="tm-grid">
        <SheetCard label={tr("refused.label")} title={tr("refused.title")}>
          <div className="tm-lists">
            <div>
              <p className="tm-list-head">{tr("refused.can")}</p>
              <ul>
                {r.can.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="tm-list-head">{tr("refused.cannot")}</p>
              <ul>
                {r.cannot.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="tm-copy">
            {t.rich("refused.history", {
              history: r.history_days,
              needed: num(r.needed_days, 0, locale),
              link: (c) => <Link href="/connections">{c}</Link>,
            })}
          </p>
        </SheetCard>
        <div className="tm-side">
          <RolesCard roles={r.roles} />
          <Limits limits={r.limits} />
        </div>
      </div>
    </Frame>
  );
}

function RolesCard({ roles }: { roles: Ok["roles"] }) {
  const t = useTranslations("team");
  const { tr, locale } = useTr("team");
  return (
    <SheetCard label={tr("roles.label")} title={tr("roles.title")}>
      {roles.length === 0 ? (
        <p className="tm-copy">
          {t.rich("roles.none", { link: (c) => <Link href="/profile">{c}</Link> })}
        </p>
      ) : (
        <ul className="tm-roles">
          {roles.map((r) => (
            <li key={r.role}>
              <span>
                {r.role}
                {r.rows > 1 && <span className="tm-sub"> × {fig(r.rows, locale)}</span>}
              </span>
              <span className="tm-fig">
                {r.hours_per_week === null
                  ? tr("roles.notStated")
                  : tr("roles.perWeek", { hours: fig(r.hours_per_week, locale) })}
                {r.unstated_rows > 0 && r.hours_per_week !== null
                  ? ` · ${tr("roles.withoutHours", { count: r.unstated_rows })}`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

function Grid({ r, day }: { r: Ok; day: WeekdayCover }) {
  const { tr, locale } = useTr("team");
  const bookings = r.source === "bookings";
  const early = day.verdict === "too_early";
  return (
    <div
      className="tm-wrap"
      tabIndex={0}
      aria-label={tr("grid.aria", { day: shortDay(day.weekday, locale) })}
    >
      <table className="tm-week" style={{ minWidth: 150 + r.hours.length * 44 }}>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">{tr("grid.row")}</span>
            </th>
            {r.hours.map((h) => (
              <th key={h} scope="col">
                {hh(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className={early ? "early" : undefined}>
            <th scope="row">
              {bookings ? tr("grid.booked") : tr("grid.takings")}
              <span className="tm-rownote">
                {bookings ? tr("grid.ofCapacity") : tr("grid.ofBusiest")}
              </span>
            </th>
            {day.cells.map((c) => (
              <td
                key={c.hour}
                className={cellClass(c, day.verdict)}
                title={
                  c.share
                    ? tr("grid.cellTitle", {
                        typical: pct(c.share.typical, locale),
                        low: pct(c.share.low, locale),
                        high: pct(c.share.high, locale),
                        days: day.days_read,
                      })
                    : undefined
                }
              >
                {c.open && c.share ? pct(c.share.typical, locale) : ""}
              </td>
            ))}
          </tr>
          {r.roles.map((role) => (
            <tr key={role.role} className={early ? "early" : undefined}>
              <th scope="row">
                {role.role}
                <span className="tm-rownote">
                  {role.on_per_open_hour === null ? tr("roles.notStated") : tr("grid.onAverage")}
                </span>
              </th>
              {day.cells.map((c) => (
                <td key={c.hour} className={cellClass(c, day.verdict)}>
                  {c.open && role.on_per_open_hour !== null
                    ? one(role.on_per_open_hour, locale)
                    : ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OkView({ r }: { r: Ok }) {
  const t = useTranslations("team");
  const { tr, locale } = useTr("team");
  const [picked, setPicked] = useState<Weekday | null>(() => pickWeekday(r));
  const day = r.weekdays.find((w) => w.weekday === picked) ?? null;
  const open = r.weekdays.filter((w) => w.verdict !== "closed");
  const bookings = r.source === "bookings";
  const weeks = Math.round(
    (Date.parse(`${r.basis.to}T00:00:00Z`) - Date.parse(`${r.basis.from}T00:00:00Z`)) /
      (7 * 86_400_000),
  );
  return (
    <Frame
      title={r.headline}
      notes={
        <p>
          {tr("ok.basis", {
            weeks,
            from: dayIn(r.basis.from, locale),
            to: dayIn(r.basis.to, locale),
            demand: r.basis.demand,
          })}
          {" · "}
          {r.capacity
            ? tr("ok.capacity", { perWeek: fig(r.capacity.per_week, locale) })
            : tr("ok.noCapacity")}
        </p>
      }
    >
      <div className="tm-grid">
        <SheetCard
          label={bookings ? tr("ok.labelBookings") : tr("ok.labelTakings")}
          title={tr("ok.title")}
          meta={
            <ul className="tm-legend" aria-label={tr("ok.legend")}>
              {bookings && (
                <li>
                  <span className="tm-sw short" aria-hidden="true" />
                  {tr("ok.legendShort", { pct: pct(TEAM.short_share, locale) })}
                </li>
              )}
              <li>
                <span className="tm-sw ok" aria-hidden="true" />
                {tr("ok.legendCovered")}
              </li>
              <li>
                <span className="tm-sw quiet" aria-hidden="true" />
                {tr("ok.legendQuiet", {
                  pct: pct(bookings ? TEAM.quiet_share : TEAM.quiet_takings_share, locale),
                })}
              </li>
            </ul>
          }
          foot={
            <>
              {bookings ? tr("ok.footBookings") : tr("ok.footTakings")}{" "}
              {t.rich("ok.footRole", { link: (c) => <Link href="/profile">{c}</Link> })}
            </>
          }
        >
          <div className="tm-days" role="group" aria-label={tr("ok.weekday")}>
            {open.map((w) => (
              <button
                key={w.weekday}
                type="button"
                aria-pressed={w.weekday === picked}
                onClick={() => setPicked(w.weekday)}
              >
                {shortDay(w.weekday, locale)}
                {w.verdict === "too_early" && (
                  <span className="tm-sub"> · {tr("ok.daysRead", { days: w.days_read })}</span>
                )}
              </button>
            ))}
          </div>
          {day ? <Grid r={r} day={day} /> : <p className="tm-copy">{tr("ok.noDay")}</p>}
        </SheetCard>
        <div className="tm-side">
          <SheetCard
            label={tr("reading.label")}
            title={r.findings.length === 0 ? tr("reading.none") : tr("reading.some")}
          >
            {r.findings.length === 0 ? (
              <p className="tm-copy">{tr("reading.noneBody")}</p>
            ) : (
              <ul className="tm-reads">
                {r.findings.map((f) => (
                  <li key={`${f.weekday}-${f.from_hour}-${f.band}`}>
                    <div className="tm-read-head">
                      <span>{f.words}</span>
                      <span className={`word ${f.band === "short" ? "alarm" : "low"}`}>
                        {tr(`band.${f.band}`)}
                      </span>
                    </div>
                    <p className="tm-read-sub">{f.line}</p>
                  </li>
                ))}
              </ul>
            )}
            <p className="tm-season">{r.season.words}</p>
          </SheetCard>
          <SheetCard label={tr("notes.label")} title={tr("notes.title")}>
            <ul className="tm-notes">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </SheetCard>
          <SheetCard label={tr("built.label")} title={tr("built.title")}>
            <p className="tm-copy">
              {tr("built.body", {
                days: r.basis.days_read,
                demand: r.basis.demand,
                from: dayIn(r.basis.from, locale),
                to: dayIn(r.basis.to, locale),
                history: r.basis.history_days,
              })}
              {r.capacity &&
                ` ${tr("built.capacity", {
                  perWeek: fig(r.capacity.per_week, locale),
                  hours: fig(r.capacity.open_hours_per_week, locale),
                })}`}
            </p>
            <ul className="tm-assumed">
              {r.assumed.map((a) => (
                <li key={a}>
                  <span className="word boxed low">{tr("built.assumed")}</span> {a}
                </li>
              ))}
            </ul>
          </SheetCard>
          <RolesCard roles={r.roles} />
          <Limits limits={r.limits} />
        </div>
      </div>
    </Frame>
  );
}

export function TeamScreen() {
  const t = useTranslations("team");
  const { tr } = useTr("team");
  const [view, setView] = useState<TeamView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/team");
        if (res.status === 401) return setFailed("signed_out");
        if (!res.ok) return setFailed("error");
        setView((await res.json()) as TeamView);
      } catch {
        setFailed("error");
      }
    })();
  }, []);

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut.title")}>
        <p className="tm-wait">
          {t.rich("signedOut.body", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("failed.title")}>
        <p className="tm-wait">{tr("failed.body")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("loading")} />;
  if (!view.enabled) {
    return (
      <Frame
        title={tr("off.title")}
        notes={<p>{t.rich("off.body", { link: (c) => <Link href="/watch">{c}</Link> })}</p>}
      />
    );
  }
  return view.result.status === "ok" ? <OkView r={view.result} /> : <RefusedView r={view.result} />;
}
