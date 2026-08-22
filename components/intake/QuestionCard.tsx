"use client";

// The centre card — eyebrow (mono id + tier), display prompt, help,
// control slot, action row (P0-61). Validation is inline and specific;
// errors never modal, never apologise, clear on next input (§4.2).

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { AnswerAction, IntakeQuestion } from "@/lib/intake/types";
import type { ControlChange } from "./controls/shared";
import { BooleanControl } from "./controls/Boolean";
import { DateControl } from "./controls/DateInput";
import { EntityStubControl } from "./controls/EntityStub";
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
  onEntityCount: (count: number) => void;
  onClearError: () => void;
}

/** Where Enter (or Cmd/Ctrl-Enter) submits, say so in mono (P0-67). */
function hintFor(type: IntakeQuestion["input_type"], mod: string): string | null {
  switch (type) {
    case "long_text":
      return `${mod}↩ to continue`;
    case "text":
    case "number":
    case "money":
    case "date":
    case "entity_list":
      return "Enter to continue";
    default:
      return null;
  }
}

export function QuestionCard({
  question,
  leaving,
  serverError,
  onAnswer,
  onEntityCount,
  onClearError,
}: QuestionCardProps) {
  const [draft, setDraft] = useState<ControlChange>(() =>
    question.input_type === "entity_list" ? { wire: 1 } : { wire: null },
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const [mod, setMod] = useState("Ctrl");

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setMod("⌘");
  }, []);

  const emptyMessage = question.allow_unknown
    ? "Answer this, or choose “I don't know” to move on."
    : "Answer this, or choose “Skip for now” to move on.";

  const handleChange = (change: ControlChange): void => {
    setDraft(change);
    setLocalError(null);
    onClearError();
  };

  const record = (change: ControlChange): void => {
    if (leaving) return;
    if (question.input_type === "entity_list") {
      onEntityCount(change.wire as number);
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
        return <EntityStubControl {...props} />;
      case "file":
        return <FileStubControl question={question} />;
    }
  })();

  const error = serverError ?? localError;
  const hint = hintFor(question.input_type, mod);
  const showRecord = question.input_type !== "file";

  return (
    <div className={leaving ? "card leaving" : "card"}>
      <div className="eyebrow">
        <span>{question.id}</span>
        <span className="tier">{question.priority}</span>
      </div>
      <h2 className="prompt">{question.prompt}</h2>
      {question.help && <p className="help">{question.help}</p>}
      <div>{control}</div>
      {error && <p className="err">{error}</p>}
      <div className="row">
        {showRecord && (
          <button
            type="button"
            className="next"
            disabled={leaving || draft.wire === null || draft.wire === undefined}
            onClick={() => record(draft)}
          >
            Record answer
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
        {hint && <span className="hint">{hint}</span>}
      </div>
    </div>
  );
}
