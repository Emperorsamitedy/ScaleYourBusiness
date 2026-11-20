"use client";

// Tabs (docs/DASHBOARD-OVERHAUL.md A3): a row of tabs over one panel, drawn
// like the strip's own (mono capitals, the open one a paper tab that joins
// the sheet under it). The open tab is the row's only tab stop; ← → Home
// and End move between tabs and open the one they land on; a count sits
// beside a label when there is one. The caller keeps the choice (Home
// keeps it in the address, `?tab=`).

import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import "../../app/ui-data.css";

export interface TabItem<K extends string = string> {
  key: K;
  label: string;
  /** Shown beside the label when above zero. */
  count?: number | null;
}

/** Pure: the tab a key moves to from tab `index` of `count`; null when the key is not the row's. */
export function tabTarget(count: number, index: number, key: string): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
      return (index + 1) % count;
    case "ArrowLeft":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function Tabs<K extends string>({
  id,
  label,
  tabs,
  value,
  onChange,
}: {
  /** Ties each tab to its panel (`TabPanel` takes the same id). */
  id: string;
  /** The row's spoken name. */
  label: string;
  tabs: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
}): ReactElement {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const open = tabs.findIndex((t) => t.key === value);
  // On a narrow screen the row scrolls sideways. The open tab is brought to
  // the middle of it, so the tab that is open is never the one cut off at the
  // edge. Only the row moves: the page is never scrolled for it.
  useEffect(() => {
    const el = refs.current[open];
    const row = el?.parentElement;
    if (!el || !row || row.scrollWidth <= row.clientWidth) return;
    const a = el.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    row.scrollLeft += a.left - r.left - (r.width - a.width) / 2;
  }, [open]);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const to = tabTarget(tabs.length, index, e.key);
    const next = to === null ? undefined : tabs[to];
    if (to === null || !next) return;
    e.preventDefault();
    onChange(next.key);
    refs.current[to]?.focus();
  };
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${id}-tab-${t.key}`}
            aria-selected={on}
            aria-controls={`${id}-panel-${t.key}`}
            tabIndex={on ? 0 : -1}
            className={on ? "ui-tab on" : "ui-tab"}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span className="ui-tab-count">{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The panel of one tab; only the open one is in the page. With `keep` a
 * closed panel stays in the page, hidden: for a panel that holds a form a
 * person may have half filled in, or that reads something once when it is
 * first drawn (Connections).
 */
export function TabPanel({
  id,
  tab,
  open,
  keep = false,
  className,
  children,
}: {
  id: string;
  tab: string;
  open: boolean;
  keep?: boolean;
  className?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      role="tabpanel"
      id={`${id}-panel-${tab}`}
      aria-labelledby={`${id}-tab-${tab}`}
      hidden={!open}
      className={className}
    >
      {open || keep ? children : null}
    </div>
  );
}
