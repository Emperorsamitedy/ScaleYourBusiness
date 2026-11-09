"use client";

// The intake — the signature screen (specs/ux-spec-v1.md §4), laid out as
// the owner's design intake-v2: masthead; the channel bank (one tile per
// area, one bar per question); the question panel on the left; three paper
// cards on the right (live reading, report readiness, the area's record);
// the tape along the bottom. Every figure on screen is the server's
// (lib/intake/service.ts): area bars and status, the record, readiness,
// the derived figure, the business name. The client orchestrates and
// re-words; it decides nothing about a question's content (rule 4).
//
// The motion reports state (P0-60, §2):
//   answering → (submit) → leaving (the sheet departs on --d-record; the
//   PUT rides inside it) → the new row lands in the record with the
//   marker (--d-record) → the next question rises (--d-move).
// The JS depart wait reads the same --d-record token the CSS runs on, so
// the two agree; under prefers-reduced-motion both are zero.
//
// First paint is skeleton-free: the shell renders immediately and the
// first question rises when state arrives from a single POST on mount.
//
// Decluttered 2026-11-09 on the owner's instruction: captions that restate
// a heading are gone, and explanations (the pause and done ledes, the boot
// error's reason, the question's purpose, how a figure was worked out) sit
// behind one closed "How this works" / "Why?" per card (.ix-how).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  AnswerAction,
  AnswerResponse,
  IntakeState,
  ReconcileResponse,
} from "@/lib/intake/types";
import "@/app/intake.css";
import { AreaTiles } from "./AreaTiles";
import { KeepAccess } from "./KeepAccess";
import { LiveReading, Readiness } from "./LiveReading";
import { Masthead } from "./Masthead";
import { departMs } from "./motion";
import { QuestionCard } from "./QuestionCard";
import { ReconcilePanel } from "./ReconcilePanel";
import { RecordSheet } from "./RecordSheet";
import { Tape } from "./Tape";
import {
  areaName,
  channelNo,
  connectorLegend,
  factLabel,
  factValue,
  leftInArea,
  previousQuestion,
} from "./record";
import { num } from "../sheet/num";
import { INTAKE_ERROR_CODES, useIntakeWords } from "./words";

type Phase = "boot" | "boot_error" | "answering" | "leaving";

/** The closing readout renders completeness as a word, never a percentage. */
const completenessWord = (overall: number): "good" | "moderate" =>
  overall >= 0.7 ? "good" : "moderate";

/** A refusal from the intake routes: its code worded in the person's language (L-2). */
interface ErrorPayload {
  error?: string;
  code?: string;
  values?: Record<string, string | number>;
}

function DoneCard({ readout }: { readout: NonNullable<IntakeState["readout"]> }) {
  const t = useTranslations("intake.done");
  const tHow = useTranslations("intake");
  const { locale } = useIntakeWords();
  return (
    <article className="ix-q sheet ix-done" aria-labelledby="ix-done-h">
      <h2 className="ix-prompt" id="ix-done-h">
        {t("title")}
      </h2>
      <dl className="ix-readout">
        <dt className="ix-cap">{t("answers")}</dt>
        <dd className="fig">{num(readout.answered, 0, locale)}</dd>
        <dt className="ix-cap">{t("gaps")}</dt>
        <dd className="fig">{num(readout.gaps, 0, locale)}</dd>
        <dt className="ix-cap">{t("completeness")}</dt>
        <dd>{t(completenessWord(readout.completeness))}</dd>
        <dt className="ix-cap">{t("next")}</dt>
        <dd>{t("nextValue")}</dd>
      </dl>
      <KeepAccess />
      <details className="ix-how">
        <summary>{tHow("how")}</summary>
        <p>{t("lede")}</p>
        <p>{t("keep")}</p>
      </details>
    </article>
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
  const [phase, setPhase] = useState<Phase>("boot");
  const [serverError, setServerError] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  // The area the owner chose on the tile row; cleared when it runs dry.
  const [focusSection, setFocusSection] = useState<string | null>(null);
  // The record row just laid down — it carries the marker.
  const [freshKey, setFreshKey] = useState<string | null>(null);
  // What a screen reader hears after a record.
  const [announce, setAnnounce] = useState("");
  const booted = useRef(false);
  // Requests in flight — the masthead says "Saving…" only while one is.
  const [inFlight, setInFlight] = useState(0);
  const begin = useCallback(() => setInFlight((n) => n + 1), []);
  const end = useCallback(() => setInFlight((n) => Math.max(0, n - 1)), []);
  const [pauseOpen, setPauseOpen] = useState(false);
  const t = useTranslations("intake");
  const { tr, locale } = useIntakeWords();
  // The words are read inside callbacks; a ref keeps them current without re-creating every callback.
  const words = useRef({ tr, locale });
  words.current = { tr, locale };
  /** A server refusal in the person's language: its code when the catalogue has it. */
  const refusal = useCallback((payload: ErrorPayload | null, fallback: string): string => {
    const w = words.current.tr;
    const code = payload?.code;
    if (!code || !INTAKE_ERROR_CODES.has(code)) return w(fallback);
    const values = payload?.values ?? {};
    const problem = w(`error.${code}`, values);
    return typeof values.field === "string"
      ? w("error.field", { field: values.field, problem })
      : problem;
  }, []);

  // P1-57: arriving from a resume link. An expired link still lands here
  // with a usable intake rather than an apology page.
  useEffect(() => {
    const flag = new URLSearchParams(window.location.search).get("resume");
    if (flag === "ok") setResumeNotice(words.current.tr("stage.resumed"));
    if (flag === "expired") setResumeNotice(words.current.tr("stage.expired"));
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

  /** Take a new state; an area focus ends once the area has nothing left to ask. */
  const adopt = useCallback((next: IntakeState, focus: string | null): void => {
    setState(next);
    setFocusSection(focus !== null && next.question?.section === focus ? focus : null);
  }, []);

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
      adopt(next, null);
      setPhase("answering");
      if (next.progress.core_done > 0) track({ kind: "session_resumed" });
    } catch {
      setPhase("boot_error");
    }
  }, [adopt, track]);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void boot();
  }, [boot]);

  const submit = useCallback(
    async (method: "PUT" | "PATCH", body: Record<string, unknown>): Promise<void> => {
      setServerError(null);
      setPhase("leaving");
      begin();
      // Network latency hides inside the depart animation (§4.2).
      const departed = new Promise((resolve) => setTimeout(resolve, departMs()));
      try {
        const res = await fetch("/api/intake", {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(focusSection ? { ...body, section: focusSection } : body),
        });
        await departed;
        if (res.ok) {
          const { chip, state: next } = (await res.json()) as AnswerResponse;
          void chip;
          const newest = next.record.facts[0] ?? null;
          setFreshKey(newest?.key ?? null);
          const w = words.current;
          setAnnounce(
            newest
              ? w.tr("stage.recorded", {
                  label: factLabel(newest),
                  value: factValue(newest, w.tr, w.locale).full,
                })
              : w.tr("stage.recordedPlain"),
          );
          adopt(next, focusSection);
          setPhase("answering");
        } else {
          const payload = (await res.json().catch(() => null)) as ErrorPayload | null;
          setPhase("answering");
          setServerError(refusal(payload, "error.server"));
        }
      } catch {
        await departed;
        setPhase("answering");
        setServerError(words.current.tr("error.unreachable"));
      } finally {
        end();
      }
    },
    [adopt, begin, end, focusSection, refusal],
  );

  /** Read a state with a preference: an area from the tiles, or one question. */
  const steer = useCallback(
    async (query: string, focus: string | null): Promise<void> => {
      setServerError(null);
      begin();
      try {
        const res = await fetch(`/api/intake?${query}`);
        if (!res.ok) {
          setServerError(words.current.tr("error.open"));
          return;
        }
        adopt((await res.json()) as IntakeState, focus);
        setPhase("answering");
      } catch {
        setServerError(words.current.tr("error.unreachable"));
      } finally {
        end();
      }
    },
    [adopt, begin, end],
  );

  const chooseArea = useCallback(
    (section: string): void => {
      if (phase !== "answering") return;
      void steer(`section=${encodeURIComponent(section)}`, section);
    },
    [phase, steer],
  );

  const askQuestion = useCallback(
    (questionId: string): void => {
      void steer(`ask=${encodeURIComponent(questionId)}`, null);
    },
    [steer],
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

  // P0-75: a record row's change returns its question to the left; the
  // old value stays in history and the reason is recorded.
  const handleReopen = useCallback(
    async (questionId: string, reason: string): Promise<void> => {
      setServerError(null);
      begin();
      try {
        const res = await fetch("/api/intake", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question_id: questionId, action: { kind: "reopen", reason } }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as ErrorPayload | null;
          setServerError(refusal(payload, "error.reopen"));
          return;
        }
        const { state: next } = (await res.json()) as AnswerResponse;
        track({ kind: "reopened", question_id: questionId });
        setFreshKey(null);
        setAnnounce(words.current.tr("stage.reopened"));
        adopt(next, null);
        setPhase("answering");
      } catch {
        setServerError(words.current.tr("error.unreachable"));
      } finally {
        end();
      }
    },
    [adopt, begin, end, track, refusal],
  );

  const clearServerError = useCallback((): void => {
    setServerError(null);
  }, []);

  // §4.5: the two resolution paths. "fix" returns the involved questions
  // to the left in sequence.
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const handleReconcile = useCallback(
    async (findingId: string, choice: "confirm" | "fix"): Promise<void> => {
      setReconcileBusy(true);
      setServerError(null);
      begin();
      try {
        const res = await fetch("/api/intake/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ finding_id: findingId, choice }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as ErrorPayload | null;
          setServerError(refusal(payload, "error.record"));
          return;
        }
        const { reopened, state: next } = (await res.json()) as ReconcileResponse;
        track({ kind: "reconcile_resolved", meta: { choice, reopened: reopened.length } });
        if (reopened.length > 0) setFreshKey(null);
        adopt(next, null);
        setPhase("answering");
      } catch {
        setServerError(words.current.tr("error.unreachable"));
      } finally {
        setReconcileBusy(false);
        end();
      }
    },
    [adopt, begin, end, track, refusal],
  );

  // The panel surfaces contradictions and implausibilities; plain gaps
  // stay gaps in the record. Involved rows are flagged in words.
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

  const areas = state?.areas ?? [];
  const activeSection = state?.done ? null : (question?.section ?? null);
  const activeIndex = areas.findIndex((a) => a.section === activeSection);
  const activeArea = activeIndex >= 0 ? areas[activeIndex] : undefined;
  const channel = activeIndex >= 0 ? channelNo(activeIndex) : null;
  const previous = state ? previousQuestion(state.record.facts, question?.id ?? null) : null;
  const saving = phase !== "boot_error" && (inFlight > 0 || phase === "leaving");

  return (
    <div className="ix desk">
      <Masthead
        businessName={state?.business_name ?? null}
        saving={saving}
        factCount={state ? state.record.fact_count : null}
        pauseOpen={pauseOpen}
        onPause={() => setPauseOpen((v) => !v)}
      />
      {pauseOpen && (
        <section id="ix-pause-panel" className="ix-pause-panel sheet" aria-labelledby="ix-pause-h">
          <div>
            <h2 className="ix-cap" id="ix-pause-h">
              {t("pause.title")}
            </h2>
            <details className="ix-how">
              <summary>{t("how")}</summary>
              <p>{t("pause.lede")}</p>
            </details>
          </div>
          <KeepAccess />
          <button type="button" className="ix-link" onClick={() => setPauseOpen(false)}>
            {t("pause.keepGoing")}
          </button>
        </section>
      )}
      {state && (
        <AreaTiles
          areas={areas}
          active={activeSection}
          busy={phase !== "answering"}
          connector={connectorLegend(state.record.sources, tr)}
          onChoose={chooseArea}
        />
      )}
      {resumeNotice && <p className="ix-notice">{resumeNotice}</p>}
      {focusSection && question && (
        <p className="ix-notice">
          {t("stage.focus", { area: areaName(focusSection, tr) })}{" "}
          <button type="button" className="ix-link" onClick={() => setFocusSection(null)}>
            {t("stage.focusBack")}
          </button>
        </p>
      )}
      <main className="ix-main">
        <div className="ix-left" aria-live="polite" aria-label={t("stage.current")}>
          {phase === "boot_error" && (
            <article className="ix-q sheet ix-plain">
              <h2 className="ix-prompt">{t("stage.bootTitle")}</h2>
              <div className="ix-actions">
                <button type="button" className="act solid" onClick={() => void boot()}>
                  {t("stage.retry")} &rarr;
                </button>
              </div>
              <details className="ix-how">
                <summary>{t("why")}</summary>
                <p>{t("stage.bootLede")}</p>
              </details>
            </article>
          )}
          {state?.done && state.readout && <DoneCard readout={state.readout} />}
          {!state?.done && question && (
            <QuestionCard
              key={question.id}
              question={question}
              channel={channel}
              left={activeArea ? leftInArea(activeArea) : 0}
              previous={previous}
              leaving={phase === "leaving"}
              serverError={serverError}
              onAnswer={handleAnswer}
              onEntityRows={handleEntityRows}
              onBack={(id) => void handleReopen(id, `went back to it from question ${question.id}`)}
              onClearError={clearServerError}
              onFirstInput={handleFirstInput}
            />
          )}
          {(state?.done || !question) && serverError && (
            <p className="ix-err ix-err-desk" role="alert">
              {serverError}
            </p>
          )}
          {reconcile && (
            <ReconcilePanel
              finding={reconcile}
              busy={reconcileBusy}
              onChoose={(choice) => void handleReconcile(reconcile.id, choice)}
            />
          )}
        </div>
        {state && (
          <aside className="ix-right" aria-label={t("stage.record")}>
            {state.live_reading && <LiveReading reading={state.live_reading} />}
            <Readiness fraction={state.readiness} />
            {state.area_record && (
              <RecordSheet
                area={state.area_record}
                channel={channel}
                unlocks={question?.unlocks ?? []}
                freshKey={freshKey}
                flagged={flagged}
                onReopen={(id, reason) => void handleReopen(id, reason)}
                onAsk={askQuestion}
              />
            )}
          </aside>
        )}
      </main>
      {state && <Tape facts={state.record.facts} />}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
