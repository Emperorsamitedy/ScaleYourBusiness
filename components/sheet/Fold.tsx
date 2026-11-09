"use client";

// One closed-by-default disclosure per section (the owner, 2026-11-09:
// "no extra wordings/texts are required"). What a rule requires an owner
// can check — how a figure was worked out, a forecast's basis and window,
// provenance, why — stays on the page, folded under "How this works" or
// "Why?", never deleted.

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import "../../app/fold.css";

export function Fold({
  label = "how",
  summary,
  className,
  children,
}: {
  /** "how" reads "How this works"; "why" reads "Why?"; a string is used as is. */
  label?: "how" | "why" | (string & {});
  /** A summary line of the caller's own; wins over `label`. */
  summary?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const t = useTranslations("common.fold");
  const line = summary ?? (label === "how" ? t("how") : label === "why" ? t("why") : label);
  return (
    <details className={className ? `fold ${className}` : "fold"}>
      <summary>{line}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
