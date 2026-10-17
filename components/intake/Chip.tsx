"use client";

// A fact line in the record column — the profile being built, with its
// provenance printed (§4.1): what was recorded, its bank reference, its
// source and basis. A skip reads "Not provided"; an unknown reads as a
// recorded gap with a follow-up (rule 5). Entity lines carry per-row
// detail (P0-70). Every line can be changed (P0-75): it opens a reopen
// form for exactly its question — the old value stays in history and the
// change records a reason.

import { useState } from "react";
import type { IntakeChip } from "@/lib/intake/types";
import { factLine } from "./record";

export function Chip({
  chip,
  flagged = false,
  fresh = false,
  onReopen,
}: {
  chip: IntakeChip;
  /** §4.5: involved in an open finding — flagged in words. */
  flagged?: boolean;
  /** The line just recorded — its value carries the marker. */
  fresh?: boolean;
  onReopen?: (questionId: string, reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const line = factLine(chip);
  const formId = `reopen-${chip.question_id}`;

  return (
    <div
      className={`chip rec-line rec-${line.kind}${open ? " chip-open" : ""}${
        flagged ? " chip-flagged" : ""
      }`}
    >
      <button
        type="button"
        className="chip-face"
        aria-expanded={open}
        aria-controls={open ? formId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rec-head">
          <span className="flag rec-flag">{line.flag}</span>
          {flagged && <span className="flag drift">To reconcile</span>}
          <span className="rec-ref fig">{line.ref}</span>
        </span>
        <span className="q">{chip.prompt}</span>
        <span className="a">
          <span className={fresh ? "marked" : undefined}>{line.value}</span>
        </span>
        {open && chip.detail && (
          <span className="chip-detail">
            {chip.detail.map((l, i) => (
              <span key={i}>{l}</span>
            ))}
          </span>
        )}
        <span className="tag">{line.source}</span>
        {line.followUp && <span className="rec-note">{line.followUp}</span>}
        {onReopen && <span className="rec-change">{open ? "Close" : "Change"}</span>}
      </button>
      {open && onReopen && (
        <form
          id={formId}
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
            Reopen &rarr;
          </button>
        </form>
      )}
    </div>
  );
}
