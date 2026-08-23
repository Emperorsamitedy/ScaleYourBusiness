"use client";

// Recorded-answer chip — the profile being built, provenance visible
// (§4.1). Solid dot = recorded fact, hollow dot = gap. Entity chips carry
// per-row detail (P0-70). Every chip is clickable (P0-75): it expands to
// show detail and a reopen form — the old value stays in history and the
// change records a reason.

import { useState } from "react";
import type { IntakeChip } from "@/lib/intake/types";

export function Chip({
  chip,
  onReopen,
}: {
  chip: IntakeChip;
  onReopen?: (questionId: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  return (
    <div className={`chip${open ? " chip-open" : ""}`}>
      <button
        type="button"
        className="chip-face"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="q">{chip.prompt}</span>
        <span className="a">{chip.display}</span>
        {open && chip.detail && (
          <span className="chip-detail">
            {chip.detail.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </span>
        )}
        <span className="tag">
          <span className={chip.dot === "solid" ? "dot" : "dot thin"} aria-hidden="true" />
          {chip.provenance}
        </span>
      </button>
      {open && onReopen && (
        <form
          className="chip-reopen"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim()) onReopen(chip.question_id, reason.trim());
          }}
        >
          <input
            className="field chip-reopen-field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why change it?"
            aria-label={`Reason for changing ${chip.prompt}`}
          />
          <button type="submit" className="ghost" disabled={!reason.trim()}>
            Reopen
          </button>
        </form>
      )}
    </div>
  );
}
