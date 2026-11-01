"use client";

import { useEffect, useRef } from "react";
import { MicButton } from "../../voice/MicButton";
import { intlTag } from "@/lib/i18n/locales";
import { useIntakeWords } from "../words";
import type { ControlProps } from "./shared";

export function LongTextControl({ question, onChange, onCommit }: ControlProps) {
  const { tr, locale } = useIntakeWords();
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const wireOf = (raw: string): unknown => (raw.trim() === "" ? null : raw.trim());

  // Idea 50: spoken words land in the box as a draft, exactly as if typed.
  const setSpoken = (next: string): void => {
    if (ref.current) ref.current.value = next;
    onChange({ wire: wireOf(next) });
  };

  return (
    <div>
      <textarea
        ref={ref}
        aria-labelledby={`q-${question.id}`}
        className="ix-input ix-textarea"
        rows={3}
        onChange={(e) => onChange({ wire: wireOf(e.target.value) })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommit({ wire: wireOf(e.currentTarget.value) });
          }
        }}
      />
      <MicButton
        label={tr("question.speak")}
        getText={() => ref.current?.value ?? ""}
        setText={setSpoken}
        after={tr("question.spokenAfter")}
        lang={intlTag(locale)}
      />
    </div>
  );
}
