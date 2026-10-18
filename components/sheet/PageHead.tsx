// The page head every owner screen opens with — the owner's instrument
// designs (2026-10-17): a mono kicker ("INSIGHTS · WATCHING"), one Zilla
// Slab headline that states the screen's main fact as a sentence, an
// optional mono line or action on the right, and a rule beneath.

import type { ReactNode } from "react";

export function PageHead({
  kicker,
  title,
  aside,
  children,
}: {
  /** e.g. "Insights · Watching" — set in mono caps. */
  kicker: string;
  /** The screen's one display line. */
  title: ReactNode;
  /** Right-aligned mono context or a single action. */
  aside?: ReactNode;
  /** Optional lines under the title (mono notes, a live status). */
  children?: ReactNode;
}) {
  return (
    <header className="ph">
      <div className="ph-main">
        <p className="ph-kicker">{kicker}</p>
        <h1 className="ph-title">{title}</h1>
        {children && <div className="ph-notes">{children}</div>}
      </div>
      {aside && <div className="ph-aside">{aside}</div>}
    </header>
  );
}

/** A paper card with the designs' header band: mono label, Zilla title, right-hand meta. */
export function SheetCard({
  label,
  title,
  meta,
  children,
  foot,
  className,
  id,
}: {
  label?: string;
  title?: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  foot?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`cs${className ? ` ${className}` : ""}`} id={id}>
      {(label || title || meta) && (
        <header className="cs-head">
          <div>
            {label && <p className="cs-label">{label}</p>}
            {title && <h2 className="cs-title">{title}</h2>}
          </div>
          {meta && <div className="cs-meta">{meta}</div>}
        </header>
      )}
      {children !== undefined && <div className="cs-body">{children}</div>}
      {foot && <footer className="cs-foot">{foot}</footer>}
    </section>
  );
}
