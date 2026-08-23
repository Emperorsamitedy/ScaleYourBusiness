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
    </div>
  );
}

export function IntakeStage() {
  const [state, setState] = useState<IntakeState | null>(null);
  const [chips, setChips] = useState<readonly IntakeChip[]>([]);
  const [phase, setPhase] = useState<Phase>("boot");
  const [serverError, setServerError] = useState<string | null>(null);
  const [stripOpen, setStripOpen] = useState(false);
  const booted = useRef(false);

  const boot = useCallback(async (): Promise<void> => {
    setPhase("boot");
    try {
      const res = await fetch("/api/intake", { method: "POST" });
      if (!res.ok) throw new Error(`intake boot ${res.status}`);
      const next = (await res.json()) as IntakeState;
      setState(next);
      setPhase("answering");
    } catch {
      setPhase("boot_error");
    }
  }, []);

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

  const handleAnswer = useCallback(
    (action: AnswerAction): void => {
      if (phase !== "answering" || !question) return;
      void submit("PUT", { question_id: question.id, action });
    },
    [phase, question, submit],
  );

  const handleEntityRows = useCallback(
    (rows: Record<string, unknown>[]): void => {
      if (phase !== "answering" || !question) return;
      void submit("PATCH", { question_id: question.id, rows });
    },
    [phase, question, submit],
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
      setChips((prev) => prev.filter((c) => c.question_id !== questionId));
      setState(next);
      setPhase("answering");
    } catch {
      setServerError("I couldn't reach the server — check your connection and try again.");
    }
  }, []);

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
    [],
  );

  // The panel surfaces contradictions and implausibilities; plain gaps
  // stay as hollow dots. Involved chips take the ember hairline.
  const reconcile =
    state?.findings.find((f) => f.kind === "contradiction" || f.kind === "implausible") ?? null;
  const flagged = new Set(state?.findings.flatMap((f) => f.question_ids) ?? []);

  // Columns alternate left, right, left; chips append downward (§4.2).
  const left = chips.filter((_, i) => i % 2 === 0);
  const right = chips.filter((_, i) => i % 2 === 1);

  return (
    <div className="shell">
      <TopBar progress={state?.progress ?? null} />
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
