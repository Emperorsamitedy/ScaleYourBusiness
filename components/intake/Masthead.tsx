"use client";

// The intake masthead (owner design intake-v2): ink bar, cobalt rule under
// it. Left: the mark and the business's name — the record's own
// identity.legal_name, or none. Right: "Saving…" while a request is in
// flight, the facts on file, and the way out.
//
// Decluttered 2026-11-09 on the owner's instruction: no "Calibrating the
// record" line, no "Listening" state and no session clock. Every figure
// left is real: the fact count is the record's own.

import { useTranslations } from "next-intl";
import { Logo } from "../brand/Mark";

export function Masthead({
  businessName,
  saving,
  factCount,
  pauseOpen,
  onPause,
}: {
  businessName: string | null;
  /** A request is in flight. */
  saving: boolean;
  factCount: number | null;
  pauseOpen: boolean;
  onPause: () => void;
}) {
  const t = useTranslations("intake.mast");
  const fig = (chunks: React.ReactNode) => <span className="fig">{chunks}</span>;

  return (
    <header className="ix-mast">
      <span className="ix-mark">
        <Logo onDark />
      </span>
      {businessName && <span className="ix-mast-sub">{businessName}</span>}
      <span className="ix-mast-right">
        {saving && (
          <span className="ix-machine" role="status">
            <span className="ix-machine-sq" aria-hidden="true" />
            {t("saving")}
          </span>
        )}
        {factCount !== null && (
          <span className="ix-mast-fig">{t.rich("facts", { count: factCount, fig })}</span>
        )}
        <button
          type="button"
          className="ix-pause"
          aria-expanded={pauseOpen}
          aria-controls="ix-pause-panel"
          onClick={onPause}
        >
          {t("pause")}
        </button>
      </span>
    </header>
  );
}
