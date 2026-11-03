// /resume?token=… — where a resume link lands. This browser is switched
// to the interview only when the button is pressed (login CSRF, audit
// 2026-10-17).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ConfirmLink } from "../../components/auth/ConfirmLink";
import { ResumeError, peekResumeToken } from "../../lib/intake/resume";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("resume");
  return {
    title: t("meta"),
    // The token is in this page's address; never hand it on.
    referrer: "no-referrer",
    robots: { index: false, follow: false },
  };
}

export default async function ConfirmResumePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const raw = (await searchParams).token;
  const token = typeof raw === "string" ? raw : "";
  const t = await getTranslations("resume");
  try {
    const { email } = await peekResumeToken(token);
    return (
      <ConfirmLink
        ok
        kicker={t("kicker")}
        headline={t("headline")}
        label={t("label")}
        title={t("title")}
        email={email}
        action={`/resume/${encodeURIComponent(token)}`}
        token={null}
        button={t("button")}
        note={t("note")}
      />
    );
  } catch (error) {
    if (!(error instanceof ResumeError)) throw error;
    return (
      <ConfirmLink
        ok={false}
        kicker={t("kicker")}
        headline={t("deadHeadline")}
        message={t("deadMessage")}
      />
    );
  }
}
