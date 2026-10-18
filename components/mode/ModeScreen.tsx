"use client";

// How I work — the mode decision (Session H, P1-43; the owner's How-I-work
// design, 2026-10-17). Two cards, Mode A (watch first) and Mode B (act
// right away), the current one on paper and marked CURRENT; under them
// the stored reasons, verbatim — the owner sees a rule, not an opinion —
// and what never changes in either mode. Extending the watch is one click
// here; shortening is not on this screen at all (P1-44 buries it behind
// an acknowledgement), and switching modes is not a feature: the rule
// decides it from the profile.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHead, SheetCard } from "../sheet/PageHead";
import type { ModeDecision } from "./mode-view";
import { chosenLine, dayMonth, headline, humanise, parseTs, watchDay } from "./mode-view";
import "../../app/mode.css";

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "none" }
  | { phase: "deferred"; reasoning: string }
  | { phase: "ready"; decision: ModeDecision; extending: boolean };

const KICKER = "Your business · How I work";

export function ModeScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const res = await fetch("/api/mode");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json().catch(() => ({}))) as ModeDecision & { none?: boolean };
    if (!res.ok || j.none) return setState({ phase: "none" });
    setState({ phase: "ready", decision: j, extending: false });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async () => {
    setState({ phase: "loading" });
    const res = await fetch("/api/mode", { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as {
      kind?: string;
      decision?: ModeDecision;
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
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title="How I work." />
        <p className="md-wait">Reading the decision…</p>
      </main>
    );
  }

  if (state.phase === "signedout") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title="Sign in first." />
        <SheetCard label="How I work" title="This screen reads your profile.">
          <Link className="next" href="/login">
            Sign in <span aria-hidden="true">→</span>
          </Link>
        </SheetCard>
      </main>
    );
  }

  if (state.phase === "none") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title="Not decided yet." />
        <SheetCard label="How I work" title="Ready to decide.">
          <p className="md-copy">
            One fixed rule reads your answers and picks: act now, or watch first. You see exactly
            what triggered it.
          </p>
          <button type="button" className="next" onClick={() => void decide()}>
            Decide now <span aria-hidden="true">→</span>
          </button>
        </SheetCard>
      </main>
    );
  }

  if (state.phase === "deferred") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title="Not decided yet." />
        <SheetCard label="Not yet" title="I won't guess.">
          <p className="md-copy">{state.reasoning}</p>
          <Link className="next" href="/intake">
            Answer the core questions <span aria-hidden="true">→</span>
          </Link>
        </SheetCard>
      </main>
    );
  }

  const { decision } = state;
  const watching = decision.mode === "watching";
  const weeks = decision.watch_weeks;
  const day = watchDay(decision, Date.now());
  const ends = parseTs(decision.review_at);

  const modeA = (
    <section
      className={`md-mode${watching ? " current" : ""}`}
      aria-labelledby="md-a"
      aria-current={watching ? "true" : undefined}
    >
      <p className="md-mode-label">
        <span>Mode A</span>
        {watching && <span className="md-current">Current</span>}
      </p>
      <h2 className="md-mode-title" id="md-a">
        Watch first
      </h2>
      {watching && weeks !== null ? (
        <>
          <p className="md-mode-copy">
            I spend {weeks * 7} days learning how your business actually behaves before proposing
            anything. Changing things quickly could cost you sales. Nothing changes without you.
          </p>
          <p className="md-mode-lines">
            {day && (
              <>
                Day {day.day} of {day.of} · ends {dayMonth(ends)}
                <br />
              </>
            )}
            The first read still arrives while I watch.
          </p>
          <div className="md-mode-acts">
            <Link className="next" href="/watch">
              Open Watching <span aria-hidden="true">→</span>
            </Link>
            {weeks !== 8 && (
              <button
                type="button"
                className="ghost"
                disabled={state.extending}
                onClick={() => void extend()}
              >
                {state.extending ? "Extending…" : "Extend to 56 days"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="md-mode-copy">
            I watch for four to eight weeks before proposing anything, so a change can&rsquo;t cost
            sales I haven&rsquo;t measured.
          </p>
          <p className="md-mode-lines">
            Chosen with 10+ orders a month, staff, paid ads, a support process or 3+ months trading
            <br />
            Every proposal still needs your yes
          </p>
        </>
      )}
    </section>
  );

  const modeB = (
    <section
      className={`md-mode${!watching ? " current" : ""}`}
      aria-labelledby="md-b"
      aria-current={!watching ? "true" : undefined}
    >
      <p className="md-mode-label">
        <span>Mode B</span>
        {!watching && <span className="md-current">Current</span>}
      </p>
      <h2 className="md-mode-title" id="md-b">
        Act right away
      </h2>
      {!watching ? (
        <>
          <p className="md-mode-copy">{decision.reasoning}</p>
          <p className="md-mode-lines">
            Started {dayMonth(parseTs(decision.decided_at))}
            <br />
            Every proposal still needs your yes
          </p>
          <div className="md-mode-acts">
            <Link className="next" href="/report">
              See the first read <span aria-hidden="true">→</span>
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="md-mode-copy">
            Proposals start from the first read. Chosen only when there is nothing running that a
            change could break.
          </p>
          <p className="md-mode-lines">
            Only under 10 orders a month, no staff, no paid ads, no support process, under 3 months
            <br />
            Every proposal still needs your yes
          </p>
        </>
      )}
    </section>
  );

  return (
    <main className="screen md-screen">
      <PageHead kicker={KICKER} title={headline(decision)} aside={chosenLine(decision)} />

      <div className="md-grid">
        {modeA}
        {modeB}

        <SheetCard
          className="md-why"
          label={watching ? "Why I suggested watching" : "Why it's safe to start now"}
          title={
            watching ? "Real customers are buying" : "Nothing running that a change could break"
          }
        >
          {decision.reasons.length > 0 ? (
            <ul className="md-reasons">
              {decision.reasons.map((reason) => (
                <li key={reason}>{humanise(reason)}</li>
              ))}
            </ul>
          ) : (
            <p className="md-copy">No reasons were stored with this decision.</p>
          )}
        </SheetCard>

        <SheetCard className="md-never" label="In either mode" title="What never changes">
          <ol className="md-rules">
            <li>
              <span className="md-n" aria-hidden="true">
                01
              </span>
              <span>
                Nothing runs without your approval. Unanswered proposals expire — they never run by
                default.
              </span>
            </li>
            <li>
              <span className="md-n" aria-hidden="true">
                02
              </span>
              <span>
                &ldquo;Stop everything&rdquo; on <Link href="/proposals">Waiting for you</Link>{" "}
                halts every execution at once, no sign-in needed.
              </span>
            </li>
            <li>
              <span className="md-n" aria-hidden="true">
                03
              </span>
              <span>
                Limits you set hold: a proposal that would break one is withheld, never put to you
                as if it were fine.
              </span>
            </li>
          </ol>
        </SheetCard>
      </div>
    </main>
  );
}
