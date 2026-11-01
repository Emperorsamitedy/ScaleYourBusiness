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
//
// L-2: in English the box groups as it always did. In another language it
// takes the figure as the person writes it ("1.234,56", "1 234,56") and
// reads it through lib/intake/amount-input; a figure that reads two ways
// ("1.200") is asked about, never guessed (AmountChoice).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useTranslations } from "next-intl";
import { readTypedAmount } from "@/lib/intake/amount-input";
import { num } from "../../sheet/num";
import { currencyMark } from "../record";
import { useIntakeWords } from "../words";
import { AmountChoice, settledDecimal } from "./AmountChoice";
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
  const [picked, setPicked] = useState<string | null>(null);
  const { locale } = useIntakeWords();
  const t = useTranslations("intake.amount");
  const local = locale !== "en";

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

  const wireOf = (formatted: string, choice: string | null = picked): unknown => {
    if (local) {
      const decimal = settledDecimal(readTypedAmount(formatted), choice);
      return decimal === null ? null : { amount_major: decimal };
    }
    const { intPart, decPart } = parse(formatted);
    if (intPart === "" && (decPart === undefined || decPart === "")) return null;
    const n = Number(`${intPart === "" ? "0" : intPart}.${decPart ?? "0"}`);
    return Number.isFinite(n) ? { amount_major: n } : null;
  };

  const handleInput = (e: ChangeEvent<HTMLInputElement>): void => {
    const el = e.target;
    if (local) {
      // As written: no regrouping under the caret, read on every change.
      setPicked(null);
      setDisplay(el.value);
      onChange({ wire: wireOf(el.value, null), estimate });
      return;
    }
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

  const pick = (decimal: string): void => {
    setPicked(decimal);
    onChange({ wire: wireOf(display, decimal), estimate });
  };

  const { mark, before } = currencyMark(question.currency, locale);
  const inputId = `money-${question.id}`;
  const reading = local ? readTypedAmount(display) : null;
  return (
    <div className="ix-money">
      <div className="ix-money-box">
        <label className="ix-money-label" htmlFor={inputId}>
          {t.rich("exact", {
            currency: question.currency,
            sr: (chunks) => <span className="sr-only">{chunks}</span>,
          })}
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
          placeholder={num(0, 2, locale)}
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
      {reading && <AmountChoice reading={reading} picked={picked} onPick={pick} locale={locale} />}
      <div className="ix-estimate">
        <button type="button" className="ix-link" aria-pressed={estimate} onClick={toggleEstimate}>
          {estimate ? t("estimated") : t("estimate")}
        </button>
        {estimate && <span className="ix-note">{t("basis")}</span>}
      </div>
    </div>
  );
}
