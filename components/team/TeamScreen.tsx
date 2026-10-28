"use client";

// Insights · Team cover — P5-20 (Phase 5 Session E, rule 28), on the
// sheet system and the Trading hours grid's pattern. One weekday at a
// time: a role × hour grid, the hours tinted where demand ran short of
// the stated capacity or sat quiet, and beside it the reading in words
// ("Saturdays 10:00–14:00 ran 96% booked; one stylist covers about 1
// appointment an hour"). Roles and hours only: nothing on this screen is
// about a person, and every suggestion is a note for the owner to weigh.
// Read-only — nothing here changes a rota.

import "../../app/team.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
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

const BAND_WORD = { short: "Runs short", quiet: "Quiet" } as const;

/** Pure: the weekday the screen opens on — the top finding's, else the first one read. */
export function pickWeekday(r: Ok): Weekday | null {
  return (
    r.findings[0]?.weekday ??
    r.weekdays.find((w) => w.verdict === "read")?.weekday ??
    r.weekdays.find((w) => w.verdict !== "closed")?.weekday ??
    null
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const one = (x: number) => (Math.round(x * 10) / 10).toFixed(1);
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
  return (
    <main className="screen tm-screen">
      <PageHead kicker="Insights · Team cover" title={title} aside="Roles and hours · never people">
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

function Limits({ limits }: { limits: readonly string[] }) {
  return (
    <section className="tm-inset" aria-labelledby="tm-limits-head">
      <h2 id="tm-limits-head">Roles, never people</h2>
      {limits.map((l) => (
        <p key={l}>{l}</p>
      ))}
      <p>
        The team module is yours to switch off on <Link href="/watch">Watching</Link>.
      </p>
    </section>
  );
}

function RefusedView({ r }: { r: Refused }) {
  return (
    <Frame
      title={r.headline}
      notes={
        <p>
          {r.reason}
          {r.ready_on ? ` Ready around ${dayText(r.ready_on)}, if the data keeps coming.` : ""}
        </p>
      }
    >
      <div className="tm-grid">
        <SheetCard label="Cover by the hour" title="Not enough to read yet">
          <div className="tm-lists">
            <div>
              <p className="tm-list-head">I can</p>
              <ul>
                {r.can.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="tm-list-head">I can&apos;t yet</p>
              <ul>
                {r.cannot.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="tm-copy">
            {r.history_days} day{r.history_days === 1 ? "" : "s"} of history; the least I read is{" "}
            {r.needed_days}. <Link href="/connections">Connections</Link>
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
  return (
    <SheetCard label="Roles" title="From who works in the business">
      {roles.length === 0 ? (
        <p className="tm-copy">
          No roles yet. They come from the interview: who works in the business, and their hours a
          week. <Link href="/profile">Fact sheet</Link>
        </p>
      ) : (
        <ul className="tm-roles">
          {roles.map((r) => (
            <li key={r.role}>
              <span>
                {r.role}
                {r.rows > 1 && <span className="tm-sub"> × {r.rows}</span>}
              </span>
              <span className="tm-fig">
                {r.hours_per_week === null ? "hours not stated" : `${r.hours_per_week} h / week`}
                {r.unstated_rows > 0 && r.hours_per_week !== null
                  ? ` · ${r.unstated_rows} without hours`
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
  const bookings = r.source === "bookings";
  const early = day.verdict === "too_early";
  return (
    <div
      className="tm-wrap"
      tabIndex={0}
      aria-label={`Cover by role and hour, ${SHORT[day.weekday]}`}
    >
      <table className="tm-week" style={{ minWidth: 150 + r.hours.length * 44 }}>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Row</span>
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
              {bookings ? "Booked" : "Takings"}
              <span className="tm-rownote">
                {bookings ? "of stated capacity" : "of the busiest hour"}
              </span>
            </th>
            {day.cells.map((c) => (
              <td
                key={c.hour}
                className={cellClass(c, day.verdict)}
                title={
                  c.share
                    ? `${pct(c.share.typical)} on a typical day, ${pct(c.share.low)}–${pct(c.share.high)} on the middle half of ${day.days_read} days`
                    : undefined
                }
              >
                {c.open && c.share ? pct(c.share.typical) : ""}
              </td>
            ))}
          </tr>
          {r.roles.map((role) => (
            <tr key={role.role} className={early ? "early" : undefined}>
              <th scope="row">
                {role.role}
                <span className="tm-rownote">
                  {role.on_per_open_hour === null ? "hours not stated" : "on, average hour"}
                </span>
              </th>
              {day.cells.map((c) => (
                <td key={c.hour} className={cellClass(c, day.verdict)}>
                  {c.open && role.on_per_open_hour !== null ? one(role.on_per_open_hour) : ""}
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
          Last {weeks} weeks · {dayText(r.basis.from)} to {dayText(r.basis.to)} · {r.basis.demand}
          {r.capacity
            ? ` · stated capacity ${r.capacity.per_week} a week (your answer)`
            : " · no capacity in money, so nothing runs short"}
        </p>
      }
    >
      <div className="tm-grid">
        <SheetCard
          label={
            bookings ? "Booked against stated capacity, by role" : "Takings by the hour, by role"
          }
          title="Cover by role and hour"
          meta={
            <ul className="tm-legend" aria-label="Legend">
              {bookings && (
                <li>
                  <span className="tm-sw short" aria-hidden="true" />
                  runs short ≥ {Math.round(TEAM.short_share * 100)}%
                </li>
              )}
              <li>
                <span className="tm-sw ok" aria-hidden="true" />
                covered
              </li>
              <li>
                <span className="tm-sw quiet" aria-hidden="true" />
                quiet ≤ {Math.round((bookings ? TEAM.quiet_share : TEAM.quiet_takings_share) * 100)}
                %
              </li>
            </ul>
          }
          foot={
            <>
              {bookings
                ? "Each hour's held appointments (completed, no-shows and late cancellations) over that weekday's days, against the stated capacity spread evenly over the open hours."
                : "Each hour's takings over that weekday's measured days, against the day's busiest hour."}{" "}
              A role&apos;s figure is its stated hours a week over the open hours: how many of that
              role are on in an average open hour, since the rota isn&apos;t known. DERIVED. Hatched
              = closed. Wrong roles or hours? Change your answer on the{" "}
              <Link href="/profile">Fact sheet</Link>.
            </>
          }
        >
          <div className="tm-days" role="group" aria-label="Weekday">
            {open.map((w) => (
              <button
                key={w.weekday}
                type="button"
                aria-pressed={w.weekday === picked}
                onClick={() => setPicked(w.weekday)}
              >
                {SHORT[w.weekday]}
                {w.verdict === "too_early" && <span className="tm-sub"> · {w.days_read} days</span>}
              </button>
            ))}
          </div>
          {day ? <Grid r={r} day={day} /> : <p className="tm-copy">No open weekday is read yet.</p>}
        </SheetCard>
        <div className="tm-side">
          <SheetCard
            label="Reading"
            title={
              r.findings.length === 0
                ? "Nothing stands out"
                : "Where cover runs short or sits quiet"
            }
          >
            {r.findings.length === 0 ? (
              <p className="tm-copy">
                No open hour runs short of your stated capacity or sits quiet on the days read.
              </p>
            ) : (
              <ul className="tm-reads">
                {r.findings.map((f) => (
                  <li key={`${f.weekday}-${f.from_hour}-${f.band}`}>
                    <div className="tm-read-head">
                      <span>{f.words}</span>
                      <span className={`word ${f.band === "short" ? "alarm" : "low"}`}>
                        {BAND_WORD[f.band]}
                      </span>
                    </div>
                    <p className="tm-read-sub">
                      {f.range_words}; {f.reason}.
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <p className="tm-season">{r.season.words}</p>
          </SheetCard>
          <SheetCard label="Notes for you" title="Yours to weigh">
            <ul className="tm-notes">
              {r.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </SheetCard>
          <SheetCard label="Built on" title="Sources and assumptions">
            <p className="tm-copy">
              {r.basis.days_read} trading days read from {r.basis.demand}, {dayText(r.basis.from)}{" "}
              to {dayText(r.basis.to)}; {r.basis.history_days} days of history in all.
              {r.capacity &&
                ` Stated capacity ${r.capacity.per_week} a week over ${r.capacity.open_hours_per_week} open hours.`}
            </p>
            <ul className="tm-assumed">
              {r.assumed.map((a) => (
                <li key={a}>
                  <span className="word boxed low">Assumed</span> {a}
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
      <Frame title="There's no business here yet.">
        <p className="tm-wait">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Team cover didn't load.">
        <p className="tm-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading the week's cover…" />;
  if (!view.enabled) {
    return (
      <Frame
        title="The team module is off."
        notes={
          <p>
            It stays off unless you switch it on, under Modules on{" "}
            <Link href="/watch">Watching</Link>. Switched on, it reads when the week needs more
            cover, or has more than it needs, by role and hour, and never anything about a person.
          </p>
        }
      />
    );
  }
  return view.result.status === "ok" ? <OkView r={view.result} /> : <RefusedView r={view.result} />;
}
