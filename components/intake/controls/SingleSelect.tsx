"use client";

// Single select — click fills ink, a 130ms confirm beat lets the choice
// register, then the answer auto-submits (§4.2).

import { useEffect, useRef, useState } from "react";
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
    window.setTimeout(() => onCommit({ wire: code }), 130);
  };

  return (
    <div className="opts" role="group">
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
