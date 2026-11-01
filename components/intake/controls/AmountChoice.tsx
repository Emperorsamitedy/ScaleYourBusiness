"use client";

// L-2: the question a typed figure gets when it could be read two ways
// ("1.200": one thousand two hundred, or one point two). Both readings are
// shown in the person's own number writing; nothing is recorded until they
// pick one (lib/intake/amount-input.ts — never guessed).

import type { TypedAmount } from "@/lib/intake/amount-input";
import { decimalsOf } from "@/lib/intake/amount-input";
import type { AppLocale } from "@/lib/i18n/locales";
import { num } from "../../sheet/num";
import { useIntakeWords } from "../words";

/** The two readings of an ambiguous figure, as buttons; the unreadable note otherwise. */
export function AmountChoice({
  reading,
  picked,
  onPick,
  locale,
}: {
  reading: TypedAmount;
  picked: string | null;
  onPick: (decimal: string) => void;
  locale: AppLocale;
}) {
  const { tr } = useIntakeWords();
  if (reading.kind === "unreadable") return <p className="ix-note">{tr("amount.unreadable")}</p>;
  if (reading.kind !== "ambiguous") return null;
  const show = (d: string) => num(Number(d), decimalsOf(d), locale);
  return (
    <div className="ix-estimate" role="group" aria-label={tr("amount.which")}>
      <span className="ix-note">{tr("amount.which")}</span>
      {[reading.grouped, reading.decimal].map((d) => (
        <button
          key={d}
          type="button"
          className="ix-link"
          aria-pressed={picked === d}
          onClick={() => onPick(d)}
        >
          {show(d)}
        </button>
      ))}
    </div>
  );
}

/** The decimal a figure stands for once settled: its one reading, or the picked one. */
export function settledDecimal(reading: TypedAmount, picked: string | null): string | null {
  if (reading.kind === "value") return reading.decimal;
  if (reading.kind === "ambiguous" && picked !== null) {
    return picked === reading.grouped || picked === reading.decimal ? picked : null;
  }
  return null;
}
