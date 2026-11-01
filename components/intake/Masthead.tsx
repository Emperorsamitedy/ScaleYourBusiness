"use client";

// The intake masthead (owner design intake-v2): ink bar, cobalt rule under
// it. Left: the mark and the line naming the business — the record's own
// identity.legal_name, or none. Right: the machine state in cobalt, the
// session clock, the facts on file, and the way out.
//
// Every figure is real. "Listening" shows only while a question waits for
// an answer and "Saving…" only while a request is in flight; with neither,
// no state is claimed. The session clock is minutes since this page
// opened, on the browser's own clock — there is no session count in the
// data, so none is printed. The fact count is the record's own.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { num } from "../sheet/num";
import { useIntakeWords } from "./words";

/** How often the session clock re-reads the time. */
const TICK_MS = 30_000;

export function Masthead({
  businessName,
  machine,
  openedAt,
  factCount,
  pauseOpen,
  onPause,
}: {
  businessName: string | null;
  /** What the machine is doing right now, or null to claim nothing. */
  machine: "listening" | "saving" | null;
  /** When this page opened (ms since epoch). */
  openedAt: number;
  factCount: number | null;
  pauseOpen: boolean;
  onPause: () => void;
}) {
  const [now, setNow] = useState(openedAt);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  const minutes = Math.max(0, Math.floor((now - openedAt) / 60_000));
  const t = useTranslations("intake.mast");
  const { locale } = useIntakeWords();
  const fig = (chunks: React.ReactNode) => <span className="fig">{chunks}</span>;

  return (
    <header className="ix-mast">
      <span className="ix-mark">SYB</span>
      <span className="ix-mast-sub">
        {t("sub")}
        {businessName && <> · {businessName}</>}
      </span>
      <span className="ix-mast-right">
        {machine && (
          <span className="ix-machine" role="status">
            <span className="ix-machine-sq" aria-hidden="true" />
            {machine === "saving" ? t("saving") : t("listening")}
          </span>
        )}
        <span className="ix-mast-fig" title={t("sessionTitle")}>
          {t.rich("session", { minutes: num(minutes, 0, locale), fig })}
        </span>
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
