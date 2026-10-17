"use client";

// Multi select — toggles accumulate; an explicit "Record answer"
// submits (§4.2). Wire format: array of option codes.

import { useEffect, useRef, useState } from "react";
import type { ControlProps } from "./shared";

export function MultiSelectControl({ question, onChange }: ControlProps) {
  const [picked, setPicked] = useState<readonly string[]>([]);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, []);

  const toggle = (code: string): void => {
    const next = picked.includes(code) ? picked.filter((c) => c !== code) : [...picked, code];
    setPicked(next);
    onChange({ wire: next.length > 0 ? [...next] : null });
  };

  return (
    <div
      className={question.options.length > 8 ? "opts many" : "opts"}
      role="group"
      aria-labelledby={`q-${question.id}`}
    >
      {question.options.map((option, i) => (
        <button
          key={option.code}
          ref={i === 0 ? firstRef : undefined}
          type="button"
          className="opt"
          aria-pressed={picked.includes(option.code)}
          onClick={() => toggle(option.code)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
