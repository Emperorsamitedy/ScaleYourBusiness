"use client";

// Home's "Needs you" (docs/DASHBOARD-OVERHAUL.md C4, C8): the waiting
// decisions, each answered in place or opened for a full read; then, as
// quiet rows, what else wants the owner (a connection that paused itself,
// a tight week in the cash forecast), each a link. When nothing waits it
// says so, and offers the next steps worked out from what Home already
// read (next-steps.ts). It is drawn only once the queue has been read: an
// unread queue is never "nothing needs you".

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { AppLocale } from "../../lib/i18n/locales";
import { DecisionCard } from "./DecisionCard";
import type { Answer, DecisionLike } from "./DecisionCard";
import { moneyRange, shortDay } from "./format";
import type { Ranked } from "./home-model";
import type { PendingLike } from "./home-model";
import type { NextStep } from "./next-steps";
import { NEXT_HREF } from "./next-steps";

type Waiting = PendingLike & DecisionLike & { expires_at?: string | null };

export function NeedsList<P extends Waiting>({
  ranked,
  total,
  signedIn,
  paused,
  tightWeek,
  steps,
  locale,
  onDecided,
  onReview,
}: {
  /** The decisions shown, the largest money range first. */
  ranked: readonly Ranked<P>[];
  /** How many wait in all; null when unknown. */
  total: number | null;
  signedIn: boolean | null;
  /** Write connections that paused themselves. */
  paused: number;
  /** The first week the cash forecast dips under the line, or null. */
  tightWeek: string | null;
  steps: readonly NextStep[];
  locale: AppLocale;
  onDecided: (id: string, answer: Answer) => void;
  onReview: (id: string) => void;
}) {
  const t = useTranslations("home");
  const nav = useTranslations("nav");
  const quiet = ranked.length === 0 && paused === 0 && tightWeek === null;
  return (
    <>
      {ranked.length > 0 && (
        <div className="home-cards">
          {ranked.map(({ proposal: p, range: r }) => (
            <DecisionCard
              key={p.id}
              proposal={p}
              range={r ? moneyRange(r, locale) : null}
              by={p.expires_at ? t("decisions.by", { date: shortDay(p.expires_at, locale) }) : null}
              signedIn={signedIn}
              onDecided={onDecided}
              onReview={onReview}
            />
          ))}
        </div>
      )}
      {(paused > 0 || tightWeek !== null) && (
        <ul className="home-attn">
          {paused > 0 && (
            <li>
              <p>{t("needs.paused", { count: paused })}</p>
              <Link className="home-btn" href="/connections">
                {nav("item.connections")}
              </Link>
            </li>
          )}
          {tightWeek !== null && (
            <li>
              <p>
                <span className="flag drift">{t("needs.tightFlag")}</span>{" "}
                {t("needs.tight", { date: shortDay(tightWeek, locale) })}
              </p>
              <Link className="home-btn" href="/cash">
                {nav("item.cash")}
              </Link>
            </li>
          )}
        </ul>
      )}
      {quiet && <p className="home-empty">{t("needs.empty")}</p>}
      {steps.length > 0 && (
        <section className="home-next" aria-labelledby="home-next-label">
          <p className="cs-label" id="home-next-label">
            {t("next.label")}
          </p>
          <ul>
            {steps.map((s) => (
              <li key={s}>
                <p>{t(`next.${s}.text`)}</p>
                <Link className="home-btn" href={NEXT_HREF[s]}>
                  {t(`next.${s}.go`)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {total !== null && total > ranked.length && (
        <Link className="home-more" href="/proposals">
          {t("needs.all", { count: total })}
        </Link>
      )}
    </>
  );
}
