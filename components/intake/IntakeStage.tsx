"use client";

// The intake stage — client orchestrator for the signature screen
// (specs/ux-spec-v1.md §4). The motion reports state (P0-60, §2):
//
//   answering → (submit) → leaving (card departs on --d-record, 280ms;
//   the PUT rides inside it) → the fact line settles into the record
//   column (--d-record) → next card rises (--d-move) → answering.
//
// The JS depart wait reads the same --d-record token the CSS runs on,
// so the two agree; under prefers-reduced-motion both are zero.
//
// One question in the centre; beside it, one record column — the live
// "check your answers" list, every line printing its provenance.
//
// First paint is skeleton-free: the shell renders immediately and the
// first card rises when state arrives from a single POST on mount.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AnswerAction,
  AnswerResponse,
  IntakeChip,
  IntakeState,
  ReconcileResponse,
} from "@/lib/intake/types";
import "@/app/intake.css";
import { Chip } from "./Chip";
import { departMs } from "./motion";
import { OnDeck } from "./OnDeck";
import { QuestionCard } from "./QuestionCard";
import { ReconcilePanel } from "./ReconcilePanel";
import { factLine, sessionTally, tallyText } from "./record";
import { TopBar } from "./TopBar";

type Phase = "boot" | "boot_error" | "answering" | "leaving";

/** The closing readout renders completeness as a word, never a percentage. */
const completenessWord = (overall: number): string => (overall >= 0.7 ? "good" : "moderate");

/**
 * P1-56: the finish is where an owner gets a way back in. No password —
 * an email and a link that reopens their profile on any device. The link
 * is shown on screen rather than promised by email, because a promised
 * email that never arrives is worse than no promise.
 */
function KeepAccess() {
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || email.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/intake/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await res.json()) as { url?: string; error?: string };
      if (!res.ok) {
        setError(payload.error ?? "I couldn't make the link. Try again.");
        return;
      }
      setLink(payload.url ?? null);
    } catch {
      setError("I couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    return (
      <div className="linkbox">
        <span className="label">Your link</span> It reopens this profile on any device for 30 days.
        Keep a copy somewhere you&rsquo;ll find it.
        <code>{link}</code>
      </div>
    );
  }

  return (
    <form className="finish-form" onSubmit={(e) => void submit(e)}>
      <input
        className="field"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@yourbusiness.hu"
        aria-label="Your email address"
      />
      <button type="submit" className="next" disabled={busy || email.trim() === ""}>
        {busy ? "Making the link" : <>Get my link &rarr;</>}
      </button>
      {error && <p className="err">{error}</p>}
    </form>
  );
}

function DoneCard({ readout }: { readout: NonNullable<IntakeState["readout"]> }) {
  return (
    <div className="card done">
      <h2>The interview is complete.</h2>
      <p>
        I have the record I need for a first read on the business. Deeper questions come later, once
        you have seen the first report.
      </p>
      <dl className="readout">
        <dt className="label">Answers on record</dt>
        <dd className="fig">{readout.answered}</dd>
        <dt className="label">Gaps to revisit</dt>
        <dd className="fig">{readout.gaps}</dd>
        <dt className="label">Profile completeness</dt>
        <dd>{completenessWord(readout.completeness)}</dd>
        <dt className="label">Next</dt>
        <dd>deciding how carefully to move</dd>
      </dl>
      <p className="help done-access">
        Leave an email and I&rsquo;ll give you a link back to this profile. No password, no account.
      </p>
      <KeepAccess />
    </div>
  );
}

/** P0-87 telemetry: batched, fire-and-forget, never breaks the intake. */
interface TelemetryEvent {
  kind: string;
  question_id?: string | null;
  ms_since_shown?: number | null;
  meta?: Record<string, unknown> | null;
}

export function IntakeStage() {
  const [state, setState] = useState<IntakeState | null>(null);
  const [chips, setChips] = useState<readonly IntakeChip[]>([]);
  const [phase, setPhase] = useState<Phase>("boot");
  const [serverError, setServerError] = useState<string | null>(null);
  const [stripOpen, setStripOpen] = useState(false);
  // The line the system restates after a record — cleared on reopen.
  const [justRecorded, setJustRecorded] = useState<IntakeChip | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const booted = useRef(false);

  // P1-57: arriving from a resume link. An expired link still lands here
  // with a usable intake rather than an apology page.
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("resume");
    if (flag === "ok") setResumeNotice("Resumed from your link. Earlier answers are on record.");
    if (flag === "expired") {
      setResumeNotice(
        "That link had expired, so this is a new profile. You can get a new link at the end.",
      );
    }
    if (flag) window.history.replaceState({}, "", window.location.pathname);
  }, []);

  // P0-87: hesitation, confusion, abandonment — all observable.
  const eventQueue = useRef<TelemetryEvent[]>([]);
  const shownAt = useRef<number | null>(null);
  const firstInputSent = useRef(false);

  const flushEvents = useCallback((useBeacon = false): void => {
    const events = eventQueue.current;
    if (events.length === 0) return;
    eventQueue.current = [];
    const body = JSON.stringify({ events });
    try {
      if (useBeacon && navigator.sendBeacon) {
        navigator.sendBeacon("/api/intake/events", body);
      } else {
        void fetch("/api/intake/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => undefined);
      }
    } catch {
      // Telemetry must never break the intake.
    }
  }, []);

  const track = useCallback(
    (event: TelemetryEvent, flush = true): void => {
      eventQueue.current.push(event);
      if (flush) flushEvents();
    },
    [flushEvents],
  );

  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState !== "hidden") return;
      eventQueue.current.push({ kind: "page_hidden" });
      flushEvents(true);
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [flushEvents]);

  const boot = useCallback(async (): Promise<void> => {
    setPhase("boot");
    try {
      const res = await fetch("/api/intake", { method: "POST" });
      if (!res.ok) throw new Error(`intake boot ${res.status}`);
      let next = (await res.json()) as IntakeState;
      // A gap on the fact sheet links here as /intake?ask=<question_id>;
      // re-read with the preference so that question is the one presented.
      const ask = new URLSearchParams(window.location.search).get("ask");
      if (ask !== null && ask !== "") {
        const preferred = await fetch(`/api/intake?ask=${encodeURIComponent(ask)}`);
        if (preferred.ok) next = (await preferred.json()) as IntakeState;
      }
      setState(next);
      setPhase("answering");
      if (next.progress.core_done > 0) track({ kind: "session_resumed" });
    } catch {
      setPhase("boot_error");
    }
  }, [track]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);

  const submit = useCallback(
    async (method: "PUT" | "PATCH", body: Record<string, unknown>): Promise<void> => {
      setServerError(null);
      setPhase("leaving");
      // Network latency hides inside the depart animation (§4.2).
      const departed = new Promise((resolve) => setTimeout(resolve, departMs()));
      try {
        const res = await fetch("/api/intake", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        await departed;
        if (res.ok) {
          const { chip, state: next } = (await res.json()) as AnswerResponse;
          setChips((prev) => [...prev, chip]);
          setJustRecorded(chip);
          setState(next);
          setPhase("answering");
        } else {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setPhase("answering");
          setServerError(payload?.error ?? "Something went wrong on our side. Try again.");
        }
      } catch {
        await departed;
        setPhase("answering");
        setServerError("I couldn't reach the server. Check your connection and try again.");
      }
    },
    [],
  );

  const question = state?.question ?? null;

  // Every question arrival starts a hesitation clock (P0-87).
  useEffect(() => {
    if (!question) return;
    shownAt.current = Date.now();
    firstInputSent.current = false;
    track({ kind: "question_shown", question_id: question.id }, false);
  }, [question, track]);

  const handleFirstInput = useCallback((): void => {
    if (firstInputSent.current || !question) return;
    firstInputSent.current = true;
    track({
      kind: "first_input",
      question_id: question.id,
      ms_since_shown: shownAt.current ? Date.now() - shownAt.current : null,
    });
  }, [question, track]);

  const handleAnswer = useCallback(
    (action: AnswerAction): void => {
      if (phase !== "answering" || !question) return;
      const kind =
        action.kind === "unknown"
          ? "marked_unknown"
          : action.kind === "skip"
            ? "skipped"
            : "answer_recorded";
      track({
        kind,
        question_id: question.id,
        ms_since_shown: shownAt.current ? Date.now() - shownAt.current : null,
      });
      void submit("PUT", { question_id: question.id, action });
    },
    [phase, question, submit, track],
  );

  const handleEntityRows = useCallback(
    (rows: Record<string, unknown>[]): void => {
      if (phase !== "answering" || !question) return;
      track({
        kind: "answer_recorded",
        question_id: question.id,
        ms_since_shown: shownAt.current ? Date.now() - shownAt.current : null,
        meta: { rows: rows.length },
      });
      void submit("PATCH", { question_id: question.id, rows });
    },
    [phase, question, submit, track],
  );

  // P0-75: reopen removes the chip and returns the question to the centre.
  const handleReopen = useCallback(
    async (questionId: string, reason: string): Promise<void> => {
      setServerError(null);
      try {
        const res = await fetch("/api/intake", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question_id: questionId, action: { kind: "reopen", reason } }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setServerError(payload?.error ?? "I couldn't reopen that. Try again.");
          return;
        }
        const { state: next } = (await res.json()) as AnswerResponse;
        track({ kind: "reopened", question_id: questionId });
        setChips((prev) => prev.filter((c) => c.question_id !== questionId));
        setJustRecorded(null);
        setState(next);
        setPhase("answering");
      } catch {
        setServerError("I couldn't reach the server. Check your connection and try again.");
      }
    },
    [track],
  );

  const clearServerError = useCallback((): void => {
    setServerError(null);
  }, []);

  // §4.5: the two resolution paths. "fix" pulls the involved chips back
  // out of the columns — their questions are returning to the centre.
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const handleReconcile = useCallback(
    async (findingId: string, choice: "confirm" | "fix"): Promise<void> => {
      setReconcileBusy(true);
      setServerError(null);
      try {
        const res = await fetch("/api/intake/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ finding_id: findingId, choice }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setServerError(payload?.error ?? "I couldn't record that. Try again.");
          return;
        }
        const { reopened, state: next } = (await res.json()) as ReconcileResponse;
        track({ kind: "reconcile_resolved", meta: { choice, reopened: reopened.length } });
        if (reopened.length > 0) {
          setChips((prev) => prev.filter((c) => !reopened.includes(c.question_id)));
          setJustRecorded(null);
        }
        setState(next);
        setPhase("answering");
      } catch {
        setServerError("I couldn't reach the server. Check your connection and try again.");
      } finally {
        setReconcileBusy(false);
      }
    },
    [track],
  );

  // The panel surfaces contradictions and implausibilities; plain gaps
  // stay as gap lines in the record. Involved lines are flagged in words.
  const reconcile =
    state?.findings.find((f) => f.kind === "contradiction" || f.kind === "implausible") ?? null;

  const reconcileId = reconcile?.id ?? null;
  const reconcileRule = reconcile?.rule_id ?? null;
  useEffect(() => {
    // Re-fires only when a different finding surfaces.
    if (!reconcileId || !reconcileRule) return;
    track({ kind: "reconcile_shown", meta: { rule_id: reconcileRule } });
  }, [reconcileId, reconcileRule, track]);
  const flagged = new Set(state?.findings.flatMap((f) => f.question_ids) ?? []);

  // One record column; lines append downward, newest last (§4.2), and
  // the list keeps the newest line in view as it arrives.
  const restated = justRecorded ? factLine(justRecorded) : null;
  const earlier = chips.length === 0 && (state?.progress.core_done ?? 0) > 0;
  const tally = tallyText(sessionTally(chips));

  const reopen = (id: string, r: string): void => void handleReopen(id, r);

  return (
    <div className="shell intake">
      <TopBar progress={state?.progress ?? null} />
      {resumeNotice && (
        <div className="intake-notice">
          <p className="resume-note">{resumeNotice}</p>
        </div>
      )}
      <main className="stage">
        <section className="centre" aria-live="polite" aria-label="Current question">
          {phase === "boot_error" && (
            <div className="card">
              <h2 className="prompt">I couldn&rsquo;t reach the server.</h2>
              <p className="help">
                Nothing was lost. Try again and I&rsquo;ll pick up where we left off.
              </p>
              <div className="row">
                <button type="button" className="next" onClick={() => void boot()}>
                  Try again &rarr;
                </button>
              </div>
            </div>
          )}
          {justRecorded && restated && phase === "answering" && (
            <p className="last-rec" key={justRecorded.question_id}>
              <span className="label">
                {restated.flag} <span className="fig">{restated.ref}</span>
              </span>{" "}
              <span className="last-rec-q">{justRecorded.prompt}</span>{" "}
              <span className="last-rec-a">{restated.value}</span>{" "}
              <span className="label last-rec-src">{restated.source}</span>
            </p>
          )}
          {state?.done && state.readout && <DoneCard readout={state.readout} />}
          {!state?.done && question && (
            <QuestionCard
              key={question.id}
              question={question}
              leaving={phase === "leaving"}
              serverError={serverError}
              onAnswer={handleAnswer}
              onEntityRows={handleEntityRows}
              onClearError={clearServerError}
              onFirstInput={handleFirstInput}
            />
          )}
          {reconcile && (
            <ReconcilePanel
              finding={reconcile}
              busy={reconcileBusy}
              onChoose={(choice) => void handleReconcile(reconcile.id, choice)}
            />
          )}
          {!state?.done && state?.on_deck && <OnDeck text={state.on_deck} />}
        </section>

        <section className="rec-col" aria-labelledby="rec-col-head">
          <div className="col-head">
            <h2 id="rec-col-head" className="label">
              The record
            </h2>
            {chips.length > 0 && <span className="fig rec-tally">{tally}</span>}
          </div>
          {chips.length === 0 && (
            <p className="rec-empty">
              {earlier ? (
                <>
                  Answers from an earlier session are on <a href="/profile">the fact sheet</a>. New
                  answers land here with their source.
                </>
              ) : (
                "Nothing recorded yet. Each answer lands here with its source and basis."
              )}
            </p>
          )}
          {chips.length > 0 && (
            <RecordList chips={chips} latest={justRecorded} flagged={flagged} onReopen={reopen} />
          )}
        </section>

        {/* P0-76: below 900px the column is gone; the record collapses
            into a strip under the card that expands on tap. */}
        {chips.length > 0 && (
          <section className="recorded-strip" aria-label="The record">
            <button
              type="button"
              className="strip-toggle"
              aria-expanded={stripOpen}
              onClick={() => setStripOpen((v) => !v)}
            >
              <span className="label">{stripOpen ? "Hide the record" : "Show the record"}</span>
              <span className="fig">{tally}</span>
            </button>
            {stripOpen && (
              <RecordList
                chips={chips}
                latest={justRecorded}
                flagged={flagged}
                onReopen={reopen}
                className="strip-list"
              />
            )}
          </section>
        )}
      </main>
    </div>
  );
}

/** The record as an ordered list; keeps its newest line in view. */
function RecordList({
  chips,
  latest,
  flagged,
  onReopen,
  className = "rec-list",
}: {
  chips: readonly IntakeChip[];
  latest: IntakeChip | null;
  flagged: ReadonlySet<string>;
  onReopen: (questionId: string, reason: string) => void;
  className?: string;
}) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const list = ref.current;
    // An instant jump, never a smooth scroll (§2 motion: cut).
    if (list) list.scrollTop = list.scrollHeight;
  }, [chips.length]);
  return (
    <ol className={className} ref={ref}>
      {chips.map((chip) => (
        <li key={chip.question_id}>
          <Chip
            chip={chip}
            flagged={flagged.has(chip.question_id)}
            fresh={chip === latest}
            onReopen={onReopen}
          />
        </li>
      ))}
    </ol>
  );
}
