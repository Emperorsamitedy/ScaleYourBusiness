// The terms and the privacy notice, until SYB supplies them. The
// sign-up footer links here; nothing on this page is legal text, so
// nothing on it can be mistaken for an agreement nobody wrote. `facts`
// are plain statements of how the product works today (idea 50: who
// hears a spoken answer), shown under the placeholder, not in its place.

import type { ReactNode } from "react";
import { AuthMasthead } from "./AuthMasthead";
import "../../app/auth.css";

export function LegalPlaceholder({
  label,
  title,
  facts,
}: {
  label: string;
  title: string;
  facts?: ReactNode;
}) {
  return (
    <div className="desk au">
      <AuthMasthead />
      <main className="au-legal">
        <section className="sheet au-sheet" aria-labelledby="au-legal-title">
          <header className="au-sheet-head">
            <p className="au-sheet-label">{label}</p>
            <h1 className="au-sheet-title" id="au-legal-title">
              {title}
            </h1>
          </header>
          <div className="au-sheet-body">
            <p>This document is to be supplied by SYB before launch.</p>
          </div>
          {facts && <div className="au-sheet-body au-legal-facts">{facts}</div>}
        </section>
      </main>
    </div>
  );
}
