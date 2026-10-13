"use client";

// The watching status screen — Session H (P1-47/48), ux-spec §6.
// Answers "what is it doing right now" with real activity, never
// fabricated delay: every log line is a watch_activity row that
// corresponds to work performed. Below it, module selection (P1-48)
// with analytics fixed on and the reason stated.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ProposalsBadge } from "../proposals/ProposalsBadge";

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
interface ModuleRow {
  module: string;
  enabled: boolean;
}
interface ModulesView {
  modules: ModuleRow[];
  analytics: { enabled: boolean; fixed: boolean; why: string };
}

export function WatchScreen() {
  const [view, setView] = useState<WatchView | null>(null);
  const [modules, setModules] = useState<ModulesView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, m] = await Promise.all([fetch("/api/watch"), fetch("/api/modules")]);
      if (!w.ok || !m.ok) return setFailed(true);
      setView((await w.json()) as WatchView);
      setModules((await m.json()) as ModulesView);
    } catch {
      setFailed(true);
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

  if (failed) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Something went wrong loading the watch. Refresh to try again.</p>
      </main>
    );
  }
  if (!view || !modules) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading the watch…</p>
      </main>
    );
  }

  if (!view.decision || view.decision.mode !== "watching") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">watching</span>
            <h1 className="auth-title">Nothing is being watched.</h1>
            <p className="auth-copy">
              {view.decision === null
                ? "The mode hasn't been decided yet."
                : "This business is in instant mode — there is no watch running."}
            </p>
            <Link className="next auth-cta" style={{ marginTop: 22 }} href="/mode">
              See the mode decision
            </Link>
            <p className="auth-copy" style={{ marginTop: 14, fontSize: 13 }}>
              <Link href="/progress">How your goals are going →</Link> ·{" "}
              <Link href="/hours">Trading hours →</Link>
            </p>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          watching · {view.days_remaining} day{view.days_remaining === 1 ? "" : "s"} remaining ·
          review {view.decision.review_at.slice(0, 10)} ·{" "}
          <Link href="/progress">goal progress</Link> · <Link href="/hours">trading hours</Link>
        </span>
        <ProposalsBadge />
      </header>

      {/* P2-24: the interruption the thresholds promised, when one has happened. */}
      {view.interruptions.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">interrupted — something crossed a threshold</span>
          <ul className="watch-log">
            {view.interruptions.map((i) => (
              <li key={i.id}>
                <span className="watch-at">{i.detected_at.slice(0, 10)}</span>
                <span>{i.detail}</span>
              </li>
            ))}
          </ul>
          <p className="auth-copy" style={{ marginTop: 12, fontSize: 13 }}>
            Every figure above is measured, and the arithmetic is shown so you can check it. The
            watch continues; this is the moment it said it would tell you.
          </p>
        </section>
      )}

      <section className="card ops-card">
        <span className="auth-eyebrow">activity — every entry is real work</span>
        {view.log.length === 0 ? (
          <p className="auth-copy">Nothing yet. The first weekly snapshot will appear here.</p>
        ) : (
          <ul className="watch-log">
            {view.log.map((entry) => (
              <li key={`${entry.at}-${entry.kind}`}>
                <span className="watch-at">{entry.at.slice(0, 10)}</span>
                <span>{entry.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">what would interrupt the watch</span>
        <ul className="mode-reasons">
          {view.thresholds.map((t) => (
            <li key={t.text}>
              {t.text}
              {!t.enforced && <em> — promised, not yet checked automatically</em>}
            </li>
          ))}
        </ul>
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">modules — for when I start acting</span>
        <div className="watch-modules">
          {modules.modules.map((m) => (
            <label key={m.module} className="watch-module">
              <input
                type="checkbox"
                checked={m.enabled}
                onChange={(e) => void toggle(m.module, e.target.checked)}
              />
              <span>{m.module}</span>
            </label>
          ))}
          <label className="watch-module fixed" title={modules.analytics.why}>
            <input type="checkbox" checked disabled />
            <span>analytics — always on</span>
          </label>
        </div>
        <p className="auth-copy" style={{ marginTop: 12, fontSize: 13 }}>
          {modules.analytics.why}
        </p>
      </section>
    </main>
  );
}
