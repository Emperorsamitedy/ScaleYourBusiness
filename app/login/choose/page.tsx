// /login/choose — "Which business?" (idea 52, I-52.2).
//
// Where a sign-in lands when the email belongs to more than one business.
// It lists each business by its name and your role there — your own rows
// only, never anything inside a business — and each is a plain form post
// to /api/auth/switch. The one you're signed in to already continues
// straight in. "Add another business" makes a new one under the same email.
// Decluttered 2026-11-09 on the owner's instruction: no sheet label or
// instruction line; the one-business-never-shows-another note is folded.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthMasthead } from "../../../components/auth/AuthMasthead";
import { AUTH_COOKIE } from "../../../lib/auth/access";
import { authErrorWords } from "../../../lib/auth/error-words";
import { membershipsFor } from "../../../lib/auth/members";
import { currentSession } from "../../../lib/auth/service";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import "../../auth.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return { title: t("choose"), robots: { index: false, follow: false } };
}

export const dynamic = "force-dynamic";

export default async function ChooseBusinessPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  if (!session) redirect("/login");
  const list = await membershipsFor(session.email);
  const raw = (await searchParams).error;
  const t = await getTranslations();
  // L-4a: the switch's English refusal, read back in the reader's language.
  const locale = await requestLocale();
  const error =
    typeof raw === "string"
      ? authErrorWords(raw.slice(0, 160), trFor(locale, "authWords"), locale)
      : null;

  return (
    <div className="desk au">
      <AuthMasthead />
      <main className="au-main">
        <section className="au-lede">
          <p className="au-kicker">{t("auth.choose.signedInAs", { email: session.email })}</p>
          <h1 className="au-headline" id="au-choose-h">
            {t("auth.choose.headline")}
          </h1>
        </section>

        <section className="sheet au-sheet" aria-labelledby="au-choose-h">
          <div className="au-sheet-body">
            {error && (
              <p className="au-error" role="alert">
                {error}
              </p>
            )}
            <form method="post" action="/api/auth/switch" className="au-form au-choose">
              {list.map((m) =>
                m.account_id === session.account_id ? (
                  <Link
                    key={m.account_id}
                    href={m.profile_id ? "/home" : "/intake"}
                    className="au-door"
                  >
                    <span>
                      {m.business ?? t("common.businessUnnamed")} · {t(`common.roles.${m.role}`)}
                    </span>
                    <span className="au-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                  </Link>
                ) : (
                  <button
                    key={m.account_id}
                    type="submit"
                    name="account_id"
                    value={m.account_id}
                    className="au-door"
                  >
                    <span>
                      {m.business ?? t("common.businessUnnamed")} · {t(`common.roles.${m.role}`)}
                    </span>
                    <span className="au-arrow" aria-hidden="true">
                      &rarr;
                    </span>
                  </button>
                ),
              )}
            </form>
            <form method="post" action="/api/auth/business" className="au-form">
              <button type="submit" className="au-primary">
                <span>{t("auth.choose.add")}</span>
                <span className="au-arrow" aria-hidden="true">
                  &rarr;
                </span>
              </button>
            </form>
            <details className="au-how">
              <summary>{t("auth.how")}</summary>
              <p>{t("auth.choose.foot")}</p>
            </details>
          </div>
        </section>
      </main>
    </div>
  );
}
