"use client";

// Lex offers the interview where a conversation starts (docs/DASHBOARD-OVERHAUL.md,
// L8): a person who signs up lands in the app before any interview, and a
// business that has told nothing yet gives Lex nothing to answer from. So,
// in place of the questions it would suggest, Lex says so and offers to
// start. The words are Home's own (home.fresh), said once in every language.

import Link from "next/link";
import { useTranslations } from "next-intl";

export function InterviewOffer() {
  const t = useTranslations("home.fresh");
  return (
    <div className="ak-offer">
      <p className="ak-offer-say">
        <b>{t("title")}</b> {t("lede")}
      </p>
      <Link className="act solid" href="/intake">
        {t("start")}
      </Link>
    </div>
  );
}
