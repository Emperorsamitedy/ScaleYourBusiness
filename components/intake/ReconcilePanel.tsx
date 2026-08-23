"use client";

// The reconcile panel — §4.5, P0-82/83. The tonal high-water mark: the
// system just caught an apparent inconsistency, which is exactly when a
// business tool usually makes someone feel stupid. Curious, never
// corrective — the copy below is specified verbatim in the ux spec.

import type { IntakeFinding } from "@/lib/intake/types";

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
    <aside className="reconcile" aria-live="polite">
      <div className="reconcile-eyebrow">
        <span className="dot ember" aria-hidden="true" />
        {finding.rule_id} · {finding.kind}
      </div>
      <h3>Help me reconcile these two</h3>
      <p className="reconcile-both">{finding.message}</p>
      <p className="reconcile-tagline">Both can be true — I&rsquo;d rather ask than assume.</p>
      <div className="reconcile-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => onChoose("confirm")}>
          Both are right
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => onChoose("fix")}>
          Let me fix one
        </button>
      </div>
    </aside>
  );
}
