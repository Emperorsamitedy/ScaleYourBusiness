"use client";

// Entity-list sub-form — Session O (P0-68/69, §4.3). Compact repeating
// rows: core sub-fields always visible, "Add detail" reveals the rest per
// row, "Add another" beneath. Five products with names and prices in
// under ninety seconds is the design target — so core-first, no modal,
// Enter records the whole list.

import { useEffect, useRef, useState } from "react";
import type { EntityField, IntakeQuestion } from "@/lib/intake/types";

type Row = Record<string, unknown>;

interface EntityListProps {
  question: IntakeQuestion;
  /** Fires on every edit with the buildable wire rows (empty = invalid). */
  onRowsChange: (rows: Row[]) => void;
  /** Enter inside a row asks the card to record the whole list. */
  onRequestSubmit: () => void;
}

/** Build the wire value for one sub-field from its raw input state. */
function wireOf(field: EntityField, raw: string | boolean | string[]): unknown {
  if (raw === "" || raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
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
          className="field subfield-select"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{field.prompt}…</option>
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
        <div className="opts opts-compact" role="group" aria-label={field.prompt}>
          {field.options.map((o) => {
            const on = selected.includes(o.code);
            return (
              <button
                key={o.code}
                type="button"
                className="opt opt-compact"
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
          className="field subfield-select"
          value={value === true ? "yes" : value === false ? "no" : ""}
          onChange={(e) => onChange(e.target.value === "yes")}
        >
          <option value="">{field.prompt}…</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case "long_text":
      return (
        <input
          className="field"
          type="text"
          placeholder={field.prompt}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enter}
        />
      );
    case "money":
      return (
        <span className="subfield-money">
          <input
            className="field"
            type="text"
            inputMode="numeric"
            placeholder={field.prompt}
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value.replace(/[^\d.,\s]/g, ""))}
            onKeyDown={enter}
          />
          <span className="currency-suffix">{field.currency}</span>
        </span>
      );
    default:
      return (
        <input
          className="field"
          type={field.input_type === "number" ? "number" : "text"}
          placeholder={field.prompt}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={enter}
        />
      );
  }
}

export function EntityListControl({ question, onRowsChange, onRequestSubmit }: EntityListProps) {
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
          const wire = wireOf(f, raw);
          if (wire !== undefined) out[f.key] = wire;
        }
        return out;
      }),
    );
  };

  const submit = (): void => onRequestSubmit();

  const setCell = (i: number, key: string, v: string | boolean | string[]): void => {
    setRows((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, [key]: v } : r));
      report(next);
      return next;
    });
  };

  return (
    <div className="entity-rows" ref={firstInput}>
      {rows.map((row, i) => (
        <div className="entity-row" key={i}>
          <div className="entity-grid">
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
            <div className="entity-grid entity-detail">
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
          <div className="entity-row-actions">
            {rest.length > 0 && (
              <button
                type="button"
                className="ghost quiet"
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
                {detailOpen.has(i) ? "Hide detail" : "Add detail"}
              </button>
            )}
            {rows.length > 1 && (
              <button
                type="button"
                className="ghost quiet"
                aria-label={`Remove row ${i + 1}`}
                onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        className="ghost add-row"
        disabled={rows.length >= 20}
        onClick={() => setRows((prev) => [...prev, {}])}
      >
        + Add another
      </button>
    </div>
  );
}

export type { Row as EntityRow };
