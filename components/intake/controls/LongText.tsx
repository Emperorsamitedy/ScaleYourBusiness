"use client";

import { useEffect, useRef } from "react";
import type { ControlProps } from "./shared";

export function LongTextControl({ question, onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const wireOf = (raw: string): unknown => (raw.trim() === "" ? null : raw.trim());

  return (
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
  );
}
