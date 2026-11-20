// The confirm step every emailed link now passes through (login CSRF,
// security audit 2026-10-17). Opening a link only shows this card; the
// button POSTs from our own page, which is the one way a link signs a
// browser in. Naming the address is the point: a link someone else sent
// you says whose it is before you press anything.
//
// Decluttered 2026-11-09 on the owner's instruction: the headline, the
// question and the button stay; why it asks (and, on a dead link, why the
// link died) sit under one closed "How this works" / "Why?".
//
// On the entrance's card since 2026-11-20 (components/auth/Login.tsx,
// app/auth-v2.css): everyone who signs in by link passes through this page,
// and it had kept the look from before the entrance was redesigned (a serif
// headline, capitals, an arrow on its button), so sign-in began in one
// product and continued in another.
//
// A plain HTML form, no client JavaScript: it works with scripts off,
// and there is nothing on the page for a link scanner to trigger.

import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Logo } from "../brand/Mark";
import "../../app/auth-v2.css";

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
    <div className="ax ax-signin">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card" aria-labelledby="ax-confirm-h">
        <div className="ax-head">
          <h1 className="ax-title" id="ax-confirm-h">
            {props.headline}
          </h1>
          {props.ok && <p className="ax-sub ax-confirm-who">{props.title}</p>}
        </div>

        {props.ok ? (
          <>
            {props.email ? (
              <p className="ax-copy">
                {t.rich("confirm.sentTo", {
                  email: props.email,
                  b: (chunks) => <strong>{chunks}</strong>,
                })}
              </p>
            ) : null}
            <form method="post" action={props.action} className="ax-form">
              {props.token !== null ? (
                <input type="hidden" name="token" value={props.token} />
              ) : null}
              <button className="ax-btn ax-primary" type="submit">
                {props.button}
              </button>
            </form>
            <details className="ax-how">
              <summary>{t("how")}</summary>
              <p>{props.note}</p>
            </details>
          </>
        ) : (
          <>
            <Link className="ax-btn ax-primary" href="/login">
              {t("confirm.newLink")}
            </Link>
            <details className="ax-how">
              <summary>{t("why")}</summary>
              <p>{props.message}</p>
            </details>
          </>
        )}
      </main>
    </div>
  );
}
