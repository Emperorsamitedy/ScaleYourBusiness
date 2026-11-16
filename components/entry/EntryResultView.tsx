// The free entry's result (v1 spec §8.2): one leak, named, with its euro
// range and its grade — always D, "your estimate", with what it rests on —
// one peer comparison from the live cohort, and what measuring it would
// take. Pure: the form (client) and the shared page (server) both render it.

import type { EntryResult } from "../../lib/entry/one-number";
import { presentMoney } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { peerStrip } from "../benchmarks/peer-strip";
import { RangeBar } from "../sheet/RangeBar";

const eur = (minor: number, locale: AppLocale) =>
  presentMoney({ amount_minor: minor, currency: "EUR" }, locale, { whole: true });

const pct = (bp: number, locale: AppLocale) =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(bp / 10_000); // not money: a rate

export function EntryResultView({
  result,
  tr,
  locale,
}: {
  result: EntryResult;
  tr: Tr;
  locale: AppLocale;
}) {
  const { leak, comparison } = result;
  const leakTop = leak.high_minor * 1.15; // not money: the strip's drawing scale
  const leakDrawn = leakTop > 0 && leak.low_minor >= 0 && leak.low_minor <= leak.high_minor;
  const strip =
    comparison.status === "served"
      ? peerStrip(comparison.p25, comparison.p75, result.own_minor)
      : null;
  return (
    <section className="card entry-result" aria-live="polite">
      <span className="auth-eyebrow">{tr("result.label")}</span>
      <h2 className="auth-title">{tr(`leak.${leak.id}`)}</h2>
      <p className="entry-figure">
        {tr("result.range", {
          low: eur(leak.low_minor, locale),
          high: eur(leak.high_minor, locale),
        })}
      </p>
      {leakDrawn && (
        <div className="entry-bar est">
          <RangeBar scale={[0, leakTop]} band={[leak.low_minor, leak.high_minor]} value={null} />
        </div>
      )}
      <p className="auth-copy">
        <b>{tr("result.grade")}</b>
      </p>
      <p className="auth-copy">
        {tr("result.basis", {
          low: pct(leak.basis.low_bp, locale),
          high: pct(leak.basis.high_bp, locale),
        })}
      </p>
      <p className="auth-copy">{tr(`measure.${leak.measure}`)}</p>

      <span className="auth-eyebrow entry-peer">{tr("peer.label")}</span>
      {comparison.status === "served" ? (
        <>
          {strip && (
            <div className="entry-bar">
              <RangeBar scale={strip.scale} band={strip.band} value={result.own_minor} />
            </div>
          )}
          <p className="auth-copy">
            {tr("peer.served", {
              count: String(comparison.cohort.businesses),
              p50: eur(comparison.p50, locale),
              p25: eur(comparison.p25, locale),
              p75: eur(comparison.p75, locale),
              own: eur(result.own_minor, locale),
            })}
          </p>
          {comparison.precision.level === "rough" && (
            <p className="auth-copy">
              <b>
                {tr("peer.rough", {
                  list: new Intl.ListFormat([locale], { type: "conjunction" }).format(
                    comparison.precision.reasons.map((r) =>
                      tr(`peer.roughWhy.${r}`, { count: String(comparison.cohort.businesses) }),
                    ),
                  ),
                })}
              </b>
            </p>
          )}
        </>
      ) : (
        <p className="auth-copy">{tr("peer.notEnough")}</p>
      )}
    </section>
  );
}
