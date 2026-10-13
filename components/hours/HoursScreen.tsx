"use client";

// Trading hours — Phase 2 Session F (P2-26..30). When the money comes in,
// hour by hour and weekday by weekday, in the business's own clock, with
// the two signals and their arithmetic. The honest limit is on the
// screen, not in a footnote: a closed hour records no sales, so this
// suggests and a trial proves. Read-only.

import { useEffect, useState } from "react";
import Link from "next/link";
import { format, money } from "../../lib/core/money";
import { ProposalsBadge } from "../proposals/ProposalsBadge";

type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

interface WeekdayAnalysis {
  weekday: Weekday;
  days_measured: number;
  verdict: "ok" | "too_early" | "closed" | "hours_unknown";
  curve: { hour: number; mean_minor: number }[];
  first_hour: number | null;
  last_hour: number | null;
  opening_signal: boolean;
  closing_signal: boolean | null;
  arithmetic: string[];
}
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

const DAY_WORD: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};
const ORDER: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const hourLabel = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

function Curve({ w, currency }: { w: WeekdayAnalysis; currency: string }) {
  const max = Math.max(1, ...w.curve.map((c) => c.mean_minor));
  const inOpen = (h: number) =>
    w.first_hour !== null && w.last_hour !== null && h >= w.first_hour && h <= w.last_hour;
  return (
    <ul className="prop-log" aria-label={`average revenue by hour, ${DAY_WORD[w.weekday]}`}>
      {w.curve.map((c) => (
        <li key={c.hour} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="watch-at" style={{ minWidth: 48 }}>
            {hourLabel(c.hour)}
          </span>
          <span
            style={{
              display: "inline-block",
              height: 10,
              borderRadius: 5,
              width: `${Math.max(2, Math.round((Math.max(0, c.mean_minor) / max) * 100))}%`,
              maxWidth: "60%",
              background: inOpen(c.hour) ? "var(--ink)" : "var(--hair-2)",
              opacity: inOpen(c.hour) ? 0.7 : 1,
            }}
          />
          <span className="conn-note" style={{ margin: 0 }}>
            {format(money(c.mean_minor, currency))}
            {!inOpen(c.hour) && " · outside your stated hours"}
          </span>
        </li>
      ))}
    </ul>
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
      className="ct-goal-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <span className="conn-note">Which timezone is the business in?</span>
      <select className="prop-select" value={zone} onChange={(e) => setZone(e.target.value)}>
        <option value="">Choose…</option>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <button className="prop-btn" disabled={zone === ""}>
        Save
      </button>
      {error && <p className="conn-note">{error}</p>}
    </form>
  );
}

export function HoursScreen() {
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

  if (failed) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">
          {failed === "signed_out" ? (
            <>
              There&apos;s no business here yet.{" "}
              <Link href="/intake">Start with the interview</Link>.
            </>
          ) : (
            "Something went wrong reading your trading hours. Refresh to try again."
          )}
        </p>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading your trading hours…</p>
      </main>
    );
  }

  const a = view.analysis;
  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          trading hours
          {view.timezone.zone ? ` · judged in ${view.timezone.zone}` : ""}
          {a.status === "ok" ? ` · ${a.from} to ${a.to}` : ""}
        </span>
        <ProposalsBadge />
      </header>

      <section className="card ops-card">
        <span className="auth-eyebrow">your opening hours, as we read them</span>
        {view.schedule ? (
          <ul className="mode-reasons">
            {ORDER.map((d) => (
              <li key={d}>
                {DAY_WORD[d]}:{" "}
                {view.schedule!.unstated.includes(d)
                  ? "not stated"
                  : view.schedule!.days[d].length === 0
                    ? "closed"
                    : view.schedule!.days[d].map((p) => `${p.open}–${p.close}`).join(", ")}
              </li>
            ))}
          </ul>
        ) : (
          <p className="auth-copy">{view.schedule_note}</p>
        )}
        {view.schedule && view.schedule.unparsed.length > 0 && (
          <p className="conn-note">
            We couldn&apos;t read: {view.schedule.unparsed.map((u) => `"${u}"`).join(", ")}.
          </p>
        )}
        <p className="conn-note">
          Wrong? Change your answer in your <Link href="/profile">profile</Link> and this updates.
        </p>
      </section>

      {view.trials.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">trials — a signal is tested, never taken on faith</span>
          <ul className="prop-log">
            {view.trials.map((t) => (
              <li key={t.id}>
                <span className="prop-log-title">{t.summary}</span>{" "}
                <span className="prop-tag">{t.status}</span>
                {t.status === "pending" && (
                  <span className="conn-note">
                    {" "}
                    — waiting for you in the <Link href="/proposals">approval queue</Link>, with its
                    numbers
                  </span>
                )}
                {t.verdict && (
                  <span className="conn-note">
                    {" "}
                    — {t.verdict.verdict.replace("_", " ")}: {t.verdict.arithmetic}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {a.status !== "ok" ? (
        <section className="card ops-card">
          <p className="auth-copy">Not yet: {a.reason}.</p>
          {view.timezone.zone === null && <ZonePicker onSaved={() => location.reload()} />}
        </section>
      ) : (
        <>
          <section className="card ops-card">
            <span className="auth-eyebrow">read this first</span>
            <p className="auth-copy" style={{ fontSize: 14 }}>
              {a.limit} Measured: {a.coverage}.
            </p>
          </section>
          {ORDER.map((d) => a.weekdays.find((w) => w.weekday === d)!).map((w) => (
            <section key={w.weekday} className="card ops-card">
              <span className="auth-eyebrow">
                {DAY_WORD[w.weekday].toLowerCase()} · {w.days_measured} day
                {w.days_measured === 1 ? "" : "s"} measured
                {w.opening_signal && " · may open too late"}
                {w.closing_signal && " · last hour doesn't pay"}
              </span>
              {w.verdict === "too_early" && (
                <p className="auth-copy" style={{ fontSize: 14 }}>
                  Too few days measured to judge yet.
                </p>
              )}
              {w.verdict === "hours_unknown" && (
                <p className="auth-copy" style={{ fontSize: 14 }}>
                  We don&apos;t know your hours on this day.
                </p>
              )}
              {w.curve.length > 0 && <Curve w={w} currency={a.currency} />}
              {w.arithmetic.length > 0 && (
                <ul className="mode-reasons" style={{ marginTop: 12 }}>
                  {w.arithmetic.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </>
      )}
    </main>
  );
}
