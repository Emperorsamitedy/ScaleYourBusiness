"use client";

// The app's one side sheet (docs/DASHBOARD-OVERHAUL.md A1): paper sliding
// in from the right over a scrim, with the cobalt rule on its edge, as the
// Why sheet always looked. It is a modal dialog: focus moves in, Tab stays
// inside, Escape and the scrim close it, focus returns to what opened it,
// and the page behind does not scroll (components/ui/overlay.ts). A phone
// gets the full screen. The Why sheet, Lex's sheet, the review of a
// decision and the list of shortcuts all run on it.

import { useEffect, useId, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "./IconButton";
import { useOverlay } from "./overlay";
import "../../app/ui.css";

export function Sheet({
  open,
  onClose,
  title,
  kicker,
  width = 520,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** The dialog's name, shown as its heading. */
  title: string;
  /** A small mono line above the title. */
  kicker?: string | undefined;
  /** Desktop width in px; a phone gets the full screen. */
  width?: number | undefined;
  /** A fixed foot: the answers of a review, a composer. */
  foot?: ReactNode;
  children: ReactNode;
}): ReactElement | null {
  const t = useTranslations("common");
  const id = useId();
  const root = useRef<HTMLElement>(null);
  // The portal's target exists only in the browser.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useOverlay(open && mounted, onClose, root);

  if (!open || !mounted) return null;
  return createPortal(
    <div className="ui-layer">
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={root}
        className="ui-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        tabIndex={-1}
        style={{ "--ui-sheet-w": `${width}px` } as CSSProperties}
      >
        <header className="ui-sheet-head">
          <div className="ui-sheet-top">
            {kicker ? <p className="ui-sheet-kicker">{kicker}</p> : <span />}
            <IconButton label={t("close")} onClick={onClose}>
              <X size={18} strokeWidth={1.75} aria-hidden="true" />
            </IconButton>
          </div>
          <h2 id={`${id}-title`} className="ui-sheet-title">
            {title}
          </h2>
        </header>
        <div className="ui-sheet-body">{children}</div>
        {foot && <footer className="ui-sheet-foot">{foot}</footer>}
      </aside>
    </div>,
    document.body,
  );
}
