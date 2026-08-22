"use client";

// Boolean — Yes / No opt buttons with the 130ms confirm beat, so the
// pressed state renders fully before the card departs (§4.2).

import { useEffect, useRef, useState } from "react";
import type { ControlProps } from "./shared";

export function BooleanControl({ onChange, onCommit }: ControlProps) {
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
    window.setTimeout(() => onCommit({ wire: value }), 130);
  };

  return (
    <div className="opts" role="group">
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
