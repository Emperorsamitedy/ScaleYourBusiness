"use client";

// Entity-list sub-form — Session O (P0-68/69, §4.3). Compact repeating
// rows: core sub-fields always visible, "Add detail" reveals the rest per
// row, "Add another" beneath. Five products with names and prices in
// under ninety seconds is the design target — so core-first, no modal,
// Enter records the whole list.

import { useEffect, useRef, useState } from "react";
import { readTypedAmount } from "@/lib/intake/amount-input";
import type { AppLocale } from "@/lib/i18n/locales";
import type { EntityField, IntakeQuestion } from "@/lib/intake/types";
import { useIntakeWords } from "../words";
import { AmountChoice, settledDecimal } from "./AmountChoice";

type Row = Record<string, unknown>;

interface EntityListProps {
  question: IntakeQuestion;
  /** Fires on every edit with the buildable wire rows (empty = invalid). */
  onRowsChange: (rows: Row[]) => void;
  /** Enter inside a row asks the card to record the whole list. */
  onRequestSubmit: () => void;
}

/** A figure's settled reading, carried beside the typed text: "1.200" plus which one was meant. */
const PICK = "\u0000";

/**
 * Build the wire value for one sub-field from its raw input state. In
 * English a figure reads as before; in another language through the one
 * reader (lib/intake/amount-input), and an ambiguous one stays unsent
 * until its reading is picked (L-2: never guessed).
 */
function wireOf(field: EntityField, raw: string | boolean | string[], locale: AppLocale): unknown {
  if (raw === "" || raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
  if (locale !== "en" && (field.input_type === "number" || field.input_type === "money")) {
    const [typed = "", picked = null] = String(raw).split(PICK);
    const decimal = settledDecimal(readTypedAmount(typed), picked);
    if (decimal === null) return undefined;
    return field.input_type === "money" ? { amount_major: decimal } : Number(decimal);
  }
  switch (field.input_type) {
    case "number":
      return Number(raw);
    case "money":
      return { amount_major: Number(String(raw).replace(/[\s,]/g, "")) };
    case "boolean":
      return raw === true || raw === "yes";
    default:
      return raw;
  }
}

function SubField({
  field,
  value,
  onChange,
  onEnter,
}: {
  field: EntityField;
  value: string | boolean | string[];
  onChange: (v: string | boolean | string[]) => void;
  onEnter: () => void;
}) {
  const { tr, locale } = useIntakeWords();
  const enter = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      onEnter();
    }
  };
  switch (field.input_type) {
    case "single_select":
      return (
        <select
          className="ix-input ix-select"
          aria-label={field.prompt}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{tr("entity.choose", { prompt: field.prompt })}</option>
          {field.options.map((o) => (
            <option key={o.code} value={o.code}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multi_select": {
      const selected = Array.isArray(value) ? value : [];
      return (
        <div className="ix-chips" role="group" aria-label={field.prompt}>
          {field.options.map((o) => {
            const on = selected.includes(o.code);
            return (
              <button
                key={o.code}
                type="button"
                className="ix-chip"
                aria-pressed={on}
                onClick={() =>
                  onChange(on ? selected.filter((c) => c !== o.code) : [...selected, o.code])
                }
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "boolean":
      return (
        <select
          className="ix-input ix-select"
          aria-label={field.prompt}
          value={value === true ? "yes" : value === false ? "no" : ""}
          onChange={(e) => onChange(e.target.value === "yes")}
        >
          <option value="">{tr("entity.choose", { prompt: field.prompt })}</option>
          <option value="yes">{tr("question.yes")}</option>
          <option value="no">{tr("question.no")}</option>
        </select>
      );
    case "long_text":
      return (
        <input
          className="ix-input"
          type="text"
          placeholder={field.prompt}
          aria-label={field.prompt}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enter}
        />
      );
    case "money":
      if (locale !== "en")
        return <LocalFigure field={field} value={value} onChange={onChange} onEnter={enter} />;
      return (
        <span className="ix-sub-money">
          <input
            className="ix-input"
            type="text"
            inputMode="numeric"
            placeholder={field.prompt}
            aria-label={field.prompt}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value.replace(/[^\d.,\s]/g, ""))}
            onKeyDown={enter}
          />
          <span className="ix-note">{field.currency}</span>
        </span>
      );
    case "number":
      if (locale !== "en")
        return <LocalFigure field={field} value={value} onChange={onChange} onEnter={enter} />;
      return (
        <input
          className="ix-input"
          type="number"
          placeholder={field.prompt}
          aria-label={field.prompt}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enter}
        />
      );
    default:
      return (
        <input
          className="ix-input"
          type="text"
          placeholder={field.prompt}
          aria-label={field.prompt}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enter}
        />
      );
  }
}

/** L-2: a row figure in the person's writing, with the "which did you mean?" when it reads two ways. */
function LocalFigure({
  field,
  value,
  onChange,
  onEnter,
}: {
  field: EntityField;
  value: string | boolean | string[];
  onChange: (v: string) => void;
  onEnter: (e: React.KeyboardEvent) => void;
}) {
  const { locale } = useIntakeWords();
  const [typed = "", picked = null] = (typeof value === "string" ? value : "").split(PICK);
  return (
    <span className="ix-sub-money">
      <input
        className="ix-input"
        type="text"
        inputMode="decimal"
        placeholder={field.prompt}
        aria-label={field.prompt}
        value={typed}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onEnter}
      />
      {field.input_type === "money" && <span className="ix-note">{field.currency}</span>}
      <AmountChoice
        reading={readTypedAmount(typed)}
        picked={picked}
        onPick={(d) => onChange(`${typed}${PICK}${d}`)}
        locale={locale}
      />
    </span>
  );
}

export function EntityListControl({ question, onRowsChange, onRequestSubmit }: EntityListProps) {
  const { tr, locale } = useIntakeWords();
  const fields = question.entity_fields ?? [];
  const core = fields.filter((f) => f.priority === "core");
  const rest = fields.filter((f) => f.priority !== "core");
  const anchor = core[0] ?? fields[0];

  const [rows, setRows] = useState<Record<string, string | boolean | string[]>[]>([{}]);
  const [detailOpen, setDetailOpen] = useState<Set<number>>(new Set());
  const firstInput = useRef<HTMLDivElement>(null);

  useEffect(() => {
    firstInput.current?.querySelector("input")?.focus({ preventScroll: true });
  }, []);

  const report = (nextRows: Record<string, string | boolean | string[]>[]): void => {
    const valid = nextRows.filter((r) => {
      const v = anchor ? r[anchor.key] : undefined;
      return typeof v === "string" ? v.trim() !== "" : v !== undefined;
    });
    onRowsChange(
      valid.map((r) => {
        const out: Row = {};
        for (const f of fields) {
          const raw = r[f.key];
          if (raw === undefined) continue;
          const wire = wireOf(f, raw, locale);
          if (wire !== undefined) out[f.key] = wire;
        }
        return out;
      }),
    );
  };

  const submit = (): void => onRequestSubmit();

  // Tell the parent after the rows change, never from inside a state
  // update (React forbids a parent setState during this one's render), and
  // for every change — removing a row included. Not on mount: nothing has
  // been typed yet, and the parent's "nothing typed" stays null.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    report(rows);
  }, [rows]);

  const setCell = (i: number, key: string, v: string | boolean | string[]): void => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: v } : r)));
  };

  return (
    <div className="ix-entities" ref={firstInput}>
      {rows.map((row, i) => (
        <div className="ix-entity" key={i}>
          <div className="ix-entity-grid">
            {core.map((f) => (
              <SubField
                key={f.key}
                field={f}
                value={row[f.key] ?? (f.input_type === "multi_select" ? [] : "")}
                onChange={(v) => setCell(i, f.key, v)}
                onEnter={submit}
              />
            ))}
          </div>
          {detailOpen.has(i) && (
            <div className="ix-entity-grid detail">
              {rest.map((f) => (
                <SubField
                  key={f.key}
                  field={f}
                  value={row[f.key] ?? (f.input_type === "multi_select" ? [] : "")}
                  onChange={(v) => setCell(i, f.key, v)}
                  onEnter={submit}
                />
              ))}
            </div>
          )}
          <div className="ix-entity-actions">
            {rest.length > 0 && (
              <button
                type="button"
                className="ix-link"
                aria-expanded={detailOpen.has(i)}
                onClick={() =>
                  setDetailOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
              >
                {detailOpen.has(i) ? tr("entity.hideDetail") : tr("entity.addDetail")}
              </button>
            )}
            {rows.length > 1 && (
              <button
                type="button"
                className="ix-link"
                aria-label={tr("entity.removeRow", { row: i + 1 })}
                onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              >
                {tr("entity.remove")}
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="ix-link ix-add"
        disabled={rows.length >= 20}
        onClick={() => setRows((prev) => [...prev, {}])}
      >
        {tr("entity.addRow")}
      </button>
    </div>
  );
}

export type { Row as EntityRow };
