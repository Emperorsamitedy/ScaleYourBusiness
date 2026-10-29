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

import "../../app/watch.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { PhoneAlertsCard } from "./PhoneAlertsCard";
import { moneyText, num } from "../sheet/num";
import { minorUnitExponent } from "../../lib/core/money";
import type { WatchReading } from "../../lib/watch/signals";
import type { SignalStatus, WatchDays, WatchSignal } from "../../lib/watch/watch-view";
import {
  NOTED_KINDS,
  THIN_RULE,
  dayOfWatch,
  parseInstant,
  statusTally,
  watchDays,
} from "../../lib/watch/watch-view";
import { RUN_DAYS } from "../../lib/anomaly/baseline";

interface LogEntry {
  at: string;
  kind: string;
  detail: string;
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "26 Oct" / "Mon 26 Oct", in UTC so server and browser agree. */
function dayText(iso: string, weekday = false): string {
  const d = new Date(parseInstant(iso.length === 10 ? `${iso}T00:00:00Z` : iso));
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return weekday ? `${WEEKDAYS[d.getUTCDay()]} ${day}` : day;
}

const STATUS: Record<SignalStatus, { word: string; cls: string }> = {
  steady: { word: "Steady", cls: "ok" },
  drifting: { word: "Drifting", cls: "drift" },
  interrupted: { word: "Interrupted", cls: "alarm" },
  thin: { word: "Thin", cls: "low" },
};

/** A per-day figure: whole units from 100 up, cents below; counts to one decimal when small. */
function perDay(signal: WatchSignal, value: number): string {
  if (signal.currency === null) return num(value, value < 100 ? 1 : 0);
  const exp = minorUnitExponent(signal.currency);
  const major = value / 10 ** exp;
  return Math.abs(major) < 100
    ? moneyText(Math.round(value), signal.currency)
    : moneyText(Math.round(major) * 10 ** exp, signal.currency);
}

function weeks(signal: WatchSignal): string {
  if (signal.last_week === null) return "—";
  const last = perDay(signal, signal.last_week);
  return signal.first_week === null ? last : `${perDay(signal, signal.first_week)} → ${last}`;
}

function DayStrip({ w }: { w: WatchDays }) {
  return (
    <section className="wt-days" aria-label={`Watch day ${w.day} of ${w.of}`}>
      <ol className="wt-strip" style={{ ["--wt-of" as string]: w.of }}>
        {Array.from({ length: w.of }, (_, i) => i + 1).map((d) => (
          <li
            key={d}
            className={`wt-day${d < w.day ? " past" : ""}${d === w.day ? " today" : ""}`}
            aria-current={d === w.day ? "date" : undefined}
          >
            {d}
          </li>
        ))}
      </ol>
      <p className="wt-days-cap">
        <span>Started {dayText(w.start)}</span>
        <span>Each filled square is a watch day gone by. The outlined one is today.</span>
        <span>Watch ends {dayText(w.end)}</span>
      </p>
    </section>
  );
}

function SignalsCard({ reading }: { reading: WatchReading }) {
  const { signals } = reading;
  const hasThin = signals.some((s) => s.status === "thin");
  const hasDrift = signals.some((s) => s.status === "drifting" || s.status === "interrupted");
  const foot =
    hasThin || hasDrift ? (
      <>
        {hasThin && <>THIN = {THIN_RULE}, so no usual range to judge against yet. </>}
        {hasDrift && (
          <>
            DRIFTING = outside its usual range {RUN_DAYS} days or more in a row; INTERRUPTED = past
            a rule that stops the watch.
          </>
        )}
      </>
    ) : undefined;
  return (
    <SheetCard
      label="What I'm watching"
      title={
        signals.length === 0
          ? "Nothing to read yet"
          : `${signals.length} signal${signals.length === 1 ? "" : "s"}, ${
              reading.connections > 0 ? "read every day" : "not being read now"
            }`
      }
      meta={signals.length > 0 ? statusTally(signals) : undefined}
      foot={foot}
    >
      {signals.length === 0 ? (
        <p className="wt-empty">
          {reading.connections === 0 ? (
            <>
              Connect your payments, till or online shop, analytics or ads, and every business-wide
              figure they hold is read here every day. <Link href="/connections">Connections</Link>
            </>
          ) : (
            "Your connections hold no daily figures yet — they arrive with the next sync."
          )}
        </p>
      ) : (
        <div className="wt-table-wrap" tabIndex={0} aria-label="Signals table">
          <table className="rt wt-table">
            <thead>
              <tr>
                <th scope="col">Signal</th>
                <th scope="col">Read from</th>
                <th scope="col" className="num">
                  Days read
                </th>
                <th scope="col" className="num wt-wrap">
                  Per day, week 1 → now
                </th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.key}>
                  <th scope="row">
                    {s.noun}
                    {s.currency && signals.filter((x) => x.noun === s.noun).length > 1
                      ? ` (${s.currency})`
                      : ""}
                  </th>
                  <td className="src">{s.read_from}</td>
                  <td className="num">{num(s.readings)}</td>
                  <td className="num">{weeks(s)}</td>
                  <td>
                    <span
                      className={`word ${STATUS[s.status].cls}`}
                      title={
                        s.since
                          ? `${s.direction === "drop" ? "Below" : "Above"} its usual range since ${dayText(s.since)}`
                          : undefined
                      }
                    >
                      {STATUS[s.status].word}
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
  const noted = log.filter(
    (e) => NOTED_KINDS.has(e.kind) && dayOfWatch(e.at, w.start, w.of) !== null,
  );
  const newest = noted[0];
  const fresh = newest ? Date.now() - parseInstant(newest.at) < 2 * DAY_MS : false;
  return (
    <SheetCard label="Noted, not acted on" title="What I would have said">
      {noted.length === 0 ? (
        <p className="wt-empty">
          Nothing yet. When a figure leaves its usual range, your hours show a signal, or a
          competitor changes a price, I note it here, and act on none of it.
        </p>
      ) : (
        <ul className="wt-notes">
          {noted.slice(0, 6).map((e, i) => (
            <li key={`${e.at}-${e.kind}`}>
              <span className="wt-at">Day {dayOfWatch(e.at, w.start, w.of)}</span>
              <p>{i === 0 && fresh ? <span className="marked">{e.detail}</span> : e.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

function WhenCard({ w }: { w: WatchDays }) {
  return (
    <SheetCard
      label="When the watch ends"
      foot={
        <span className="wt-foot-row">
          <span>The watch&apos;s length is set on How I work.</span>
          <Link className="act" href="/mode">
            How I work →
          </Link>
        </span>
      }
    >
      <ul className="wt-when">
        <li>
          <span className="wt-at">{dayText(w.end)}</span>
          <span>The watch ends. The next report reads everything it gathered.</span>
        </li>
        <li>
          <span className="wt-at">after</span>
          <span>Proposals you approve can run. The watch no longer holds them.</span>
        </li>
        <li>
          <span className="wt-at">always</span>
          <span>Nothing runs until you approve it.</span>
        </li>
      </ul>
    </SheetCard>
  );
}

function ActivityCard({ log }: { log: LogEntry[] }) {
  const work = log.filter((e) => !NOTED_KINDS.has(e.kind));
  return (
    <SheetCard label="Activity" title="Every entry is real work">
      {work.length === 0 ? (
        <p className="wt-empty">Nothing yet. The first weekly snapshot will appear here.</p>
      ) : (
        <ul className="wt-notes">
          {work.slice(0, 12).map((e) => (
            <li key={`${e.at}-${e.kind}`}>
              <span className="wt-at">{dayText(e.at)}</span>
              <p>{e.detail}</p>
            </li>
          ))}
        </ul>
      )}
    </SheetCard>
  );
}

function RulesCard({ thresholds }: { thresholds: WatchView["thresholds"] }) {
  return (
    <SheetCard label="What would interrupt the watch">
      <ul className="wt-rules">
        {thresholds.map((t) => (
          <li key={t.text}>
            <span>{t.text}</span>
            <span className={`word ${t.enforced ? "ok" : "low"}`}>
              {t.enforced ? "Checked daily" : "Not yet checked"}
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
  return (
    <SheetCard label="Modules" title="For when I start acting">
      <fieldset className="wt-modules">
        <legend className="sr-only">Modules</legend>
        {modules.modules
          .filter((m) => !m.why)
          .map((m) => (
            <label key={m.module} className="wt-module">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => onToggle(m.module, e.target.checked)}
              />
              <span>{m.module}</span>
            </label>
          ))}
        <label className="wt-module fixed" title={modules.analytics.why}>
          <input type="checkbox" checked disabled />
          <span>analytics, always on</span>
        </label>
      </fieldset>
      <p className="wt-why">{modules.analytics.why}</p>
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
              <span>{m.module}, roles not people</span>
            </label>
            <p className="wt-why">
              {m.why}
              {m.enabled && (
                <>
                  {" "}
                  <Link href="/team">See the team screen</Link>
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
  const status = !summary.owner
    ? "Sign up, and it goes to the address you sign in with."
    : !summary.enabled
      ? "Off. Nothing is emailed; everything stays on this screen."
      : !summary.in_care
        ? "It starts once How I work is decided."
        : !summary.configured
          ? "Email isn't set up on this server yet, so none is sent."
          : summary.last_sent_at
            ? `Last sent ${dayText(summary.last_sent_at)}.`
            : "The first one goes out on the next Monday check.";
  return (
    <SheetCard label="Weekly email" title="A summary every Monday">
      <label className="wt-module">
        <input
          type="checkbox"
          checked={summary.enabled}
          disabled={!summary.owner}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>email me the week</span>
      </label>
      <p className="wt-why">
        What I did and found that week, and what is waiting for you. Every line is an entry on this
        screen; a quiet week says so. {status}
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
  return (
    <main className="screen wt-screen">
      <PageHead kicker="Insights · Watching" title={title}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

export function WatchScreen({ reading }: { reading: WatchReading | null }) {
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
      <Frame title="There's no business here yet.">
        <p className="wt-wait">
          <Link href="/intake">Start with the interview</Link>, and the watch begins once the report
          is in.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="The watch didn't load.">
        <p className="wt-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view || !modules) {
    return <Frame title="Reading the watch…" />;
  }

  const w = watchDays(view.decision, new Date());
  const lower = (
    <div className="wt-grid">
      <ActivityCard log={view.log} />
      <div className="wt-side">
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
        title={
          view.decision === null
            ? "No watch is running yet."
            : "No watch is running. This business is in instant mode."
        }
        notes={
          <p>
            {view.decision === null
              ? "How I work hasn't been decided yet: it follows the report."
              : "There is no observation period here. Nothing runs until you approve it."}{" "}
            <Link href="/mode">How I work</Link>
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
    ? `Day ${w.of} of ${w.of}. The watch is complete.`
    : `Day ${w.day} of ${w.of}. ${
        ran === 0
          ? "Nothing touched on my own."
          : `${ran} change${ran === 1 ? "" : "s"} made, each one approved.`
      }`;
  const conns = reading?.connections ?? 0;

  return (
    <Frame
      title={title}
      notes={
        <>
          <p>Nothing I could change runs while the watch lasts.</p>
          <p className="wt-live">
            <span className="wt-sq" aria-hidden="true" />
            {conns > 0 ? (
              <span>
                Reading {conns} connection{conns === 1 ? "" : "s"} every day · watch{" "}
                {complete ? "ended" : "ends"} {dayText(w.end, true)}
              </span>
            ) : (
              <span>
                No connection is being read · <Link href="/connections">Connections</Link> · watch{" "}
                {complete ? "ended" : "ends"} {dayText(w.end, true)}
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
          <SheetCard label="What I'm watching" title="Nothing to read yet" />
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
