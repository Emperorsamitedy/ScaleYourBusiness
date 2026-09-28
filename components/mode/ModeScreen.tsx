"use client";

// The mode decision screen — Session H (P1-43), ux-spec §5. One card,
// no interaction beyond acknowledgement. The WHY list renders the
// stored ModeDecisionInputs reasons verbatim — the owner sees a rule,
// not an opinion. Extending is one click here; shortening is not on
// this screen at all (P1-44 buries it behind an acknowledgement).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Decision {
  mode: "instant" | "watching";
  watch_weeks: number | null;
  reasons: string[];
  reasoning: string;
  review_at: string;
}

type State =
  | { phase: "loading" }
  | { phase: "none" }
  | { phase: "deferred"; reasoning: string }
  | { phase: "ready"; decision: Decision; extending: boolean };

const WEEKS_WORD: Record<number, string> = { 4: "four", 6: "six", 8: "eight" };

/** Months read as years once they stop being months-sized. */
const humanise = (reason: string): string =>
  reason.replace(/(\d+) months/g, (m, n: string) => {
    const months = Number(n);
    if (months < 24) return m;
    const years = Math.round(months / 12);
    return `${years} years`;
  });

export function ModeScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const res = await fetch("/api/mode");
    const j = (await res.json()) as Decision & { none?: boolean; error?: string };
    if (!res.ok) return setState({ phase: "none" });
    if (j.none) return setState({ phase: "none" });
    setState({ phase: "ready", decision: j, extending: false });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async () => {
    setState({ phase: "loading" });
    const res = await fetch("/api/mode", { method: "POST" });
    const j = (await res.json()) as {
      kind?: string;
      decision?: Decision;
      reasoning?: string;
    };
    if (j.kind === "deferred") {
      setState({ phase: "deferred", reasoning: j.reasoning ?? "" });
    } else if (j.kind === "decided" && j.decision) {
      setState({ phase: "ready", decision: j.decision, extending: false });
    } else {
      setState({ phase: "none" });
    }
  };

  const extend = async () => {
    if (state.phase !== "ready") return;
    setState({ ...state, extending: true });
    await fetch("/api/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_weeks: 8 }),
    });
    await load();
  };

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading the decision…</p>
      </main>
    );
  }

  if (state.phase === "none") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">how I&rsquo;ll work</span>
            <h1 className="auth-title">Ready to decide.</h1>
            <p className="auth-copy">
              One fixed rule reads your answers and picks: act now, or watch first. You see exactly
              what triggered it.
            </p>
            <button
              className="next auth-cta"
              style={{ marginTop: 22 }}
              onClick={() => void decide()}
            >
              Decide now
            </button>
          </section>
        </div>
      </main>
    );
  }

  if (state.phase === "deferred") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">not yet</span>
            <h1 className="auth-title">I won&rsquo;t guess.</h1>
            <p className="auth-copy">{state.reasoning}</p>
            <Link className="next auth-cta" style={{ marginTop: 22 }} href="/intake">
              Answer the core questions
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const { decision } = state;
  const watching = decision.mode === "watching";
  const weeksWord = decision.watch_weeks !== null ? WEEKS_WORD[decision.watch_weeks] : null;

  return (
    <main className="auth-stage">
      <div className="auth-col" style={{ width: "min(560px, 100%)" }}>
        <span className="wordmark">Ledgerline</span>
        <section className="card auth-card">
          <span className="auth-eyebrow">{watching ? "watching first" : "instant"}</span>
          <h1 className="auth-title">
            {watching
              ? `${(weeksWord ?? String(decision.watch_weeks ?? "")).replace(/^./, (c) => c.toUpperCase())} weeks of watching first.`
              : "Starting now."}
          </h1>
          {/* The stored reasoning is the decision-time record and stays
              immutable; the paragraph must follow the CURRENT length,
              which an override can have changed since. */}
          <p className="auth-copy">
            {watching
              ? "Real customers are buying. Changes wait until the numbers are known."
              : decision.reasoning}
          </p>

          <span className="auth-eyebrow" style={{ marginTop: 24 }}>
            {watching ? `why ${weeksWord ?? decision.watch_weeks} weeks` : "why it's safe"}
          </span>
          <ul className="mode-reasons">
            {decision.reasons.map((reason) => (
              <li key={reason}>{humanise(reason)}</li>
            ))}
          </ul>

          {watching && (
            <p className="auth-copy" style={{ marginTop: 18 }}>
              The first read still arrives. Nothing changes without you.
            </p>
          )}

          <div className="mode-actions">
            <Link className="next auth-cta" href={watching ? "/watch" : "/report"}>
              {watching ? "Start watching" : "See the first read"}
            </Link>
            {watching && decision.watch_weeks !== 8 && (
              <button
                className="ghost quiet mode-extend"
                disabled={state.extending}
                onClick={() => void extend()}
              >
                {state.extending ? "Extending…" : "Extend to eight weeks"}
              </button>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
