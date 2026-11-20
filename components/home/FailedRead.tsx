"use client";

// A card whose read failed with nothing to show (docs/DASHBOARD-OVERHAUL.md
// C1): one sentence and a Retry button, where the card's lines would be. A
// failed read is never drawn as an empty success, and never as a missing
// card.

import { useTranslations } from "next-intl";

export function FailedRead({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations("home.failed");
  return (
    <div className="home-failed" role="status">
      <p>{t("text")}</p>
      <button type="button" className="home-btn" onClick={onRetry}>
        {t("retry")}
      </button>
    </div>
  );
}
