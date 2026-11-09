// /login/confirm?token=… — where an emailed sign-in link lands. Nothing
// signs in until the button is pressed (login CSRF, audit 2026-10-17).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ConfirmLink } from "../../../components/auth/ConfirmLink";
import { AuthError, LOGIN_TTL_MINUTES, peekLogin } from "../../../lib/auth/service";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.meta");
  return {
    title: t("confirm"),
    // The token is in this page's address; never hand it on.
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default async function ConfirmLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  const t = await getTranslations("auth.confirm");
  try {
    const { email } = await peekLogin(token);
    return (
      <ConfirmLink
        ok
        headline={t("headline")}
        title={t("title", { email })}
        // The title already names the address.
        email={null}
        action="/api/auth/redeem"
        token={token}
        button={t("button")}
        note={t("note")}
      />
    );
  } catch (error) {
    if (!(error instanceof AuthError)) throw error;
    return (
      <ConfirmLink
        ok={false}
        headline={t("expiredHeadline")}
        message={t("expiredMessage", { minutes: LOGIN_TTL_MINUTES })}
      />
    );
  }
}
