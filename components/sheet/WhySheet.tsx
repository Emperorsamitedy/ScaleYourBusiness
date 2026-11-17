"use client";

// The Why sheet (2026-11-15): where a figure's working-out lives once the
// page itself says only the answer. The figure, its basis, where it came
// from, when it was true and the arithmetic, so provenance stays one press
// away and is never deleted (CLAUDE.md rules 2 and 6). It runs on the
// app's one side sheet (components/ui/Sheet.tsx): Escape, the scrim or
// Close shuts it and focus goes back to the button that opened it.

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Sheet } from "../ui/Sheet";

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
  return (
    <Sheet
      open={content !== null}
      onClose={onClose}
      title={content?.title ?? ""}
      kicker={t("label")}
      width={460}
    >
      {content?.value && <p className="ui-figure">{content.value}</p>}
      {content && content.rows.length > 0 && (
        <dl className="ui-kv">
          {content.rows.map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {content?.lines && content.lines.length > 0 && (
        <>
          <p className="ui-label">{t("arithmetic")}</p>
          <div className="ui-lines">
            {content.lines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}
