"use client";

// Money — underline field, mono currency suffix, live thousands
// separation that never fights the caret, and the §8.1 honesty device:
// a ghost "This is an estimate" toggle.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { ControlProps } from "./shared";

/** "1234567.5" → "1,234,567.5" (integer part grouped, decimals kept). */
function group(intPart: string, decPart: string | undefined): string {
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart === undefined ? grouped : `${grouped}.${decPart}`;
}

/** Normalize typed input: digits and at most one dot with two decimals. */
function parse(raw: string): { intPart: string; decPart: string | undefined } {
  const clean = raw.replace(/[^\d.]/g, "");
  const m = /^(\d*)(?:\.(\d{0,2}))?/.exec(clean);
  return { intPart: m?.[1] ?? "", decPart: m?.[2] };
}

export function MoneyControl({ question, onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [display, setDisplay] = useState("");
  const [estimate, setEstimate] = useState(false);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Restore the caret after React re-renders the formatted value.
  useLayoutEffect(() => {
    if (caretRef.current !== null && ref.current) {
      ref.current.setSelectionRange(caretRef.current, caretRef.current);
      caretRef.current = null;
    }
  }, [display]);

  const wireOf = (formatted: string): unknown => {
    const { intPart, decPart } = parse(formatted);
    if (intPart === "" && (decPart === undefined || decPart === "")) return null;
    const n = Number(`${intPart === "" ? "0" : intPart}.${decPart ?? "0"}`);
    return Number.isFinite(n) ? { amount_major: n } : null;
  };

  const handleInput = (e: ChangeEvent<HTMLInputElement>): void => {
    const el = e.target;
    const before = el.value.slice(0, el.selectionStart ?? el.value.length);
    const significantBefore = before.replace(/[^\d.]/g, "").length;
    const { intPart, decPart } = parse(el.value);
    const next = group(intPart, decPart);
    // Place the caret after the same count of significant characters.
    let seen = 0;
    let pos = 0;
    while (pos < next.length && seen < significantBefore) {
      if (/[\d.]/.test(next.charAt(pos))) seen += 1;
      pos += 1;
    }
    caretRef.current = pos;
    setDisplay(next);
    onChange({ wire: wireOf(next), estimate });
  };

  const toggleEstimate = (): void => {
    const next = !estimate;
    setEstimate(next);
    onChange({ wire: wireOf(display), estimate: next });
  };

  return (
    <div>
      <div className="money-wrap">
        <input
          ref={ref}
          aria-labelledby={`q-${question.id}`}
          className="field tabular"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={display}
          onChange={handleInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit({ wire: wireOf(e.currentTarget.value), estimate });
            }
          }}
        />
        <span className="money-cur" aria-hidden="true">
          {question.currency}
        </span>
      </div>
      <div className="estimate-row">
        <button type="button" className="ghost" aria-pressed={estimate} onClick={toggleEstimate}>
          This is an estimate
        </button>
        {estimate && <span className="mono-note label">Basis: estimate</span>}
      </div>
    </div>
  );
}
