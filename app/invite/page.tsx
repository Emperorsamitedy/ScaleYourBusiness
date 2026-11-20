// /invite?token=… — where a team invite lands (idea 52, I-52.4).
//
// Opening the link changes nothing: the page names the business, the role
// and the invited address first. Joining needs a sign-in proven for
// exactly that address — already signed in as it, or a sign-in link
// emailed to it from here. Signed in as anyone else, the page says so and
// offers only to sign out: a wrong person never joins.
//
// Decluttered 2026-11-09 on the owner's instruction: the headline, the
// role and address, and the one button; how joining works and why a bad
// invite fails sit under one closed disclosure.
//
// L-3c (TASKS-LANGUAGES.md): the page's own words are the "invite"
// catalogue, in the reader's language. The business's name and the
// addresses are shown as they are; the invite email itself is L-6.
//
// On the entrance's card since 2026-11-20, like sign-in itself.

import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { getTranslations } from "next-intl/server";
import { InviteActions } from "../../components/auth/InviteActions";
import { Logo } from "../../components/brand/Mark";
import { AUTH_COOKIE } from "../../lib/auth/access";
import { INVITE_TTL_DAYS, peekInvite } from "../../lib/auth/members";
import { currentSession } from "../../lib/auth/service";
import "../auth-v2.css";

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
  const pending = invite?.status === "pending";

  return (
    <div className="ax ax-signin">
      <Link href="/" className="ax-logo">
        <Logo onDark />
      </Link>
      <main className="ax-card" aria-labelledby="ax-invite-h">
        <div className="ax-head">
          <h1 className="ax-title" id="ax-invite-h">
            {pending ? t("headline.join", { where }) : t("headline.bad")}
          </h1>
          {invite && <p className="ax-sub">{t("title.as", { role, email: invite.email })}</p>}
        </div>
        {!invite ? (
          <details className="ax-how">
            <summary>{auth("why")}</summary>
            <p>{t("unknown")}</p>
          </details>
        ) : invite.status !== "pending" ? (
          <details className="ax-how">
            <summary>{auth("why")}</summary>
            <p>
              {invite.status === "expired"
                ? t("status.expired", { days: INVITE_TTL_DAYS })
                : t(`status.${invite.status}`)}{" "}
              {t("askNew")}
            </p>
          </details>
        ) : (
          <>
            {session && session.email !== invite.email ? (
              <>
                <p className="ax-copy">
                  {t.rich("wrong", { invited: invite.email, signedIn: session.email, b })}
                </p>
                <InviteActions token={token} mode="wrong" email={invite.email} />
              </>
            ) : (
              <InviteActions
                token={token}
                mode={session ? "join" : "sign_in"}
                email={invite.email}
              />
            )}
            <details className="ax-how">
              <summary>{auth("how")}</summary>
              {!session && <p>{t.rich("signIn", { email: invite.email, b })}</p>}
              <p>{t("foot")}</p>
            </details>
          </>
        )}
      </main>
      <p className="ax-switch">
        <Link href="/login">{pending ? auth("mast.signIn") : t("footLink")}</Link>
      </p>
    </div>
  );
}
