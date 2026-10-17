"use client";

// Boolean — Yes / No opt buttons with the 130ms confirm beat, so the
// pressed state renders fully before the card departs (§4.2). Zero under
// reduced motion.

import { useEffect, useRef, useState } from "react";
import { CONFIRM_MS, beat } from "../motion";
import type { ControlProps } from "./shared";

export function BooleanControl({ question, onChange, onCommit }: ControlProps) {
  const [picked, setPicked] = useState<boolean | null>(null);
  const committing = useRef(false);
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    yesRef.current?.focus({ preventScroll: true });
  }, []);

  const pick = (value: boolean): void => {
    if (committing.current) return;
    committing.current = true;
    setPicked(value);
    onChange({ wire: value });
    window.setTimeout(() => onCommit({ wire: value }), beat(CONFIRM_MS));
  };

  return (
    <div className="opts" role="group" aria-labelledby={`q-${question.id}`}>
      <button
        ref={yesRef}
        type="button"
        className="opt"
        aria-pressed={picked === true}
        onClick={() => pick(true)}
      >
        Yes
      </button>
      <button
        type="button"
        className="opt"
        aria-pressed={picked === false}
        onClick={() => pick(false)}
      >
        No
      </button>
    </div>
  );
}
