"use client";

// Money (owner design intake-v2): a ruled "EXACT  € [ 0.00 ]" box with
// the currency's mark from components/sheet/num.ts (the profile's own
// reporting currency), live thousands separation that never fights the
// caret, and the §8.1 honesty device: a "This is an estimate" toggle.
//
// The design prints a unit after the field ("per order"). The bank's
// money questions carry no unit, so none is printed. Nor are range tiles
// ("Under €6", "€6–€9") drawn: the bank carries no per-question ranges,
// and inventing buckets would put numbers on screen nothing backs. The
// measured reference ruler lives in QuestionCard, from already_read.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { currencyMark } from "../record";
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

export function MoneyControl({
  question,
  onChange,
  onCommit,
  afterRows = false,
}: ControlProps & { afterRows?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const caretRef = useRef<number | null>(null);
  const [display, setDisplay] = useState("");
  const [estimate, setEstimate] = useState(false);

  // With option rows above, focus stays off the field so the number keys
  // can pick a row; alone, the field takes focus.
  useEffect(() => {
    if (!afterRows) ref.current?.focus({ preventScroll: true });
  }, [afterRows]);

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

  const { mark, before } = currencyMark(question.currency);
  const inputId = `money-${question.id}`;
  return (
    <div className="ix-money">
      <div className="ix-money-box">
        <label className="ix-money-label" htmlFor={inputId}>
          Exact<span className="sr-only"> amount, {question.currency}</span>
        </label>
        {before && (
          <span className="ix-money-mark" aria-hidden="true">
            {mark}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-describedby={`q-${question.id}`}
          className="ix-money-input"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={display}
          onChange={handleInput}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit({ wire: wireOf(e.currentTarget.value), estimate });
            }
          }}
        />
        {!before && <span className="ix-money-mark">{mark}</span>}
      </div>
      <div className="ix-estimate">
        <button type="button" className="ix-link" aria-pressed={estimate} onClick={toggleEstimate}>
          {estimate ? "Marked as an estimate" : "This is an estimate"}
        </button>
        {estimate && <span className="ix-note">Basis: estimated</span>}
      </div>
    </div>
  );
}
