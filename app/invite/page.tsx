// /invite?token=… — where a team invite lands (idea 52, I-52.4).
//
// Opening the link changes nothing: the page names the business, the role
// and the invited address first. Joining needs a sign-in proven for
// exactly that address — already signed in as it, or a sign-in link
// emailed to it from here. Signed in as anyone else, the page says so and
// offers only to sign out: a wrong person never joins.

import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { AuthMasthead } from "../../components/auth/AuthMasthead";
import { InviteActions } from "../../components/auth/InviteActions";
import { AUTH_COOKIE } from "../../lib/auth/access";
import { peekInvite } from "../../lib/auth/members";
import { currentSession } from "../../lib/auth/service";
import "../auth.css";

export const metadata: Metadata = {
  title: "Your invite — SYB",
  // The token is in this page's address; never hand it on.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const STATUS_WORDS = {
  accepted: "This invite has already been used.",
  revoked: "This invite was withdrawn.",
  expired: "This invite has run out. Invites work for 7 days.",
} as const;

export default async function InvitePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  const invite = await peekInvite(token);
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);

  const role = invite?.role === "owner" ? "an owner" : invite ? `a ${invite.role}` : "";
  const where = invite?.business ?? "a business on SYB";

  return (
    <div className="desk au">
      <AuthMasthead href="/login">Sign in &rarr;</AuthMasthead>
      <main className="au-main">
        <section className="au-lede">
          <p className="au-kicker">Team invite</p>
          <h1 className="au-headline">
            {invite && invite.status === "pending" ? `Join ${where}.` : "That invite doesn't work."}
          </h1>
        </section>

        <section className="sheet au-sheet" aria-labelledby="au-sheet-title">
          <header className="au-sheet-head">
            <p className="au-sheet-label">Invite</p>
            <h2 className="au-sheet-title" id="au-sheet-title">
              {invite ? `As ${role}, for ${invite.email}` : "No invite here"}
            </h2>
          </header>
          <div className="au-sheet-body">
            {!invite ? (
              <p className="au-copy">
                This link isn&rsquo;t an invite I know. Ask whoever sent it for a new one.
              </p>
            ) : invite.status !== "pending" ? (
              <p className="au-copy">
                {STATUS_WORDS[invite.status]} Ask whoever sent it for a new one.
              </p>
            ) : session && session.email !== invite.email ? (
              <>
                <p className="au-copy">
                  This invite is for <strong>{invite.email}</strong>, and you&rsquo;re signed in as{" "}
                  <strong>{session.email}</strong>. I won&rsquo;t add the wrong person: sign out,
                  then open this link again.
                </p>
                <InviteActions token={token} mode="wrong" email={invite.email} />
              </>
            ) : session ? (
              <>
                <p className="au-copy">
                  You&rsquo;re signed in as <strong>{invite.email}</strong>. Join {where} as {role}?
                </p>
                <InviteActions token={token} mode="join" email={invite.email} />
              </>
            ) : (
              <>
                <p className="au-copy">
                  You&rsquo;ll sign in as <strong>{invite.email}</strong>, the address the invite is
                  for. I&rsquo;ll email a sign-in link there; opening it adds you to the team.
                </p>
                <InviteActions token={token} mode="sign_in" email={invite.email} />
              </>
            )}
          </div>
          <footer className="au-sheet-foot">
            {invite && invite.status === "pending" ? (
              "Nothing happens until you press the button. Not your address? Close this page."
            ) : (
              <Link href="/login">Sign in to SYB</Link>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
