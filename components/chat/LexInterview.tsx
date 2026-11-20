"use client";

// The interview with Lex (the owner's fourth round, 2026-11-20): the same
// questions as the form at /intake, asked one at a time in the conversation.
// A choice is a button; a name, a figure or an amount is typed in a small
// box under the question; "I don't know" and "Skip for now" are real
// answers here as they are there (rule 5).
//
// It talks to the interview's own API and to nothing else: POST /api/intake
// for where the interview stands, PUT /api/intake for each answer. Which
// question comes next is the resolver's decision over the bank (rule 4), the
// fact is recorded by the same service with the same source, and no model
// is called. A date, a table of rows and a file are answered on the form,
// which has the control for them: Lex says so and gives the way there.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { intlTag } from "../../lib/i18n/locales";
import type { AnswerAction, AnswerResponse, IntakeState } from "../../lib/intake/types";
import { areaName, channelNo, leftInArea } from "../intake/record";
import { Fold } from "../sheet/Fold";
import { useTr } from "../sheet/useTr";
import { Speaker } from "./ChatTurn";
import type { Exchange } from "./interview-model";
import { answerKind, answerWords, choicesOf, pickedAnswer, typedAnswer } from "./interview-model";

export function LexInterview({ onStop }: { onStop: () => void }) {
  const { tr, locale } = useTr("chat");
  const { tr: it } = useTr("intake");
  const { tr: nav } = useTr("nav");
  const [state, setState] = useState<IntakeState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<Exchange[]>([]);
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  // Where the interview stands: the question the resolver has next.
  useEffect(() => {
    let alive = true;
    fetch("/api/intake", { method: "POST" })
      .then((r) => (r.ok ? (r.json() as Promise<IntakeState>) : Promise.reject(new Error("no"))))
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        if (alive) setFailed(it("error.open"));
      });
    return () => {
      alive = false;
    };
  }, [it]);

  const question = state?.question ?? null;
  const id = question?.id ?? null;
  // A new question starts with nothing typed and nothing picked.
  useEffect(() => {
    setTyped("");
    setPicked([]);
    setHint(null);
  }, [id]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [id, past.length]);

  const answer = useCallback(
    async (action: AnswerAction, said: string) => {
      if (!question || busy) return;
      setBusy(true);
      setFailed(null);
      try {
        const res = await fetch("/api/intake", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question_id: question.id, action }),
        });
        if (!res.ok) {
          setFailed(it("error.record"));
          return;
        }
        const next = (await res.json()) as AnswerResponse;
        setPast((p) => [...p, { id: question.id, prompt: question.prompt, answer: said }]);
        setState(next.state);
      } catch {
        setFailed(it("error.unreachable"));
      } finally {
        setBusy(false);
      }
    },
    [question, busy, it],
  );

  const kind = question ? answerKind(question) : null;
  const choices = question
    ? choicesOf(question, { yes: it("question.yes"), no: it("question.no") })
    : [];
  const said = { unknown: it("question.unknown"), skipped: it("question.skip") };
  const send = (action: AnswerAction) =>
    void answer(action, answerWords(action, choices, typed, said));

  const submitTyped = () => {
    if (!kind) return;
    const read = typedAnswer(kind, typed);
    if (read.ok) {
      send(read.action);
      return;
    }
    if (read.reason === "unclear") {
      // An amount written the reader's way with no mark for thousands (rule 3
      // of the catalogue: the figure is formatted here, never typed into a message).
      const example = new Intl.NumberFormat(intlTag(locale), {
        useGrouping: false,
        minimumFractionDigits: 2,
      }).format(1200.5);
      setHint(tr("interview.unclear", { example }));
      return;
    }
    setHint(it("question.emptySkip"));
  };

  const area = state && question ? state.areas.find((a) => a.section === question.section) : null;
  const areaIndex = state && area ? state.areas.indexOf(area) : -1;

  return (
    <div className="lxi" aria-live="polite">
      <p className="lxi-intro">{tr("interview.intro")}</p>

      {past.map((x) => (
        <div className="lxi-past" key={`${x.id}-${x.answer}`}>
          <p className="lxi-past-q">{x.prompt}</p>
          <p className="lxi-past-a">{x.answer}</p>
        </div>
      ))}

      {state === null && failed === null && <p className="lx-note">{tr("loading")}</p>}

      {state?.done && (
        <div className="lxi-card">
          <p className="ak-who">
            <Speaker />
          </p>
          <p className="lxi-prompt">{it("done.title")}</p>
          <p className="lxi-meta">{it("done.lede")}</p>
          <p className="lxi-row">
            <Link className="act solid" href="/profile">
              {nav("item.factsheet")}
            </Link>
          </p>
        </div>
      )}

      {question && kind && (
        <div className="lxi-card" aria-busy={busy}>
          <p className="ak-who">
            <Speaker live={busy} />
            {area && areaIndex >= 0 && (
              <span className="ak-at">
                {it("record.channelTitle", {
                  channel: channelNo(areaIndex),
                  area: areaName(area.section, it),
                })}
                {" · "}
                {tr("interview.left", { count: leftInArea(area) })}
              </span>
            )}
          </p>
          <p className="lxi-prompt">{question.prompt}</p>
          {question.help && (
            <Fold label="why" className="lxi-why">
              <p>{question.help}</p>
            </Fold>
          )}

          {kind === "choice" && (
            <div className="lxi-opts">
              {choices.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="ak-chip"
                  disabled={busy}
                  onClick={() => send({ kind: "value", wire: c.wire })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {kind === "many" && (
            <>
              <div className="lxi-opts">
                {choices.map((c) => {
                  const on = picked.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={on ? "ak-chip on" : "ak-chip"}
                      aria-pressed={on}
                      disabled={busy}
                      onClick={() =>
                        setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]))
                      }
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
              <p className="lxi-row">
                <button
                  type="button"
                  className="act solid"
                  disabled={busy || picked.length === 0}
                  onClick={() => {
                    const action = pickedAnswer(picked);
                    if (action) send(action);
                  }}
                >
                  {it("question.next")}
                </button>
              </p>
            </>
          )}

          {(kind === "words" || kind === "figure" || kind === "amount") && (
            <form
              className="lxi-typed"
              onSubmit={(e) => {
                e.preventDefault();
                submitTyped();
              }}
            >
              <label className="sr-only" htmlFor="lxi-field">
                {question.prompt}
              </label>
              {question.input_type === "long_text" ? (
                <textarea
                  id="lxi-field"
                  className="lxi-field"
                  rows={3}
                  value={typed}
                  disabled={busy}
                  onChange={(e) => setTyped(e.target.value)}
                />
              ) : (
                <input
                  id="lxi-field"
                  className="lxi-field"
                  type="text"
                  inputMode={kind === "words" ? "text" : "decimal"}
                  autoComplete="off"
                  value={typed}
                  disabled={busy}
                  onChange={(e) => setTyped(e.target.value)}
                />
              )}
              {kind === "amount" && <span className="lxi-unit">{question.currency}</span>}
              <button type="submit" className="act solid" disabled={busy}>
                {it("question.next")}
              </button>
            </form>
          )}

          {kind === "form" && (
            <p className="lxi-row">
              <span className="lxi-meta">{tr("interview.onForm")}</span>
              <Link className="act" href={`/intake?ask=${encodeURIComponent(question.id)}`}>
                {tr("interview.openForm")}
              </Link>
            </p>
          )}

          {hint !== null && (
            <p className="lxi-hint" role="alert">
              {hint}
            </p>
          )}
          {failed !== null && (
            <p className="lxi-hint" role="alert">
              {failed}
            </p>
          )}

          <p className="lxi-row lxi-quiet">
            {question.allow_unknown && (
              <button
                type="button"
                className="lxi-link"
                disabled={busy}
                onClick={() => send({ kind: "unknown" })}
              >
                {it("question.unknown")}
              </button>
            )}
            <button
              type="button"
              className="lxi-link"
              disabled={busy}
              onClick={() => send({ kind: "skip" })}
            >
              {it("question.skip")}
            </button>
            <button type="button" className="lxi-link" disabled={busy} onClick={onStop}>
              {tr("interview.stop")}
            </button>
          </p>
        </div>
      )}

      {state === null && failed !== null && (
        <p className="lxi-hint" role="alert">
          {failed}
        </p>
      )}
      <div ref={end} />
    </div>
  );
}
