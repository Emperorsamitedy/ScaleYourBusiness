"use client";

// The reconcile panel — §4.5, P0-82/83, on the sheet system. The system
// has found two answers that disagree (or one outside the usual range).
// Plain and factual: say what was found, say that neither is chosen for
// them, offer the two paths. The copy departs from §4.5's verbatim lines
// by owner brief (2026-10-17: no persona lines); the spec needs the same
// edit. The finding's own message carries both statements.

import type { IntakeFinding } from "@/lib/intake/types";

const HEADING: Record<IntakeFinding["kind"], string> = {
  contradiction: "Two answers disagree",
  implausible: "One answer is outside the usual range",
  gap: "An answer is missing",
  stale: "An answer may be out of date",
};

export function ReconcilePanel({
  finding,
  busy,
  onChoose,
}: {
  finding: IntakeFinding;
  busy: boolean;
  onChoose: (choice: "confirm" | "fix") => void;
}) {
  return (
    <aside className="ix-reconcile sheet" aria-live="polite" aria-labelledby="ix-reconcile-h">
      <p className="ix-cap ix-reconcile-head">
        <span className="flag drift">To reconcile</span>
        <span className="fig">{finding.rule_id}</span>
        <span>{finding.kind}</span>
      </p>
      <h3 id="ix-reconcile-h">{HEADING[finding.kind]}</h3>
      <p className="ix-reconcile-both inset">{finding.message}</p>
      <p className="ix-note">
        I won&rsquo;t pick one for you. Confirm both are right, or change one.
      </p>
      <div className="ix-actions">
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("confirm")}>
          Confirm both &rarr;
        </button>
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("fix")}>
          Change one &rarr;
        </button>
      </div>
    </aside>
  );
}
