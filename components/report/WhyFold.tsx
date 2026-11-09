// One closed-by-default disclosure for the words an owner may want to check
// but needn't read every visit: how a figure was worked out, what a rule
// means, what a notice promises (the declutter of 2026-11-09, on the
// owner's instruction). Native <details>/<summary>, so it opens from the
// keyboard and a screen reader announces it as collapsed, and its text is
// in the page for print and search. The report's WHY toggles set its look.

import "../../app/why-fold.css";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

export function WhyFold({
  children,
  summary,
  className,
}: {
  children: ReactNode;
  /** The disclosure's own words; "How this works" when not given. */
  summary?: ReactNode;
  className?: string;
}) {
  const t = useTranslations("report.fold");
  return (
    <details className={`why-fold${className ? ` ${className}` : ""}`}>
      <summary>{summary ?? t("how")}</summary>
      <div className="why-fold-body">{children}</div>
    </details>
  );
}
