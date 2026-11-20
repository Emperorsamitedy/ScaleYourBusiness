"use client";

// The reconcile panel — §4.5, P0-82/83, on the sheet system. The system
// has found two answers that disagree (or one outside the usual range).
// Plain and factual: say what was found and offer the two paths. The copy
// departs from §4.5's earlier verbatim lines by owner brief (2026-10-17: no
// persona lines; 2026-11-09: no extra words, so the kind word that
// repeated the heading and the "I won't pick one for you" line are gone,
// and the spec says the same). The finding's own message carries both
// statements.

// L-2: the panel's own words are the catalogue's (intake.reconcile); the
// finding's message is the validation engine's sentence (still English
// until L-4 moves those sentences to messages).

import { useTranslations } from "next-intl";
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
  const t = useTranslations("intake.reconcile");
  return (
    // The rule that found it stays on the element for whoever debugs a
    // report of it; it is a code ("stage_vs_revenue"), not words for an
    // owner, so since 2026-11-20 it is no longer printed beside the flag.
    <aside
      className="ix-reconcile sheet"
      aria-live="polite"
      aria-labelledby="ix-reconcile-h"
      data-rule={finding.rule_id}
    >
      <p className="ix-cap ix-reconcile-head">
        <span className="flag drift">{t("flag")}</span>
      </p>
      <h3 id="ix-reconcile-h">{t(finding.kind)}</h3>
      <p className="ix-reconcile-both inset">{finding.message}</p>
      <div className="ix-actions">
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("confirm")}>
          {t("confirm")}
        </button>
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("fix")}>
          {t("fix")}
        </button>
      </div>
    </aside>
  );
}
