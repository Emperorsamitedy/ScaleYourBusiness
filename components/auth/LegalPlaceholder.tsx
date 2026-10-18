// The terms and the privacy notice, until Ledgerline supplies them. The
// sign-up footer links here; nothing on this page is legal text, so
// nothing on it can be mistaken for an agreement nobody wrote.

import { AuthMasthead } from "./AuthMasthead";
import "../../app/auth.css";

export function LegalPlaceholder({ label, title }: { label: string; title: string }) {
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
            <p>This document is to be supplied by Ledgerline before launch.</p>
          </div>
        </section>
      </main>
    </div>
  );
}
