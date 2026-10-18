"use client";

import { useEffect, useRef } from "react";
import type { ControlProps } from "./shared";

export function NumberControl({ question, onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const wireOf = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const n = globalThis.Number(trimmed);
    return globalThis.Number.isFinite(n) ? n : null;
  };

  return (
    <input
      ref={ref}
      aria-labelledby={`q-${question.id}`}
      className="ix-input ix-num"
      type="number"
      inputMode="decimal"
      autoComplete="off"
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
