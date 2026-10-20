// /resume?token=… — where a resume link lands. This browser is switched
// to the interview only when the button is pressed (login CSRF, audit
// 2026-10-17).

import type { Metadata } from "next";
import { ConfirmLink } from "../../components/auth/ConfirmLink";
import { ResumeError, peekResumeToken } from "../../lib/intake/resume";

export const metadata: Metadata = {
  title: "Carry on — Ledgerline",
  // The token is in this page's address; never hand it on.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function ConfirmResumePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  try {
    const { email } = await peekResumeToken(token);
    return (
      <ConfirmLink
        ok
        kicker="Your interview"
        headline="Pick up where you stopped."
        label="Confirm"
        title="Carry on with this interview?"
        email={email}
        action={`/resume/${encodeURIComponent(token)}`}
        token={null}
        button="Carry on"
        note="Not a link you asked for? Close this page. Nothing changes in this browser unless you press the button."
      />
    );
  } catch (error) {
    if (!(error instanceof ResumeError)) throw error;
    return (
      <ConfirmLink
        ok={false}
        kicker="Your interview"
        headline="That link has run out."
        message="Resume links stop working when they expire or are revoked. Sign in with your email and your interview is where you left it."
      />
    );
  }
}
