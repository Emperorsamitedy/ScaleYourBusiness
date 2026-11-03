// /invite?token=… — where a team invite lands (idea 52, I-52.4).
//
// Opening the link changes nothing: the page names the business, the role
// and the invited address first. Joining needs a sign-in proven for
// exactly that address — already signed in as it, or a sign-in link
// emailed to it from here. Signed in as anyone else, the page says so and
// offers only to sign out: a wrong person never joins.
//
// L-3c (TASKS-LANGUAGES.md): the page's own words are the "invite"
// catalogue, in the reader's language. The business's name and the
// addresses are shown as they are; the invite email itself is L-6.

import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { AuthMasthead } from "../../components/auth/AuthMasthead";
import { InviteActions } from "../../components/auth/InviteActions";
import { AUTH_COOKIE } from "../../lib/auth/access";
import { INVITE_TTL_DAYS, peekInvite } from "../../lib/auth/members";
import { currentSession } from "../../lib/auth/service";
import "../auth.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("invite.meta");
  return {
    title: t("title"),
    // The token is in this page's address; never hand it on.
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export const dynamic = "force-dynamic";

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const t = await getTranslations("invite");
  const auth = await getTranslations("auth");
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  const invite = await peekInvite(token);
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);

  const role = invite?.role ?? "viewer";
  const where = invite?.business ?? t("someBusiness");
  const b = (chunks: ReactNode) => <strong>{chunks}</strong>;

  return (
    <div className="desk au">
      <AuthMasthead href="/login">{auth("mast.signIn")} &rarr;</AuthMasthead>
      <main className="au-main">
        <section className="au-lede">
          <p className="au-kicker">{t("kicker")}</p>
          <h1 className="au-headline">
            {invite && invite.status === "pending"
              ? t("headline.join", { where })
              : t("headline.bad")}
          </h1>
        </section>

        <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
          <header className="au-sheet-head">
            <p className="au-sheet-label">{t("label")}</p>
            <h2 className="au-sheet-title" id="au-sheet-title">
              {invite ? t("title.as", { role, email: invite.email }) : t("title.none")}
            </h2>
          </header>
          <div className="au-sheet-body">
            {!invite ? (
              <p className="au-copy">{t("unknown")}</p>
            ) : invite.status !== "pending" ? (
              <p className="au-copy">
                {invite.status === "expired"
                  ? t("status.expired", { days: INVITE_TTL_DAYS })
                  : t(`status.${invite.status}`)}{" "}
                {t("askNew")}
              </p>
            ) : session && session.email !== invite.email ? (
              <>
                <p className="au-copy">
                  {t.rich("wrong", { invited: invite.email, signedIn: session.email, b })}
                </p>
                <InviteActions token={token} mode="wrong" email={invite.email} />
              </>
            ) : session ? (
              <>
                <p className="au-copy">
                  {t.rich("signedIn", { email: invite.email, where, role, b })}
                </p>
                <InviteActions token={token} mode="join" email={invite.email} />
              </>
            ) : (
              <>
                <p className="au-copy">{t.rich("signIn", { email: invite.email, b })}</p>
                <InviteActions token={token} mode="sign_in" email={invite.email} />
              </>
            )}
          </div>
          <footer className="au-sheet-foot">
            {invite && invite.status === "pending" ? (
              t("foot")
            ) : (
              <Link href="/login">{t("footLink")}</Link>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
