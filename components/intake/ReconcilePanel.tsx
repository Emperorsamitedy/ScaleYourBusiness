"use client";

// The reconcile panel — §4.5, P0-82/83, on the sheet system. The system
// has found two answers that disagree (or one outside the usual range).
// Plain and factual: say what was found, say that neither is chosen for
// them, offer the two paths. The copy departs from §4.5's verbatim lines
// by owner brief (2026-10-17: no persona lines); the spec needs the same
// edit. The finding's own message carries both statements.

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
    <aside className="ix-reconcile sheet" aria-live="polite" aria-labelledby="ix-reconcile-h">
      <p className="ix-cap ix-reconcile-head">
        <span className="flag drift">{t("flag")}</span>
        <span className="fig">{finding.rule_id}</span>
        <span>{t(`kind.${finding.kind}`)}</span>
      </p>
      <h3 id="ix-reconcile-h">{t(finding.kind)}</h3>
      <p className="ix-reconcile-both inset">{finding.message}</p>
      <p className="ix-note">{t("note")}</p>
      <div className="ix-actions">
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("confirm")}>
          {t("confirm")} &rarr;
        </button>
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("fix")}>
          {t("fix")} &rarr;
        </button>
      </div>
    </aside>
  );
}
