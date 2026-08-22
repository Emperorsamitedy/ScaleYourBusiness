"use client";

// Recorded-answer chip — the profile being built, provenance visible
// (§4.1). Solid dot = recorded fact, hollow dot = gap.

import type { IntakeChip } from "@/lib/intake/types";

export function Chip({ chip }: { chip: IntakeChip }) {
  return (
    <div className="chip">
      <span className="q">{chip.prompt}</span>
      <span className="a">{chip.display}</span>
      <span className="tag">
        <span className={chip.dot === "solid" ? "dot" : "dot thin"} aria-hidden="true" />
        {chip.provenance}
      </span>
    </div>
  );
}
