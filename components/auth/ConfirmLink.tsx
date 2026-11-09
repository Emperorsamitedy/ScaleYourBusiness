// The confirm step every emailed link now passes through (login CSRF,
// security audit 2026-10-17). Opening a link only shows this sheet; the
// button POSTs from our own page, which is the one way a link signs a
// browser in. Naming the address is the point: a link someone else sent
// you says whose it is before you press anything.
//
// Decluttered 2026-11-09 on the owner's instruction: the headline, the
// question and the button stay; why it asks (and, on a dead link, why the
// link died) sit under one closed "How this works" / "Why?".
//
// A plain HTML form, no client JavaScript: it works with scripts off,
// and there is nothing on the page for a link scanner to trigger.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AuthMasthead } from "./AuthMasthead";
import "../../app/auth.css";

export type ConfirmLinkProps =
  | {
      ok: true;
      headline: string;
      title: string;
      /** Who the link was sent to, when the title doesn't already say. */
      email: string | null;
      action: string;
      token: string | null;
      button: string;
      note: string;
    }
  | { ok: false; headline: string; message: string };

export async function ConfirmLink(props: ConfirmLinkProps) {
  const t = await getTranslations("auth");
  return (
    <div className="desk au">
      <AuthMasthead href="/login">{t("mast.signIn")} &rarr;</AuthMasthead>
      <main className="au-main">
        <section className="au-lede">
          <h1 className="au-headline" id="au-confirm-h">
            {props.headline}
          </h1>
        </section>

        {props.ok ? (
          <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
            <header className="au-sheet-head">
              <h2 className="au-sheet-title" id="au-sheet-title">
                {props.title}
              </h2>
            </header>
            <div className="au-sheet-body">
              {props.email ? (
                <p className="au-copy">
                  {t.rich("confirm.sentTo", {
                    email: props.email,
                    b: (chunks) => <strong>{chunks}</strong>,
                  })}
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
              <details className="au-how">
                <summary>{t("how")}</summary>
                <p>{props.note}</p>
              </details>
            </div>
          </section>
        ) : (
          <section className="sheet au-sheet" aria-labelledby="au-confirm-h">
            <div className="au-sheet-body">
              <Link className="au-primary" href="/login">
                <span>{t("confirm.newLink")}</span>
                <span className="au-arrow" aria-hidden="true">
                  &rarr;
                </span>
              </Link>
              <details className="au-how">
                <summary>{t("why")}</summary>
                <p>{props.message}</p>
              </details>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
