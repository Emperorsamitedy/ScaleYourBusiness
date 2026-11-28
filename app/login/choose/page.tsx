// /login/choose — "Which business?" (idea 52, I-52.2).
//
// Where a sign-in lands when the email belongs to more than one business.
// It lists each business by its name and your role there — your own rows
// only, never anything inside a business — and each is a plain form post
// to /api/auth/switch. The one you're signed in to already continues
// straight in. "Add another business" makes a new one under the same email.
// Decluttered 2026-11-09 on the owner's instruction: no sheet label or
// instruction line; the one-business-never-shows-another note is folded.
// On the entrance's card since 2026-11-20, like sign-in itself.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "../../../components/brand/Mark";
import { AUTH_COOKIE } from "../../../lib/auth/access";
import { authErrorWords } from "../../../lib/auth/error-words";
import { membershipsFor } from "../../../lib/auth/members";
import { currentSession } from "../../../lib/auth/service";
import { requestLocale } from "../../../lib/i18n/server";
import { trFor } from "../../../lib/i18n/server-tr";
import "../../auth-v2.css";

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
    <div className="ax ax-signin">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card" aria-labelledby="ax-choose-h">
        <div className="ax-head">
          <h1 className="ax-title" id="ax-choose-h">
            {t("auth.choose.headline")}
          </h1>
          <p className="ax-sub">{t("auth.choose.signedInAs", { email: session.email })}</p>
        </div>
        {error && (
          <p className="ax-error" role="alert">
            {error}
          </p>
        )}
        <form method="post" action="/api/auth/switch" className="ax-doors">
          {list.map((m) =>
            m.account_id === session.account_id ? (
              <Link key={m.account_id} href="/home" className="ax-btn ax-door ax-choice">
                <span className="ax-choice-name">{m.business ?? t("common.businessUnnamed")}</span>
                <span className="ax-choice-role">{t(`common.roles.${m.role}`)}</span>
              </Link>
            ) : (
              <button
                key={m.account_id}
                type="submit"
                name="account_id"
                value={m.account_id}
                className="ax-btn ax-door ax-choice"
              >
                <span className="ax-choice-name">{m.business ?? t("common.businessUnnamed")}</span>
                <span className="ax-choice-role">{t(`common.roles.${m.role}`)}</span>
              </button>
            ),
          )}
        </form>
        <form method="post" action="/api/auth/business" className="ax-form">
          <button type="submit" className="ax-btn ax-primary">
            {t("auth.choose.add")}
          </button>
        </form>
        <details className="ax-how">
          <summary>{t("auth.how")}</summary>
          <p>{t("auth.choose.foot")}</p>
        </details>
      </main>
    </div>
  );
}
