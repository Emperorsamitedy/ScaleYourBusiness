"use client";

import { useEffect, useRef } from "react";
import type { ControlProps } from "./shared";

export function DateControl({ question, onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // Native date input already yields "YYYY-MM-DD" — the wire format.
  const wireOf = (raw: string): unknown => (raw === "" ? null : raw);

  return (
    <input
      ref={ref}
      aria-labelledby={`q-${question.id}`}
      className="ix-input ix-date"
      type="date"
      onChange={(e) => onChange({ wire: wireOf(e.target.value) })}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit({ wire: wireOf(e.currentTarget.value) });
        }
      }}
    />
  );
}
