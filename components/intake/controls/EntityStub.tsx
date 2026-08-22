"use client";

// Entity list — Session N interim (replaced by the real sub-form in
// Session O): a 1–20 stepper answering "How many?", recorded via PATCH.

import { useEffect, useRef, useState } from "react";
import type { ControlProps } from "./shared";

const MIN = 1;
const MAX = 20;

const clamp = (n: number): number => Math.min(MAX, Math.max(MIN, Math.round(n)));

export function EntityStubControl({ onChange, onCommit }: ControlProps) {
  const [count, setCount] = useState(1);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const set = (n: number): void => {
    const next = clamp(n);
    setCount(next);
    onChange({ wire: next });
  };

  return (
    <div>
      <span className="stepper-label" id="entity-count-label">
        How many?
      </span>
      <div className="stepper" role="group" aria-labelledby="entity-count-label">
        <button
          type="button"
          aria-label="Fewer"
          disabled={count <= MIN}
          onClick={() => set(count - 1)}
        >
          −
        </button>
        <input
          ref={ref}
          type="number"
          min={MIN}
          max={MAX}
          value={count}
          aria-labelledby="entity-count-label"
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) set(n);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit({ wire: count });
            }
          }}
        />
        <button
          type="button"
          aria-label="More"
          disabled={count >= MAX}
          onClick={() => set(count + 1)}
        >
          +
        </button>
      </div>
      <p className="stub-note">You&rsquo;ll add names and details shortly.</p>
    </div>
  );
}
