"use client";

// Option tiles (owner design intake-v2): a row of ink-ruled tiles, two to
// four across and wrapping, each with its label and a small boxed key
// number at the bottom right. The number keys 1–9 press the matching tile;
// QuestionCard owns the key listener so the digits never fire while the
// owner is typing in a field.
//
// "I don't know" is the same control in a dashed tile, set
// apart from the choices: it records an explicit unknown (rule 5).
//
// The design prints help lines under each label ("post, letterbox"). The
// bank's vocabularies are bare codes with no help text, so none is drawn;
// `help` renders only when a caller has a real one.

import { forwardRef } from "react";
import { optionColumns } from "../record";

export interface RowSpec {
  id: string;
  label: string;
  /** A real help line for this choice, when the data has one. */
  help?: string | null;
  pressed: boolean;
  onPress: () => void;
  /** "I don't know" — the dashed tile. */
  unknown?: boolean;
}

export const OptionRow = forwardRef<
  HTMLButtonElement,
  { row: RowSpec; index: number; disabled: boolean }
>(function OptionRow({ row, index, disabled }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      className={row.unknown ? "ix-opt ix-opt-unknown" : "ix-opt"}
      aria-pressed={row.pressed}
      aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
      disabled={disabled}
      onClick={row.onPress}
    >
      <span className="ix-opt-label">{row.label}</span>
      {row.help && <span className="ix-opt-help">{row.help}</span>}
      {index < 9 && (
        <span className="ix-key" aria-hidden="true">
          {index + 1}
        </span>
      )}
    </button>
  );
});

export function OptionRows({
  rows,
  labelledBy,
  disabled,
  firstRef,
}: {
  rows: readonly RowSpec[];
  labelledBy: string;
  disabled: boolean;
  firstRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div
      className="ix-opts"
      role="group"
      aria-labelledby={labelledBy}
      style={{ "--cols": optionColumns(rows.length) } as React.CSSProperties}
    >
      {rows.map((row, i) => (
        <OptionRow
          key={row.id}
          ref={i === 0 ? firstRef : undefined}
          row={row}
          index={i}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
