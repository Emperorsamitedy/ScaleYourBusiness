"use client";

// Recorded-answer chip — the profile being built, provenance visible
// (§4.1). Solid dot = recorded fact, hollow dot = gap. Entity chips carry
// per-row detail and expand on click (P0-70).

import { useState } from "react";
import type { IntakeChip } from "@/lib/intake/types";

export function Chip({ chip }: { chip: IntakeChip }) {
  const [open, setOpen] = useState(false);
  const expandable = (chip.detail?.length ?? 0) > 0;

  const body = (
    <>
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
    </>
  );

  if (!expandable) return <div className="chip">{body}</div>;
  return (
    <button
      type="button"
      className="chip chip-expandable"
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
    >
      {body}
    </button>
  );
}
