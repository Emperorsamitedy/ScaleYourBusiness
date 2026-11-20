// A card that is still reading (docs/DASHBOARD-OVERHAUL.md A5): a few quiet
// bars where its lines will be, never a spinner over the page. Hidden from
// screen readers; the card's own "Reading…" or `aria-busy` says it aloud.

import type { ReactElement } from "react";
import "../../app/ui-data.css";

export function Skeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}): ReactElement {
  return (
    <div className={className ? `ui-skel ${className}` : "ui-skel"} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
