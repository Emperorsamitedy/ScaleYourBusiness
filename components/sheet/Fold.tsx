// One closed-by-default disclosure per section (2026-11-09, the owner's
// "no extra wordings"): what a rule needs reachable but nobody needs to read
// every visit (a forecast's basis, window and assumptions, provenance, the
// "too early" reasons) sits behind one short summary like "How this works".

import "../../app/fold.css";
import type { ReactNode } from "react";

export function Fold({
  summary,
  children,
  className,
}: {
  /** The one line shown while closed, e.g. "How this works". */
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={`fold${className ? ` ${className}` : ""}`}>
      <summary>{summary}</summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
