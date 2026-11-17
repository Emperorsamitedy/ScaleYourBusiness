// A control drawn as an icon (docs/DASHBOARD-OVERHAUL.md A6): search,
// notifications, close, the microphone, a row's disclosure. It always
// carries a spoken name, and the name is its tooltip. Icons are used only
// where a control would otherwise need a sentence.

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import "../../app/ui.css";

export function IconButton({
  label,
  badge,
  className,
  children,
  ref,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "title"> & {
  /** The spoken name: the action, never the icon ("Close", not "X"). */
  label: string;
  /** A small count on the corner; say it in `label` too. */
  badge?: string | number | null;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      {...rest}
      ref={ref}
      className={className ? `ui-icon-btn ${className}` : "ui-icon-btn"}
      aria-label={label}
      title={label}
    >
      {children}
      {badge !== null && badge !== undefined && badge !== "" && (
        <span className="ui-badge" aria-hidden="true">
          {badge}
        </span>
      )}
    </button>
  );
}
