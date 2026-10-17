"use client";

// The reconcile panel — §4.5, P0-82/83. The system has found two answers
// that disagree (or one outside the usual range). Plain and factual: say
// what was found, say that neither is chosen for them, offer the two
// paths. The panel's copy departs from §4.5's verbatim lines by owner
// brief (2026-10-17: no persona lines); the spec needs the same edit. The
// finding's own message carries both statements.

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
    <aside className="reconcile" aria-live="polite" aria-label="Reconcile two answers">
      <div className="reconcile-eyebrow label">
        <span className="flag drift">To reconcile</span>
        <span className="fig">{finding.rule_id}</span>
        <span>{finding.kind}</span>
      </div>
      <h3>{HEADING[finding.kind]}</h3>
      <p className="reconcile-both">{finding.message}</p>
      <p className="reconcile-tagline">
        I won&rsquo;t pick one for you. Confirm both are right, or change one.
      </p>
      <div className="reconcile-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => onChoose("confirm")}>
          Confirm both &rarr;
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => onChoose("fix")}>
          Change one &rarr;
        </button>
      </div>
    </aside>
  );
}
