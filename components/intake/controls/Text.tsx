"use client";

import { useEffect, useRef } from "react";
import type { ControlProps } from "./shared";

export function TextControl({ question, onChange, onCommit, initial }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  // A waiting draft counts as typed, so Record works on it as it stands.
  useEffect(() => {
    if (initial) onChange({ wire: initial });
    // Once, on mount: the draft is a starting point, not a value to keep re-applying.
  }, []);

  const wireOf = (raw: string): unknown => (raw.trim() === "" ? null : raw.trim());

  return (
    <input
      ref={ref}
      aria-labelledby={`q-${question.id}`}
      className="ix-input"
      type="text"
      autoComplete="off"
      defaultValue={initial ?? undefined}
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
