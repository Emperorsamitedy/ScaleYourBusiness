"use client";

// The centre card — eyebrow (mono id + tier), display prompt, help,
// control slot, action row (P0-61). Validation is inline and specific;
// errors never modal, never apologise, clear on next input (§4.2).
//
// Key hints are words in mono, never glyphs. A money question prints its
// bank help text as a mono PURPOSE note — only text the bank already
// carries; nothing is written per question here (rule 4).

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AnswerAction, IntakeQuestion } from "@/lib/intake/types";
import type { ControlChange } from "./controls/shared";
import { keyHint } from "./record";
import { BooleanControl } from "./controls/Boolean";
import { DateControl } from "./controls/DateInput";
import { EntityListControl } from "./controls/EntityList";
import type { EntityRow } from "./controls/EntityList";
import { FileStubControl } from "./controls/FileStub";
import { LongTextControl } from "./controls/LongText";
import { MoneyControl } from "./controls/Money";
import { MultiSelectControl } from "./controls/MultiSelect";
import { NumberControl } from "./controls/Number";
import { SingleSelectControl } from "./controls/SingleSelect";
import { TextControl } from "./controls/Text";

interface QuestionCardProps {
  question: IntakeQuestion;
  leaving: boolean;
  serverError: string | null;
  onAnswer: (action: AnswerAction) => void;
  onEntityRows: (rows: EntityRow[]) => void;
  onClearError: () => void;
  /** P0-87: first interaction with the control — the hesitation mark. */
  onFirstInput?: () => void;
}

export function QuestionCard({
  question,
  leaving,
  serverError,
  onAnswer,
  onEntityRows,
  onClearError,
  onFirstInput,
}: QuestionCardProps) {
  const [draft, setDraft] = useState<ControlChange>({ wire: null });
  const [entityRows, setEntityRows] = useState<EntityRow[] | null>(null);
  const [entityValid, setEntityValid] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [isMac, setIsMac] = useState(false);

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setIsMac(true);
  }, []);

  const emptyMessage = question.allow_unknown
    ? "Answer this, or choose “I don't know” to move on."
    : "Answer this, or choose “Skip for now” to move on.";

  const handleChange = (change: ControlChange): void => {
    onFirstInput?.();
    setDraft(change);
    setLocalError(null);
    onClearError();
  };

  const record = (change: ControlChange): void => {
    if (leaving) return;
    if (question.input_type === "entity_list") {
      if (!entityValid || !entityRows) {
        setLocalError("Fill in at least the first field of one row to record.");
        return;
      }
      onEntityRows(entityRows);
      return;
    }
    if (change.wire === null || change.wire === undefined) {
      setLocalError(emptyMessage);
      return;
    }
    onAnswer(
      change.estimate === true
        ? { kind: "value", wire: change.wire, estimate: true }
        : { kind: "value", wire: change.wire },
    );
  };

  const control = ((): ReactNode => {
    const props = { question, onChange: handleChange, onCommit: record };
    switch (question.input_type) {
      case "text":
        return <TextControl {...props} />;
      case "long_text":
        return <LongTextControl {...props} />;
      case "number":
        return <NumberControl {...props} />;
      case "money":
        return <MoneyControl {...props} />;
      case "boolean":
        return <BooleanControl {...props} />;
      case "date":
        return <DateControl {...props} />;
      case "single_select":
        return <SingleSelectControl {...props} />;
      case "multi_select":
        return <MultiSelectControl {...props} />;
      case "entity_list":
        return (
          <EntityListControl
            question={question}
            onRowsChange={(rows) => {
              setEntityRows(rows);
              setEntityValid(rows.length > 0);
              setLocalError(null);
              onClearError();
            }}
            onRequestSubmit={() => record(draft)}
          />
        );
      case "file":
        return <FileStubControl question={question} />;
    }
  })();

  const error = serverError ?? localError;
  const hint = keyHint(question.input_type, isMac);
  const isMoney = question.input_type === "money";
  const showRecord = question.input_type !== "file";

  return (
    <div className={leaving ? "card leaving" : "card"}>
      <div className="eyebrow label">
        <span className="fig">{question.id}</span>
        <span className="tier">{question.priority}</span>
      </div>
      <h2 className="prompt" id={`q-${question.id}`}>
        {question.prompt}
      </h2>
      {question.help &&
        (isMoney ? (
          <p className="help purpose">
            <span className="label">Purpose:</span> {question.help}
          </p>
        ) : (
          <p className="help">{question.help}</p>
        ))}
      <div>{control}</div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        {showRecord && (
          <button
            type="button"
            className="next"
            disabled={
              leaving ||
              (question.input_type === "entity_list"
                ? !entityValid
                : draft.wire === null || draft.wire === undefined)
            }
            onClick={() => record(draft)}
          >
            Record answer &rarr;
          </button>
        )}
        {question.allow_unknown ? (
          <button
            type="button"
            className="ghost"
            disabled={leaving}
            onClick={() => onAnswer({ kind: "unknown" })}
          >
            I don&rsquo;t know
          </button>
        ) : (
          <button
            type="button"
            className="ghost quiet"
            disabled={leaving}
            onClick={() => onAnswer({ kind: "skip" })}
          >
            Skip for now
          </button>
        )}
        {hint && <span className="hint label">{hint}</span>}
      </div>
    </div>
  );
}
