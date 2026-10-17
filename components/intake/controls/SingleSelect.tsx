"use client";

// Single select — click fills ink, a 130ms confirm beat lets the choice
// register, then the answer auto-submits (§4.2). Zero under reduced motion.

import { useEffect, useRef, useState } from "react";
import { CONFIRM_MS, beat } from "../motion";
import type { ControlProps } from "./shared";

export function SingleSelectControl({ question, onChange, onCommit }: ControlProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const committing = useRef(false);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, []);

  const pick = (code: string): void => {
    if (committing.current) return;
    committing.current = true;
    setPicked(code);
    onChange({ wire: code });
    window.setTimeout(() => onCommit({ wire: code }), beat(CONFIRM_MS));
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
          aria-pressed={picked === option.code}
          onClick={() => pick(option.code)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
