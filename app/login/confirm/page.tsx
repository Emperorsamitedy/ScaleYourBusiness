// /login/confirm?token=… — where an emailed sign-in link lands. Nothing
// signs in until the button is pressed (login CSRF, audit 2026-10-17).

import type { Metadata } from "next";
import { ConfirmLink } from "../../../components/auth/ConfirmLink";
import { AuthError, peekLogin } from "../../../lib/auth/service";

export const metadata: Metadata = {
  title: "Confirm sign-in — Ledgerline",
  // The token is in this page's address; never hand it on.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

export default async function ConfirmLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  try {
    const { email } = await peekLogin(token);
    return (
      <ConfirmLink
        ok
        kicker="Sign in"
        headline="One more step."
        label="Confirm"
        title={`Sign in as ${email}?`}
        email={email}
        action="/api/auth/redeem"
        token={token}
        button="Sign in"
        note="Not your address? Close this page. Someone may have sent you their own link, and nothing happens unless you press the button."
      />
    );
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return (
      <ConfirmLink
        ok={false}
        kicker="Sign in"
        headline="That link has run out."
        message="Sign-in links work once and expire after 15 minutes. Ask for a new one and it will arrive in a moment."
      />
    );
  }
}
