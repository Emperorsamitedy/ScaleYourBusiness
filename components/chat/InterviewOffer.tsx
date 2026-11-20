"use client";

// Lex offers the interview where a conversation starts (docs/DASHBOARD-OVERHAUL.md,
// L8): a person who signs up lands in the app before any interview, and a
// business that has told nothing yet gives Lex nothing to answer from. So,
// in place of the questions it would suggest, Lex says so and offers to
// start. The words are Home's own (home.fresh), said once in every language.
//
// The owner's fourth round (2026-11-20): two ways to do it. With Lex, who
// asks the same questions here in the conversation
// (components/chat/LexInterview.tsx), or the form, as before.

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTr } from "../sheet/useTr";

export function InterviewOffer({ onWithLex }: { onWithLex?: () => void }) {
  const t = useTranslations("home.fresh");
  const { tr } = useTr("chat");
  return (
    <div className="ak-offer">
      <p className="ak-offer-say">
        <b>{t("title")}</b> {t("lede")}
      </p>
      <p className="ak-offer-acts">
        {onWithLex && (
          <button type="button" className="act solid" onClick={onWithLex}>
            {tr("interview.withLex")}
          </button>
        )}
        <Link className={onWithLex ? "act" : "act solid"} href="/intake">
          {t("start")}
        </Link>
      </p>
    </div>
  );
}
