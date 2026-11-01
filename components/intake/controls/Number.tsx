"use client";

// L-2: in English, the browser's own number box, as before. In another
// language a text box that takes the figure as the person writes it
// ("12,5", "1 234") — a native number box follows the browser's language,
// not the person's — read through lib/intake/amount-input, and a figure
// that reads two ways is asked about, never guessed.

import { useEffect, useRef, useState } from "react";
import { readTypedAmount } from "@/lib/intake/amount-input";
import { useIntakeWords } from "../words";
import { AmountChoice, settledDecimal } from "./AmountChoice";
import type { ControlProps } from "./shared";

export function NumberControl({ question, onChange, onCommit }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null);
  const { locale } = useIntakeWords();
  const local = locale !== "en";
  const [raw, setRaw] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);

  const wireOf = (value: string, choice: string | null = picked): unknown => {
    if (local) {
      const decimal = settledDecimal(readTypedAmount(value), choice);
      return decimal === null ? null : globalThis.Number(decimal);
    }
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = globalThis.Number(trimmed);
    return globalThis.Number.isFinite(n) ? n : null;
  };

  return (
    <div>
      <input
        ref={ref}
        aria-labelledby={`q-${question.id}`}
        className="ix-input ix-num"
        type={local ? "text" : "number"}
        inputMode="decimal"
        autoComplete="off"
        onChange={(e) => {
          setRaw(e.target.value);
          setPicked(null);
          onChange({ wire: wireOf(e.target.value, null) });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit({ wire: wireOf(e.currentTarget.value) });
          }
        }}
      />
      {local && (
        <AmountChoice
          reading={readTypedAmount(raw)}
          picked={picked}
          onPick={(d) => {
            setPicked(d);
            onChange({ wire: wireOf(raw, d) });
          }}
          locale={locale}
        />
      )}
    </div>
  );
}
