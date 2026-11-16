// The day-30 shadow summary, as the owner and anyone they share it with see
// it (the v1 spec §4.2). Losses in plain sight; a business with no gains
// gets the same honest lines with zeros in them.

import { Fragment } from "react";
import type { ShadowSummary } from "../../lib/ladder/shadow-summary";
import type { AppLocale } from "../../lib/i18n/locales";
import { dayMonthYear, presentMoney } from "../../lib/i18n/format";
import type { Tr } from "../../lib/i18n/tr";
import { HBars, SegBar } from "../charts/Viz";
import { gainLoss, shadowSegs } from "./shadow-viz";

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
  const whole = (m: { amount_minor: number; currency: string }) =>
    presentMoney(m, locale, { whole: true });
  const zero = whole({ amount_minor: 0, currency: zeroWith });
  const segs = shadowSegs(summary, (o) => tr(`viz.${o}`));
  const pairs = gainLoss(summary.gained.total, summary.lost.total);
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
        <>
          {segs.length > 0 && (
            <div className="card-viz">
              <SegBar segs={segs} label={tr("title")} />
              {pairs.map((p) => (
                <Fragment key={p.currency}>
                  {pairs.length > 1 && <p className="vz-cap">{p.currency}</p>}
                  <HBars
                    label={tr("net", {
                      amount: whole(
                        summary.net.find((m) => m.currency === p.currency) ?? {
                          amount_minor: 0,
                          currency: p.currency,
                        },
                      ),
                    })}
                    max={p.max}
                    rows={[
                      {
                        key: "gained",
                        label: tr("viz.gained"),
                        value: Math.abs(p.gained.amount_minor),
                        display: whole(p.gained),
                        tone: "ok",
                      },
                      {
                        key: "lost",
                        label: tr("viz.lost"),
                        value: Math.abs(p.lost.amount_minor),
                        display: whole(p.lost),
                        tone: "alarm",
                      },
                    ]}
                  />
                </Fragment>
              ))}
            </div>
          )}
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
        </>
      )}
    </section>
  );
}
