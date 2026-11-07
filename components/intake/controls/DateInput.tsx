"use client";

import { useEffect, useRef } from "react";
import type { ControlProps } from "./shared";

export function DateControl({ question, onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  // The bank's one date (1.5b, when the business started) asks for a
  // month, so the control is a month picker: "2021-03" goes on the wire as
  // the first of that month, "2021-03-01". A browser without month inputs
  // shows a text box, where a full date typed out is kept as it is.
  const wireOf = (raw: string): unknown => {
    const v = raw.trim();
    if (v === "") return null;
    return /^\d{4}-\d{2}$/.test(v) ? `${v}-01` : v;
  };

  return (
    <input
      ref={ref}
      aria-labelledby={`q-${question.id}`}
      className="ix-input ix-date"
      type="month"
      placeholder="YYYY-MM"
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
