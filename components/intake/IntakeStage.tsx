"use client";

// The intake stage — client orchestrator for the signature screen
// (specs/ux-spec-v1.md §4). The motion IS the product (P0-60):
//
//   answering → (submit) → leaving (card departs, ~240ms; the PUT rides
//   inside the animation) → chip settles into the alternating column
//   (340ms) → next card rises (380ms) → answering.
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
import { Chip } from "./Chip";
import { OnDeck } from "./OnDeck";
import { QuestionCard } from "./QuestionCard";
import { ReconcilePanel } from "./ReconcilePanel";
import { TopBar } from "./TopBar";

type Phase = "boot" | "boot_error" | "answering" | "leaving";

const DEPART_MS = 240;

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
        setError(payload.error ?? "That didn't work — try again.");
        return;
      }
      setLink(payload.url ?? null);
    } catch {
      setError("I couldn't reach the server — check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (link) {
    return (
      <div className="linkbox">
        <strong>Keep this link.</strong> It reopens your profile on any device for the next 30
        days. Mail it to yourself now.
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
        {busy ? "One moment" : "Get my link"}
      </button>
      {error && <p className="err">{error}</p>}
    </form>
  );
}

function DoneCard({ readout }: { readout: NonNullable<IntakeState["readout"]> }) {
  return (
    <div className="card done">
      <h2>That&rsquo;s enough to start.</h2>
      <p>
        I have what I need for a first read on the business. I&rsquo;ll keep asking as I go — the
        deeper questions are easier to answer once you&rsquo;ve seen what I do with these.
      </p>
      <div className="readout">
        answered&nbsp;&nbsp;<strong>{readout.answered}</strong>
        <br />
        gaps to revisit&nbsp;&nbsp;<strong>{readout.gaps}</strong>
        <br />
        profile confidence&nbsp;&nbsp;<strong>{completenessWord(readout.completeness)}</strong>
        <br />
        next&nbsp;&nbsp;<strong>deciding how carefully to move</strong>
      </div>
      <p className="help" style={{ marginTop: 22, marginBottom: 0 }}>
        Leave an email and I&rsquo;ll give you a link back to this — no password, no account.
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
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const booted = useRef(false);

  // P1-57: arriving from a resume link. An expired link still lands here
  // with a usable intake rather than an apology page.
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("resume");
    if (flag === "ok") setResumeNotice("Welcome back — picking up where you left off.");
    if (flag === "expired") {
      setResumeNotice(
        "That link has expired, so this is a fresh start. You can get a new link at the end.",
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
      const next = (await res.json()) as IntakeState;
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
      const departed = new Promise((resolve) => setTimeout(resolve, DEPART_MS));
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
          setState(next);
          setPhase("answering");
        } else {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setPhase("answering");
          setServerError(payload?.error ?? "Something went wrong on our side — try again.");
        }
      } catch {
        await departed;
        setPhase("answering");
        setServerError("I couldn't reach the server — check your connection and try again.");
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
  const handleReopen = useCallback(async (questionId: string, reason: string): Promise<void> => {
    setServerError(null);
    try {
      const res = await fetch("/api/intake", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question_id: questionId, action: { kind: "reopen", reason } }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setServerError(payload?.error ?? "I couldn't reopen that — try again.");
        return;
      }
      const { state: next } = (await res.json()) as AnswerResponse;
      track({ kind: "reopened", question_id: questionId });
      setChips((prev) => prev.filter((c) => c.question_id !== questionId));
      setState(next);
      setPhase("answering");
    } catch {
      setServerError("I couldn't reach the server — check your connection and try again.");
    }
  }, [track]);

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
          setServerError(payload?.error ?? "I couldn't record that — try again.");
          return;
        }
        const { reopened, state: next } = (await res.json()) as ReconcileResponse;
        track({ kind: "reconcile_resolved", meta: { choice, reopened: reopened.length } });
        if (reopened.length > 0) {
          setChips((prev) => prev.filter((c) => !reopened.includes(c.question_id)));
        }
        setState(next);
        setPhase("answering");
      } catch {
        setServerError("I couldn't reach the server — check your connection and try again.");
      } finally {
        setReconcileBusy(false);
      }
    },
    [track],
  );

  // The panel surfaces contradictions and implausibilities; plain gaps
  // stay as hollow dots. Involved chips take the ember hairline.
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

  // Columns alternate left, right, left; chips append downward (§4.2).
  const left = chips.filter((_, i) => i % 2 === 0);
  const right = chips.filter((_, i) => i % 2 === 1);

  return (
    <div className="shell">
      <TopBar progress={state?.progress ?? null} />
      {resumeNotice && (
        <div className="stage" style={{ paddingBottom: 0, paddingTop: 18 }}>
          <div />
          <div className="resume-note">{resumeNotice}</div>
          <div />
        </div>
      )}
      <main className="stage">
        <section className="col" aria-label="Recorded answers, left column">
          <div className="col-head">Recorded</div>
          {left.map((chip) => (
            <Chip
              key={chip.question_id}
              chip={chip}
              flagged={flagged.has(chip.question_id)}
              onReopen={(id, r) => void handleReopen(id, r)}
            />
          ))}
        </section>

        <section className="centre" aria-live="polite">
          {phase === "boot_error" && (
            <div className="card">
              <h2 className="prompt">I couldn&rsquo;t reach the server.</h2>
              <p className="help">
                Nothing was lost. Try again and I&rsquo;ll pick up where we left off.
              </p>
              <div className="row">
                <button type="button" className="next" onClick={() => void boot()}>
                  Try again
                </button>
              </div>
            </div>
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

        <section className="col" aria-label="Recorded answers, right column">
          <div className="col-head">Recorded</div>
          {right.map((chip) => (
            <Chip
              key={chip.question_id}
              chip={chip}
              flagged={flagged.has(chip.question_id)}
              onReopen={(id, r) => void handleReopen(id, r)}
            />
          ))}
        </section>

        {/* P0-76: below 900px the columns are gone; answers collapse into
            a pinned "Recorded (n)" strip that expands on tap. */}
        {chips.length > 0 && (
          <section className="recorded-strip" aria-label="Recorded answers">
            <button
              type="button"
              className="strip-toggle"
              aria-expanded={stripOpen}
              onClick={() => setStripOpen((v) => !v)}
            >
              Recorded ({chips.length})
            </button>
            {stripOpen && (
              <div className="strip-list">
                {chips.map((chip) => (
                  <Chip
                    key={chip.question_id}
                    chip={chip}
                    onReopen={(id, r) => void handleReopen(id, r)}
                  />
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
