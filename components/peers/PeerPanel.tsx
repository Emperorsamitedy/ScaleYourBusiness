// The live peer comparison — the v1 build spec §5, on the benchmarks screen
// above the Eurostat sheets and never mixed into them (§5.4).
//
// Each measured metric shows a distribution (§5.3): the middle half, the
// typical value, and where the reader sits — "from what you told me" when
// the reader's own figure is stated, not measured. The cohort is said in
// words, with every widening it took (§5.1). Below the floor it says only
// that there aren't enough yet (§5.2). Rendered on the server; the one
// button (contribute / stop) is ./PeerContribute.

import cohortsFile from "../../specs/peer-cohorts-v1.json";
import type { PeerBenchmark } from "../../lib/peers/benchmark";
import type { PeerMetric } from "../../lib/peers/cohort";
import { presentMoney } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { peerStrip } from "../benchmarks/peer-strip";
import { SheetCard } from "../sheet/PageHead";
import { RangeBar } from "../sheet/RangeBar";
import { PeerContribute } from "./PeerContribute";

const BANDS = (
  cohortsFile as { revenue_bands: { bands: { id: string; from: number; to: number | null }[] } }
).revenue_bands.bands;

function eurShort(minor: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "EUR",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(minor / 100); // not money: a band edge in words, never a figure
}

function bandWords(id: string, locale: AppLocale, tr: Tr): string {
  const b = BANDS.find((x) => x.id === id);
  if (!b) return tr("band.any");
  if (b.from === 0 && b.to !== null) return tr("band.under", { to: eurShort(b.to, locale) });
  if (b.to === null) return tr("band.over", { from: eurShort(b.from, locale) });
  return tr("band.range", { from: eurShort(b.from, locale), to: eurShort(b.to, locale) });
}

function placeWords(countries: readonly string[], locale: AppLocale): string {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  return new Intl.ListFormat([locale], { type: "conjunction" }).format(
    countries.map((c) => names.of(c) ?? c),
  );
}

function monthWords(month: string, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${month}-01T00:00:00Z`));
}

function valueWords(
  b: Extract<PeerBenchmark, { status: "served" }>,
  v: number,
  locale: AppLocale,
): string {
  if (b.unit === "money" && b.currency) {
    return presentMoney({ amount_minor: v, currency: b.currency }, locale, { whole: true });
  }
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    v / 10_000, // not money: basis points shown as a percentage
  );
}

function pctWords(p: number, locale: AppLocale): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    p / 100, // not money: a percentile
  );
}

function Served({
  b,
  locale,
  tr,
}: {
  b: Extract<PeerBenchmark, { status: "served" }>;
  locale: AppLocale;
  tr: Tr;
}) {
  const place =
    b.cohort.geography.kind === "country"
      ? placeWords([b.cohort.geography.code], locale)
      : placeWords(b.cohort.geography.countries, locale);
  const band = b.cohort.band === "any" ? tr("band.any") : bandWords(b.cohort.band, locale, tr);
  const list = new Intl.ListFormat([locale], { type: "conjunction" });
  const strip = b.own ? peerStrip(b.p25, b.p75, b.own.value) : null;
  return (
    <li className="pp-line">
      <b>{tr(`metric.${b.metric}`)}</b>
      <p className="bm-copy">
        {tr("middle", { p25: valueWords(b, b.p25, locale), p75: valueWords(b, b.p75, locale) })} ·{" "}
        {tr("typical", { p50: valueWords(b, b.p50, locale) })}
      </p>
      {b.precision.level === "rough" && (
        <p className="bm-copy pp-rough">
          {tr("rough", {
            list: list.format(
              b.precision.reasons.map((r) =>
                tr(`roughWhy.${r}`, { count: String(b.cohort.businesses) }),
              ),
            ),
          })}
        </p>
      )}
      {b.own && strip && (
        <div className="pp-strip">
          <RangeBar scale={strip.scale} band={strip.band} value={b.own.value} />
        </div>
      )}
      {b.own && (
        <p className="bm-copy">
          {tr(b.own.basis === "measured" ? "you" : "youStated", {
            value: valueWords(b, b.own.value, locale),
            pct: pctWords(b.own.percentile, locale),
          })}
        </p>
      )}
      <p className="bm-note">
        {tr("cohort", {
          count: String(b.cohort.businesses),
          nace: tr("nace", { code: b.cohort.nace }),
          place,
          band,
          month: monthWords(b.cohort.month, locale),
        })}
        {b.cohort.widened.length > 0 && (
          <>
            {" "}
            {tr("widened", { list: list.format(b.cohort.widened.map((w) => tr(`widen.${w}`))) })}
          </>
        )}
      </p>
    </li>
  );
}

export function PeerPanel({
  benchmarks,
  contributing,
  locale,
  tr,
}: {
  benchmarks: readonly PeerBenchmark[];
  contributing: boolean;
  locale: AppLocale;
  tr: Tr;
}) {
  const list = new Intl.ListFormat([locale], { type: "conjunction" });
  const served = benchmarks.filter(
    (b): b is Extract<PeerBenchmark, { status: "served" }> => b.status === "served",
  );
  const short = benchmarks.filter((b) => b.status === "not_enough");
  const unmeasured = benchmarks.filter((b) => b.status === "not_measured").map((b) => b.metric);
  const unplaced = benchmarks.some((b) => b.status === "unplaced");
  const month = served[0]?.cohort.month ?? short.find((b) => b.status === "not_enough")?.month;
  const names = (ms: readonly PeerMetric[]) => list.format(ms.map((m) => tr(`metric.${m}`)));

  return (
    <SheetCard label={tr("label")} title={tr("title")} className="pp-card">
      {unplaced ? (
        <p className="bm-copy">{tr("unplaced")}</p>
      ) : (
        <>
          {served.length > 0 && (
            <ul className="pp-list">
              {served.map((b) => (
                <Served key={b.metric} b={b} locale={locale} tr={tr} />
              ))}
            </ul>
          )}
          {short.length > 0 && (
            <p className="bm-copy">
              <b>{names(short.map((b) => b.metric))}</b> — {tr("notEnough")}
            </p>
          )}
          {served.length === 0 && <p className="bm-note">{tr("official")}</p>}
        </>
      )}
      {unmeasured.length > 0 && (
        <p className="bm-note">{tr("notMeasured", { list: names(unmeasured) })}</p>
      )}
      {month && <p className="bm-note">{tr("source", { month: monthWords(month, locale) })}</p>}
      <PeerContribute
        contributing={contributing}
        words={{
          on: tr("contribute.on"),
          off: tr("contribute.off"),
          stop: tr("contribute.stop"),
          start: tr("contribute.start"),
          failed: tr("contribute.failed"),
        }}
      />
    </SheetCard>
  );
}
