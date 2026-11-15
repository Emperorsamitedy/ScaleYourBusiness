"use client";

// The Why sheet (2026-11-15): where a figure's working-out lives once the
// page itself says only the answer. A paper sheet slides in from the
// right with the figure, its basis, where it came from, when it was true
// and the arithmetic, so provenance stays one press away and is never
// deleted (CLAUDE.md rules 2 and 6). Escape, the scrim or Close shuts it
// and focus goes back to the button that opened it.

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

export interface WhyContent {
  title: string;
  /** The figure itself, as printed on the page. */
  value?: string;
  /** Label → value rows: basis, source, when. */
  rows: { label: string; value: ReactNode }[];
  /** The arithmetic or the reasons, one line each, in mono. */
  lines?: string[];
}

export function WhySheet({
  content,
  onClose,
}: {
  content: WhyContent | null;
  onClose: () => void;
}) {
  const t = useTranslations("common.why");
  const close = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!content) return;
    opener.current = document.activeElement;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [content, onClose]);

  if (!content) return null;
  return (
    <div className="why-layer">
      <div className="why-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="why-sheet" role="dialog" aria-modal="true" aria-labelledby="why-title">
        <header className="why-head">
          <div className="why-top">
            <p className="why-label">{t("label")}</p>
            <button type="button" ref={close} className="why-close" onClick={onClose}>
              {t("close")}
            </button>
          </div>
          <h2 id="why-title" className="why-title">
            {content.title}
          </h2>
          {content.value && <p className="why-value">{content.value}</p>}
        </header>
        <div className="why-body">
          {content.rows.length > 0 && (
            <dl className="why-rows">
              {content.rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {content.lines && content.lines.length > 0 && (
            <div className="why-sec">
              <p className="why-label">{t("arithmetic")}</p>
              <div className="why-lines">
                {content.lines.map((l, i) => (
                  <p key={i}>{l}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
