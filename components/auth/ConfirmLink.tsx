// The confirm step every emailed link now passes through (login CSRF,
// security audit 2026-10-17). Opening a link only shows this sheet; the
// button POSTs from our own page, which is the one way a link signs a
// browser in. Naming the address is the point: a link someone else sent
// you says whose it is before you press anything.
//
// A plain HTML form, no client JavaScript: it works with scripts off,
// and there is nothing on the page for a link scanner to trigger.

import Link from "next/link";
import { AuthMasthead } from "./AuthMasthead";
import "../../app/auth.css";

export type ConfirmLinkProps =
  | {
      ok: true;
      kicker: string;
      headline: string;
      label: string;
      title: string;
      /** Who the link was sent to, when known. */
      email: string | null;
      action: string;
      token: string | null;
      button: string;
      note: string;
    }
  | { ok: false; kicker: string; headline: string; message: string };

export function ConfirmLink(props: ConfirmLinkProps) {
  return (
    <div className="desk au">
      <AuthMasthead href="/login">Sign in &rarr;</AuthMasthead>
      <main className="au-main">
        <section className="au-lede">
          <p className="au-kicker">{props.kicker}</p>
          <h1 className="au-headline">{props.headline}</h1>
        </section>

        <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
          {props.ok ? (
            <>
              <header className="au-sheet-head">
                <p className="au-sheet-label">{props.label}</p>
                <h2 className="au-sheet-title" id="au-sheet-title">
                  {props.title}
                </h2>
              </header>
              <div className="au-sheet-body">
                {props.email ? (
                  <p className="au-copy">
                    This link was sent to <strong>{props.email}</strong>.
                  </p>
                ) : null}
                <form method="post" action={props.action} className="au-form">
                  {props.token !== null ? (
                    <input type="hidden" name="token" value={props.token} />
                  ) : null}
                  <button className="au-primary" type="submit">
                    <span>{props.button}</span>
                    <span className="au-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                  </button>
                </form>
              </div>
              <footer className="au-sheet-foot">{props.note}</footer>
            </>
          ) : (
            <>
              <header className="au-sheet-head">
                <p className="au-sheet-label">Link</p>
                <h2 className="au-sheet-title" id="au-sheet-title">
                  This link doesn&rsquo;t work any more
                </h2>
              </header>
              <div className="au-sheet-body">
                <p className="au-copy">{props.message}</p>
              </div>
              <footer className="au-sheet-foot">
                <Link href="/login">Email me a new sign-in link</Link>
              </footer>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
