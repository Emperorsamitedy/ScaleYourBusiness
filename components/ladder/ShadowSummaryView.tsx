// The day-30 shadow summary, as the owner and anyone they share it with see
// it (the v1 spec §4.2). Losses in plain sight; a business with no gains
// gets the same honest lines with zeros in them.

import type { ShadowSummary } from "../../lib/ladder/shadow-summary";
import type { AppLocale } from "../../lib/i18n/locales";
import { dayMonthYear, presentMoney } from "../../lib/i18n/format";
import type { Tr } from "../../lib/i18n/tr";

function amounts(
  list: { amount_minor: number; currency: string }[],
  locale: AppLocale,
  zero: string,
) {
  return list.length === 0
    ? zero
    : list.map((m) => presentMoney(m, locale, { whole: true })).join(" · ");
}

export function ShadowSummaryView({
  summary,
  tr,
  locale,
  zeroWith,
}: {
  summary: ShadowSummary;
  tr: Tr;
  locale: AppLocale;
  /** The business's own currency, for a "0" when nothing was measured in money. */
  zeroWith: string;
}) {
  const zero = presentMoney({ amount_minor: 0, currency: zeroWith }, locale, { whole: true });
  return (
    <section className="card">
      <span className="auth-eyebrow">{tr("title")}</span>
      <p className="auth-copy">
        {tr("period", {
          from: dayMonthYear(summary.from.slice(0, 10), locale),
          to: dayMonthYear(summary.to.slice(0, 10), locale),
        })}
      </p>
      {summary.changes === 0 && summary.still_open === 0 ? (
        <p className="auth-copy">{tr("none")}</p>
      ) : (
        <ul className="shadow-summary">
          <li>{tr("changes", { count: summary.changes })}</li>
          <li>
            {tr("gained", {
              count: summary.gained.count,
              amount: amounts(summary.gained.total, locale, zero),
            })}
          </li>
          <li>{tr("nothing", { count: summary.nothing })}</li>
          <li>
            {tr("lost", {
              count: summary.lost.count,
              amount: amounts(summary.lost.total, locale, zero),
            })}
          </li>
          {summary.unproven > 0 && <li>{tr("unproven", { count: summary.unproven })}</li>}
          {summary.still_open > 0 && <li>{tr("open", { count: summary.still_open })}</li>}
          <li>
            <b>{tr("net", { amount: amounts(summary.net, locale, zero) })}</b>
          </li>
        </ul>
      )}
    </section>
  );
}
