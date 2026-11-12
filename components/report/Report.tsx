"use client";

// The diagnosis report — Session G (P1-34..41), UX spec §7, set as the
// owner's report design (2026-10-17): a focused view with its own ink
// masthead (AppFrame shows no rail here), a left sub-nav, the diagnostic
// panel, and a non-modal derivation sheet ("WHY →") beside it.
//
// Every figure is real: the panel's rows are the unit economics the
// service computed (each with derived_from + formula, rule 6) or refused
// to compute (with the reason); the derivation sheet's history is the
// superseded field_records of the inputs (rule 3). Where the data has no
// reference range, no money-a-month and no prior, the cell says "—" —
// components/report/panel.ts states each of those rules and tests them.
//
// Below the panel: the findings with their evidence, what was measured
// against what was said (rule 11), the recommendations with their two
// equal-weight answers, trading hours, and what would sharpen this.

import "../../app/report.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { CheckoutOptions } from "../../app/api/checkout/route";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { quietLine, splitByMateriality } from "../../lib/connectors/materiality";
import { gapBuysWords } from "../../lib/profile/gap-words";
import { hoursLineWords } from "../../lib/hours/words";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { delta, moneyFig, moneyText, num } from "../sheet/num";
import { SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import { ShareCard } from "./ShareCard";
import { WhyFold } from "./WhyFold";
import type { Basis } from "./basis";
import { BASES, basisMeaning, basisName, basisOf, gapWord, sourceLabel } from "./basis";
import {
  columnDecimals,
  fmtDate,
  fmtDay,
  forecastRange,
  isMoneyLike,
  numberDecimals,
  rangeText,
  severityFlag,
  signedMoney,
} from "./figures";
import type { MoneyLike } from "./figures";
import type { MeasureRow, PanelWords } from "./panel";
import {
  NOT_RECORDED,
  fig,
  headline,
  historyLines,
  inputLines,
  inputWords,
  panelRows,
  severityTally,
  valueText,
} from "./panel";
import type { FactInfo, FactMap, Rec, ReportView, StatedVsMeasuredRow } from "./types";

/** The menu's counts (app/api/nav) — the masthead and sub-nav print only what they know. */
interface NavCounts {
  business: string | null;
  watch: { day: number; of: number } | null;
  pending: number;
  facts: number;
  connections: number;
}

/** UX spec §7: reasons pre-filled as chips — a required field produces junk. */
const DECLINE_CHIPS = ["tried", "market", "now"] as const;

const CASES = new Set(["base", "downside", "upside"]);

const NONE = <span className="rq-none">—</span>;

/** The report's translator, its shared sheet words, and the reader's locale. */
function useWords() {
  const t = useTranslations("report");
  const sheet = useTr("sheet");
  const report = useTr("report");
  const econ = useTr("econWords");
  const words = useTr("reportWords");
  const hours = useTr("hoursWords");
  const w: PanelWords = { tr: report.tr, locale: report.locale, econ: econ.tr };
  return { t, st: sheet.tr, tr: report.tr, locale: report.locale, w, rw: words.tr, hw: hours.tr };
}

function useNav(): NavCounts | null {
  const [nav, setNav] = useState<NavCounts | null>(null);
  useEffect(() => {
    let alive = true;
    void fetch("/api/nav")
      .then(async (r) => (r.ok ? ((await r.json()) as NavCounts) : null))
      .then((n) => {
        if (alive && n) setNav(n);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return nav;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 17 Oct 2026 · 14:06" — the viewer's own clock; another language writes its own date. */
export function clockText(d: Date, locale: AppLocale = "en"): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const day =
    locale === "en"
      ? `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
      : new Intl.DateTimeFormat(intlTag(locale), {
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric",
        }).format(d);
  return `${day} · ${hh}:${mm}`;
}

/** The viewer's own clock, read after mount. */
function useClock(locale: AppLocale): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setNow(clockText(new Date(), locale));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [locale]);
  return now;
}

/* ── the masthead ── */

function Masthead({
  map,
  currency,
  nav,
}: {
  map: FactMap | null;
  currency: string | null;
  nav: NavCounts | null;
}) {
  const { t, locale } = useWords();
  const clock = useClock(locale);
  const business =
    map?.["identity.business_name"]?.value ??
    map?.["identity.legal_name"]?.value ??
    nav?.business ??
    null;
  const platform = map?.["presence.platforms"]?.value ?? null;
  const context = [business, platform, currency].filter((x): x is string => !!x);
  return (
    <header className="rq-mast">
      <div className="rq-mast-l">
        <Link href="/watch" className="rq-mark">
          SYB
        </Link>
        {context.length > 0 && <span className="rq-ctx">{context.join(" · ")}</span>}
      </div>
      <div className="rq-mast-r">
        {nav?.watch && (
          <span className="rq-live">
            <span className="rq-sq" aria-hidden="true" />
            {t("mast.watching", { day: nav.watch.day, of: nav.watch.of })}
          </span>
        )}
        {clock && <span className="rq-clock">{clock}</span>}
      </div>
    </header>
  );
}

/* ── the sub-nav ── */

function SubNav({ findings, nav }: { findings: number | null; nav: NavCounts | null }) {
  const { t, locale } = useWords();
  const count = (n: number | null | undefined) => (n == null ? "—" : num(n, 0, locale));
  return (
    <nav className="rq-sub noprint" aria-label={t("sub.label")}>
      <ul>
        <li>
          <a href="#rq-findings" className="rq-sub-i on" aria-current="page">
            <span>{t("sub.findings")}</span>
            <span className="rq-sub-n">{count(findings)}</span>
          </a>
        </li>
        <li>
          <Link href="/proposals" className="rq-sub-i">
            <span>{t("sub.decisions")}</span>
            <span className="rq-sub-n">{count(nav?.pending)}</span>
          </Link>
        </li>
        <li>
          <Link href="/profile" className="rq-sub-i">
            <span>{t("sub.record")}</span>
            <span className="rq-sub-n">{count(nav?.facts)}</span>
          </Link>
        </li>
        {/* No backing feature yet: shown, not linked, never counted. */}
        <li>
          <span className="rq-sub-i off" aria-disabled="true" title={t("sub.notBuilt")}>
            <span>{t("sub.shadow")}</span>
            <span className="rq-sub-n">—</span>
          </span>
        </li>
        <li>
          <span className="rq-sub-i off" aria-disabled="true" title={t("sub.notBuilt")}>
            <span>{t("sub.outcomes")}</span>
            <span className="rq-sub-n">—</span>
          </span>
        </li>
      </ul>
      <hr className="rq-sub-rule" />
      <ul>
        <li>
          <span className="rq-sub-i off" aria-disabled="true" title={t("sub.notBuilt")}>
            <span>{t("sub.rules")}</span>
            <span className="rq-sub-n">—</span>
          </span>
        </li>
        <li>
          <Link href="/connections" className="rq-sub-i">
            <span>{t("sub.connections")}</span>
            <span className="rq-sub-n">{count(nav?.connections)}</span>
          </Link>
        </li>
      </ul>
      <button type="button" className="rq-print" onClick={() => window.print()}>
        {t("sub.print")}
      </button>
    </nav>
  );
}

/* ── the provenance of one recorded fact ── */

function BasisWord({ basis }: { basis: Basis | null }) {
  const { t, st } = useWords();
  return <b className="rq-basis">{basis ? basisName(basis, st) : t("fact.basisNotRecorded")}</b>;
}

function FactLine({ f }: { f: FactInfo | undefined }): ReactNode {
  const { t, st, locale } = useWords();
  if (!f) return <>{t("fact.notInSnapshot")}</>;
  const basis = basisOf(f);
  return (
    <>
      {basis !== null ? (
        <BasisWord basis={basis} />
      ) : (
        <b className="rq-basis">{gapWord(f.status, st)}</b>
      )}{" "}
      · {sourceLabel(f.source_kind, st)}
      {f.observed_at !== undefined && <> · {fmtDate(f.observed_at, locale)}</>}
    </>
  );
}

/* ── the diagnostic panel ── */

function signed(m: MoneyLike, locale: AppLocale): string {
  return m.amount_minor < 0
    ? `−${moneyText(-m.amount_minor, m.currency, locale)}`
    : moneyText(m.amount_minor, m.currency, locale);
}

/**
 * L-5: the model wrote this report in its generator's language. A reader
 * in another language is told which, named in their own language; the
 * words are shown as written, never machine-translated on the way.
 */
function WrittenIn({ written, locale }: { written: string; locale: AppLocale }) {
  const mw = useTranslations("modelWords");
  if (written === locale) return null;
  let language = written;
  try {
    language =
      new Intl.DisplayNames([intlTag(locale)], { type: "language" }).of(written) ?? written;
  } catch {
    /* an unknown tag prints as itself */
  }
  return <p className="rq-label">{mw("reportWrittenIn", { language })}</p>;
}

function Panel({
  report,
  rows,
  selected,
  onWhy,
}: {
  report: ReportView;
  rows: MeasureRow[];
  selected: string | null;
  onWhy: (id: string) => void;
}) {
  const { t, tr, st, locale } = useWords();
  const head = headline(report.recommendations, report.diagnosis_grade ?? "D");
  const tally = severityTally(report.findings, tr);
  const notComputed = rows.filter((r) => r.result === null).length;
  const computed = rows.length - notComputed;
  const prior = report.prior ?? null;
  const perMonth = t("col.perMonth", { currency: report.unit_economics.currency });

  return (
    <section className="rq-panel" aria-labelledby="rq-panel-h">
      <header className="rq-panel-head">
        <p className="rq-label">
          {t("panel.label", {
            id: report.id.slice(0, 8),
            issued: fmtDate(report.generated_at, locale),
          })}
          {prior && t("panel.prior", { date: fmtDate(prior.generated_at, locale) })}
        </p>
        <h1 id="rq-panel-h" className="rq-head-line">
          {head ? (
            <>
              <span className="rq-big">
                {signed(head.range.low, locale)}–{signed(head.range.high, locale)}
              </span>{" "}
              <span className="rq-big-unit">
                {t("panel.headUnit", { ref: `R${head.index + 1}` })}
              </span>
            </>
          ) : rows.length > 0 ? (
            <>
              <span className="rq-big">
                {t("panel.computed", {
                  computed: num(computed, 0, locale),
                  total: num(rows.length, 0, locale),
                })}
              </span>{" "}
              <span className="rq-big-unit">{t("panel.computedUnit")}</span>
            </>
          ) : (
            <span className="rq-big rq-big-words">{t("panel.diagnosis")}</span>
          )}
        </h1>
        <p className="rq-tally">
          {tally.map((x, i) => (
            <span key={x.word}>
              {i > 0 && " · "}
              <b className={`rq-n ${x.tone}`}>{num(x.n, 0, locale)}</b> {x.word}
            </span>
          ))}
          {tally.length === 0 && <span>{t("panel.noFindings")}</span>}
          {notComputed > 0 && (
            <span>
              {" "}
              ·{" "}
              {t.rich("panel.notComputed", {
                count: notComputed,
                b: (chunks) => <b className="rq-n low">{chunks}</b>,
              })}
            </span>
          )}
        </p>
        <p className="rq-summary" lang={report.language ?? "en"}>
          {report.summary}
        </p>
        <WrittenIn written={report.language ?? "en"} locale={locale} />
      </header>

      {rows.length === 0 ? (
        <p className="rq-empty">{t("panel.empty")}</p>
      ) : (
        <div className="rq-table-wrap">
          <table className="rq-table">
            <caption className="sr-only">{t("panel.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("col.measure")}</th>
                <th scope="col" className="num">
                  {t("col.result")}
                </th>
                <th scope="col" className="num">
                  {t("col.prior")}
                </th>
                <th scope="col" className="rq-wrap">
                  {t("col.range")}
                </th>
                <th scope="col">{t("col.flag")}</th>
                <th scope="col" className="num rq-wrap">
                  {perMonth}
                </th>
                <th scope="col">{t("col.basis")}</th>
                <th scope="col">
                  <span className="sr-only">{t("col.derivation")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected === r.id ? "on" : undefined}>
                  <th scope="row" className="rq-measure">
                    {r.name}
                  </th>
                  <td className="num rq-result" data-label={t("col.result")}>
                    {r.result ? (
                      <>
                        {r.result.text}
                        {r.result.unit !== "" && <span className="rq-unit"> {r.result.unit}</span>}
                      </>
                    ) : (
                      NONE
                    )}
                  </td>
                  <td className="num rq-prior" data-label={t("col.priorReport")}>
                    {r.prior ? fig(r.prior) : NONE}
                  </td>
                  <td className="rq-range" data-label={t("col.rangeShort")}>
                    {NONE}
                  </td>
                  <td data-label={t("col.flag")}>
                    {r.flag ? <span className={`word ${r.flag.tone}`}>{r.flag.word}</span> : NONE}
                  </td>
                  <td className="num" data-label={perMonth}>
                    {NONE}
                  </td>
                  <td data-label={t("col.basis")}>
                    <span className="rq-basis-w">{r.basis ? basisName(r.basis, st) : "—"}</span>
                  </td>
                  <td className="rq-why-cell">
                    <button
                      type="button"
                      className="rq-why-btn"
                      aria-pressed={selected === r.id}
                      aria-controls="rq-why"
                      onClick={() => onWhy(r.id)}
                    >
                      {t("why.button")} <span aria-hidden="true">→</span>
                      <span className="sr-only">{t("why.buttonSr", { name: r.name })}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rq-legend">
        <WhyFold>{t("panel.legend")}</WhyFold>
      </div>
    </section>
  );
}

/* ── the derivation sheet (non-modal) ── */

function WhySheet({ report, row }: { report: ReportView; row: MeasureRow | null }) {
  const { t, st, w } = useWords();
  if (row === null) {
    return (
      <aside className="rq-why" id="rq-why" aria-label={t("why.sheet")}>
        <div className="rq-why-head">
          <p className="rq-label">{t("why.sheet")}</p>
          <h2 className="rq-why-title">{t("why.nothing")}</h2>
        </div>
        <div className="rq-why-body">
          <p className="rq-why-words">{t("why.choose")}</p>
        </div>
      </aside>
    );
  }
  const map = report.fact_map;
  const keys =
    row.computed?.derived_from ?? row.refusal?.missing.filter((k) => !k.includes("<")) ?? [];
  const inputs = inputLines(keys, map, w, st);
  const missingWords =
    row.refusal?.missing.filter((k) => k.includes("<")).map((k) => inputWords(k, map, w.tr)) ?? [];
  const lines = historyLines({
    row,
    issuedAt: report.generated_at,
    priorAt: report.prior?.generated_at ?? null,
    keys,
    history: report.history ?? {},
    map,
    words: w,
  });

  return (
    <aside className="rq-why" id="rq-why" aria-label={t("why.sheet")} aria-live="polite">
      <div className="rq-why-head">
        <p className="rq-label">{t("why.sheet")}</p>
        <h2 className="rq-why-title">{row.name}</h2>
        <p className="rq-why-fig">
          {row.result ? (
            <>
              <span className="rq-why-num">{row.result.text}</span>
              {row.result.unit !== "" && <span className="rq-why-unit"> {row.result.unit}</span>}
            </>
          ) : (
            <span className="rq-why-num">—</span>
          )}
          {row.flag && <span className={`word ${row.flag.tone}`}>{row.flag.word}</span>}
        </p>
      </div>
      <div className="rq-why-body">
        <p className="rq-label">{row.computed ? t("why.formula") : t("why.notComputed")}</p>
        <p className="rq-why-words">{row.computed ? row.words : row.refusal?.why}</p>
        {row.computed && <p className="rq-why-formula">{row.computed.formula}</p>}

        <p className="rq-label">{row.computed ? t("why.inputs") : t("why.missingInputs")}</p>
        {inputs.length === 0 && missingWords.length === 0 && (
          <p className="rq-why-none">{t("why.none")}</p>
        )}
        <ul className="rq-inputs">
          {inputs.map((i) => (
            <li key={i.key}>
              <div>
                <span className="rq-in-name">{i.name}</span>
                <span className="rq-in-src">
                  {i.source === NOT_RECORDED
                    ? row.computed
                      ? t("fact.notInSnapshot")
                      : t("why.missing")
                    : `${i.source} · ${i.basis ? basisName(i.basis, st) : t("why.basisNotRecorded")}`}
                </span>
              </div>
              <span className="rq-in-val">{i.value ?? "—"}</span>
            </li>
          ))}
          {missingWords.map((m) => (
            <li key={m}>
              <div>
                <span className="rq-in-name">{m.charAt(0).toUpperCase() + m.slice(1)}</span>
                <span className="rq-in-src">{t("why.missing")}</span>
              </div>
              <span className="rq-in-val">—</span>
            </li>
          ))}
        </ul>

        <p className="rq-label">{t("why.history")}</p>
        <ul className="rq-hist">
          {lines.map((l, i) => (
            <li key={`${l.date}-${i}`}>
              <span className="rq-hist-d">{l.date}</span>
              <span className="rq-hist-t">
                {l.fresh ? <span className="marked">{l.text}</span> : l.text}
              </span>
            </li>
          ))}
        </ul>
        {lines.length <= 1 && <p className="rq-why-none">{t("why.noHistory")}</p>}
      </div>
    </aside>
  );
}

/* ── below the panel ── */

function Evidence({ keys, map }: { keys: string[]; map: FactMap }) {
  const { tr, locale } = useWords();
  return (
    <ul className="rq-evidence">
      {keys.map((k) => {
        const f = map[k];
        const value = f ? valueText(f, locale) : null;
        return (
          <li key={k}>
            <span className="rq-ev-key">{inputWords(k, map, tr)}</span>
            {value !== null && (
              <>
                {" "}
                = <span className="fig">{value}</span>
              </>
            )}{" "}
            · <FactLine f={f} />
          </li>
        );
      })}
    </ul>
  );
}

function StatedVsMeasured({ rows, map }: { rows: StatedVsMeasuredRow[]; map: FactMap }) {
  const { t, tr, st, locale } = useWords();
  const monies = rows.flatMap((r) =>
    [r.stated.value, r.measured.value].filter((v): v is MoneyLike => isMoneyLike(v)),
  );
  const dec = columnDecimals(monies);
  const show = (v: unknown): ReactNode => {
    if (typeof v === "number") return num(v, numberDecimals([v]), locale);
    if (isMoneyLike(v)) return `${moneyFig(v.amount_minor, v.currency, dec, locale)} ${v.currency}`;
    // Words against a measurement (no-shows, specs/bookings.md §4): shown, not subtracted.
    if (typeof v === "string" && v.trim() !== "") return v;
    return NONE;
  };
  return (
    <div className="rq-table-wrap">
      <table className="rt rq-svm">
        <caption className="sr-only">{t("svm.caption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("svm.measure")}</th>
            <th scope="col" className="num">
              {t("svm.said")}
            </th>
            <th scope="col" className="num">
              {t("svm.measured")}
            </th>
            <th scope="col" className="num">
              {t("svm.difference")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const period = /over (\S+)\.\.(\S+)/.exec(s.measured.method);
            const statedBasis = basisOf(s.stated);
            const d = s.delta;
            return (
              <tr key={s.field_key}>
                <th scope="row">
                  {inputWords(s.field_key, map, tr).replace(/^./, (c) => c.toUpperCase())}
                  <span className="src rq-src">
                    {t("svm.observed", {
                      provider: s.provider,
                      when: period
                        ? `${fmtDate(period[1] ?? "", locale)} – ${fmtDate(period[2] ?? "", locale)}`
                        : t("svm.read", { date: fmtDate(s.measured.observed_at, locale) }),
                    })}
                  </span>
                  <span className="src rq-src">
                    {t("svm.yours", {
                      basis: statedBasis
                        ? basisName(statedBasis, st)
                        : gapWord(s.stated.status, st),
                      source: sourceLabel(s.stated.source_kind, st),
                      date: fmtDate(s.stated.observed_at, locale),
                    })}
                  </span>
                </th>
                <td className="num" data-label={t("svm.said")}>
                  {s.stated.value === null ? t("svm.notKnown") : show(s.stated.value)}
                </td>
                <td className="num" data-label={t("svm.measured")}>
                  {show(s.measured.value)}
                </td>
                <td className="num" data-label={t("svm.difference")}>
                  {d === null ? (
                    NONE
                  ) : (
                    <>
                      {d.currency !== null
                        ? signedMoney({ amount_minor: d.amount, currency: d.currency }, dec, locale)
                        : delta(d.amount, numberDecimals([d.amount]), locale)}
                      {d.pct !== null && <> ({delta(d.pct, 1, locale)} %)</>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Rule 11, with materiality (lib/connectors/materiality.ts): a delta that
 * matters is shown in full; the rest collapse into one quiet line with
 * their detail one click away. Nothing is dropped, and the analysis uses
 * the measured figure either way.
 */
function StatedVsMeasuredCard({ rows, map }: { rows: StatedVsMeasuredRow[]; map: FactMap }) {
  const { t, rw, locale } = useWords();
  const split = useMemo(() => splitByMateriality(rows), [rows]);
  const [open, setOpen] = useState(false);
  const line = quietLine(split.quiet, rows.length, rw, locale);
  return (
    <SheetCard
      className="rq-card"
      label={t("svm.label")}
      title={split.material.length === 0 ? t("svm.titleHeld") : t("svm.title")}
      foot={<WhyFold>{t("svm.foot")}</WhyFold>}
    >
      {split.material.length > 0 && <StatedVsMeasured rows={split.material} map={map} />}
      {line !== null && (
        <div className="rq-svm-quiet">
          <p className="rq-summary">{line}</p>
          <button
            type="button"
            className="act"
            aria-expanded={open}
            aria-controls="rq-svm-quiet-detail"
            onClick={() => setOpen((o) => !o)}
          >
            {open ? t("svm.hide") : t("svm.show")}
          </button>
          {open && (
            <div id="rq-svm-quiet-detail" className="rq-svm-quiet-detail">
              <StatedVsMeasured rows={split.quiet.map((q) => q.row)} map={map} />
            </div>
          )}
        </div>
      )}
    </SheetCard>
  );
}

function Decline({ onSubmit, busy }: { onSubmit: (reason: string) => void; busy: boolean }) {
  const { t } = useWords();
  const [reason, setReason] = useState("");
  // The chip's words are what is recorded as the reason: the owner's language, as given.
  const chips = DECLINE_CHIPS.map((c) => t(`decline.chip.${c}`));
  return (
    <div className="rp-decline">
      <p>{t("decline.lede")}</p>
      <div className="rp-chips">
        {chips.map((c) => (
          <button
            key={c}
            className={reason === c ? "rp-chip on" : "rp-chip"}
            aria-pressed={reason === c}
            onClick={() => setReason(reason === c ? "" : c)}
            disabled={busy}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="rp-decline-row">
        <input
          className="field"
          aria-label={t("decline.label")}
          placeholder={t("decline.placeholder")}
          value={chips.includes(reason) ? "" : reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
        <button className="ghost" onClick={() => onSubmit(reason)} disabled={busy}>
          {busy ? t("decline.recording") : t("decline.record")}
        </button>
      </div>
    </div>
  );
}

function Forecast({ rec }: { rec: Rec }) {
  const { t, locale } = useWords();
  const s = rec.scenario;
  const cases = [s.base_case, s.downside_case, s.upside_case];
  const range = forecastRange(s.downside_case, s.upside_case, s.base_case);
  const monies = cases.map((c) => c.profit_delta_monthly ?? null);
  const hasFigures = monies.some((m) => m !== null);
  const dec = columnDecimals(monies);
  const cur = range?.currency ?? monies.find((m) => m !== null)?.currency ?? null;
  return (
    <div className="rq-forecast">
      {range !== null && (
        <p className="rq-range-line">
          <span className="rq-label">{t("forecast.range")}</span>
          <span className="fig rq-range-fig">
            {rangeText(range, locale)}{" "}
            <span className="rq-unit">{t("col.perMonth", { currency: range.currency })}</span>
          </span>
        </p>
      )}
      <div className="rq-table-wrap">
        <table className="rt rq-cases">
          <caption className="sr-only">{t("forecast.caption", { title: rec.title })}</caption>
          <thead>
            <tr>
              <th scope="col">{t("forecast.case")}</th>
              {hasFigures && (
                <th scope="col" className="num">
                  {cur !== null ? t("col.perMonth", { currency: cur }) : t("forecast.perMonth")}
                </th>
              )}
              <th scope="col">{t("forecast.what")}</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((o) => (
              <tr key={o.case}>
                <th scope="row">{CASES.has(o.case) ? t(`case.${o.case as "base"}`) : o.case}</th>
                {hasFigures && (
                  <td
                    className="num"
                    data-label={
                      cur !== null ? t("col.perMonth", { currency: cur }) : t("forecast.perMonth")
                    }
                  >
                    {o.profit_delta_monthly
                      ? signedMoney(o.profit_delta_monthly, dec, locale)
                      : NONE}
                  </td>
                )}
                <td data-label={t("forecast.whatShort")}>
                  {o.statement}
                  {o.formula !== null && <code className="rq-formula">{o.formula}</code>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecommendationItem({
  rec,
  index,
  reportId,
  map,
  onChanged,
  readOnly,
}: {
  rec: Rec;
  index: number;
  reportId: string;
  map: FactMap;
  onChanged: () => Promise<void>;
  /** A shared link (idea 51): the recommendation as written, without the owner's answers. */
  readOnly: boolean;
}) {
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);

  const respond = useCallback(
    async (response: "look_into" | "not_for_us", reason?: string) => {
      setBusy(true);
      try {
        await fetch("/api/report/respond", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ report_id: reportId, index, response, reason }),
        });
        await onChanged();
      } finally {
        setBusy(false);
        setDeclining(false);
      }
    },
    [reportId, index, onChanged],
  );

  const { t, tr } = useWords();
  const addresses = rec.addresses.map((i) => `F${i + 1}`).join(", ");
  return (
    <li className="rq-item">
      <p className="rq-item-head">
        <span className="rq-ref">R{index + 1}</span>
        <span className="rq-label">
          {t("rec.meta", { effort: rec.effort, undo: rec.reversibility.level })}
          {addresses !== "" && t("rec.answers", { refs: addresses })}
        </span>
      </p>
      <h3 className="rq-item-title">{rec.title}</h3>
      <p className="rq-prose">{rec.rationale}</p>
      <Forecast rec={rec} />
      <p className="rq-inset">
        <span className="rq-label">{t("rec.breakEven")}</span> {rec.scenario.breakeven_condition}
      </p>
      {rec.sensitivity_callouts.map((c) => (
        <p className="rq-prose" key={c}>
          <span className="word drift">{t("rec.highSensitivity")}</span> {c}
        </p>
      ))}
      <p className="rq-label rq-sub-h">{t("rec.assumptions")}</p>
      <ul className="rq-evidence">
        {rec.scenario.assumptions.map((a) => {
          const f = a.source_field !== null ? map[a.source_field] : undefined;
          return (
            <li key={a.statement}>
              <span className="rq-ev-text">{a.statement}</span> ·{" "}
              {a.source_field !== null ? (
                <>
                  <FactLine f={f} /> ·{" "}
                  {t("rec.from", { input: inputWords(a.source_field, map, tr) })}
                </>
              ) : (
                <>
                  <BasisWord basis="ASSUMED" /> · {t("rec.nobody")}
                </>
              )}{" "}
              · {t("rec.sensitivity", { level: a.sensitivity })}
            </li>
          );
        })}
      </ul>
      <p className="rq-prose">
        <strong>{t("rec.changeMind")}</strong> {rec.reversibility.if_you_change_your_mind}
      </p>

      {/* §8: two actions, equal visual weight — "no" is a legitimate answer */}
      {!readOnly && rec.status === "proposed" && !declining && (
        <div className="rp-actions">
          <button className="rp-act" onClick={() => void respond("look_into")} disabled={busy}>
            {t("rec.lookInto")}
          </button>
          <button className="rp-act" onClick={() => setDeclining(true)} disabled={busy}>
            {t("rec.notForUs")}
          </button>
        </div>
      )}
      {!readOnly && declining && (
        <Decline busy={busy} onSubmit={(reason) => void respond("not_for_us", reason)} />
      )}
      {!readOnly && rec.status === "accepted" && (
        <p className="rq-responded">
          <span className="rq-label">{t("rec.recorded")}</span> {t("rec.lookingInto")}
        </p>
      )}
      {!readOnly && rec.status === "rejected" && (
        <p className="rq-responded">
          <span className="rq-label">{t("rec.declined")}</span>
          {rec.rejection_reason !== null
            ? ` ${t("rec.reason", { reason: rec.rejection_reason })}`
            : ` ${t("rec.noReason")}`}
        </p>
      )}
    </li>
  );
}

/**
 * The report itself, below the masthead — shared by the owner's screen and
 * the read-only shared link (idea 51). Read-only drops every action and
 * every link into the account: the recommendation answers, "Answer now",
 * "See every weekday".
 */
export function ReportBody({
  report,
  readOnly,
  onChanged,
  foot,
  children,
}: {
  report: ReportView;
  readOnly: boolean;
  onChanged: () => Promise<void>;
  /** The footer's last line: the snapshot reference, or the shared-link note. */
  foot: ReactNode;
  /** Owner-only sections drawn above the footer (the share card). */
  children?: ReactNode;
}) {
  const { t, st, w, rw, hw, locale } = useWords();
  const tb = useTranslations("reportBenchmark");
  const [selected, setSelected] = useState<string | null>(null);
  const whyRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(
    () => panelRows(report.unit_economics, report.prior?.unit_economics ?? null, w),
    [report, w],
  );
  const current =
    rows.find((r) => r.id === selected) ?? rows.find((r) => r.result !== null) ?? rows[0] ?? null;

  const onWhy = useCallback((id: string) => {
    setSelected(id);
    // Stacked under the panel on a narrow screen: bring the sheet into view.
    if (window.matchMedia("(max-width: 900px)").matches) {
      whyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const eco = report.unit_economics;
  const map = report.fact_map;
  const measured = eco.stated_vs_measured ?? [];

  return (
    <>
      <div className="rq-top">
        <Panel report={report} rows={rows} selected={current?.id ?? null} onWhy={onWhy} />
        <div ref={whyRef} className="rq-why-slot">
          <WhySheet report={report} row={current} />
        </div>
      </div>

      {/* ── findings: a worded flag; colour only tints the word ── */}
      <SheetCard
        id="rq-findings"
        className="rq-card"
        label={t("findings.label")}
        title={
          report.findings.length === 0
            ? t("findings.none")
            : t("findings.title", { count: report.findings.length })
        }
      >
        {report.findings.length > 0 ? (
          <ol className="rq-list">
            {report.findings.map((f, i) => {
              const flag = severityFlag(f.severity, st);
              return (
                <li className="rq-item" key={f.title}>
                  <p className="rq-item-head">
                    <span className="rq-ref">F{i + 1}</span>
                    <span className={`word ${flag.tone}`}>{flag.word}</span>
                    <span className="rq-label">{f.area.replace(/_/g, " ")}</span>
                    {f.kind === "measured" && (
                      <span className="rq-label" title={t("findings.measuredTitle")}>
                        · {t("findings.measured")}
                      </span>
                    )}
                    {f.kind === "benchmark" && (
                      <span className="rq-label" title={tb("title")}>
                        · {tb("label")}
                      </span>
                    )}
                  </p>
                  <h3 className="rq-item-title">{f.title}</h3>
                  <p className="rq-prose">{f.detail}</p>
                  <Evidence keys={f.evidence} map={map} />
                </li>
              );
            })}
          </ol>
        ) : undefined}
      </SheetCard>

      {/* Rule 11 (P2-11): a measurement replaced an estimate, and both are shown. */}
      {measured.length > 0 && <StatedVsMeasuredCard rows={measured} map={map} />}

      {/* ── recommendations with scenarios and the two equal actions ── */}
      <SheetCard
        className="rq-card"
        label={t("recs.label")}
        title={
          report.recommendations.length === 0
            ? t("recs.none")
            : t("recs.title", { count: report.recommendations.length })
        }
      >
        {report.recommendations.length > 0 ? (
          <ol className="rq-list">
            {report.recommendations.map((rec, i) => (
              <RecommendationItem
                key={rec.title}
                rec={rec}
                index={i}
                reportId={report.id}
                map={map}
                onChanged={onChanged}
                readOnly={readOnly}
              />
            ))}
          </ol>
        ) : undefined}
      </SheetCard>

      {/* ── trading hours (P2-30): measured, deterministic, the arithmetic shown ── */}
      {report.trading_hours && (
        <SheetCard
          className="rq-card"
          label={t("hours.label", {
            from: fmtDay(report.trading_hours.from, undefined, locale),
            to: fmtDay(report.trading_hours.to, undefined, locale),
          })}
          title={
            report.trading_hours.findings.length === 0
              ? t("hours.none")
              : t("hours.title", { count: report.trading_hours.findings.length })
          }
          meta={hoursLineWords(report.trading_hours.coverage, hw, locale)}
          foot={
            <>
              {hoursLineWords(report.trading_hours.limit, hw, locale)}
              {!readOnly && (
                <>
                  {" "}
                  <Link href="/hours">{t("hours.link")}</Link>
                </>
              )}
            </>
          }
        >
          <ul className="rq-list">
            {report.trading_hours.findings.map((f) => (
              <li className="rq-item" key={f.signal}>
                <p className="rq-item-head">
                  {f.signal === "too_early" ? (
                    <span className="word low">{t("hours.tooEarly")}</span>
                  ) : (
                    <span className="rq-label">{f.weekdays.join(" · ")}</span>
                  )}
                </p>
                <h3 className="rq-item-title">{f.title}</h3>
                <p className="rq-prose">{f.detail}</p>
                {f.arithmetic.length > 0 && (
                  <ul className="rq-evidence">
                    {f.arithmetic.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </SheetCard>
      )}

      {/* ── what would sharpen this ── */}
      {report.data_gaps.length > 0 && (
        <SheetCard className="rq-card" label={t("gaps.label")}>
          <ul className="rq-list">
            {report.data_gaps.map((g) => (
              <li className="rq-gap" key={g.question_id}>
                <div>
                  <p className="rq-item-head">
                    <span className="rq-label">{t("gaps.priority", { priority: g.priority })}</span>
                    {g.blocking && <span className="word drift">{t("gaps.blocking")}</span>}
                  </p>
                  <p className="rq-gap-q">{g.prompt}</p>
                  <p className="rq-gap-b">{gapBuysWords(g.buys, g.priority, rw, locale)}</p>
                </div>
                {!readOnly && (
                  <Link
                    className="ghost quiet noprint"
                    href={`/intake?ask=${encodeURIComponent(g.question_id)}`}
                  >
                    {t("gaps.answer")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </SheetCard>
      )}

      {children}

      <footer className="rq-foot">
        <p>{foot}</p>
        <WhyFold>
          <p>
            {BASES.map((b, i) => (
              <span key={b}>
                {i > 0 && " · "}
                <b>{basisName(b, st)}</b> {basisMeaning(b, st)}
              </span>
            ))}
          </p>
          <p>{t("foot")}</p>
        </WhyFold>
      </footer>
    </>
  );
}

/* ── the screen ── */

function Shell({
  map,
  currency,
  nav,
  findings,
  children,
}: {
  map: FactMap | null;
  currency: string | null;
  nav: NavCounts | null;
  findings: number | null;
  children: ReactNode;
}) {
  return (
    <div className="rq">
      <Masthead map={map} currency={currency} nav={nav} />
      <div className="rq-grid">
        <SubNav findings={findings} nav={nav} />
        <main className="rq-main">{children}</main>
      </div>
    </div>
  );
}

/**
 * I-52a: one checkout for several businesses. This business at the report
 * price, each ticked one at the extra price; the total is shown before
 * Stripe opens.
 */
export function CheckoutChoice({
  options,
  also,
  onToggle,
  onPay,
  onCancel,
}: {
  options: CheckoutOptions;
  also: string[];
  onToggle: (profileId: string) => void;
  onPay: () => void;
  onCancel: () => void;
}) {
  const { first_price: price, extra_price } = options;
  const total = checkoutTotal(price.amount_minor, extra_price.amount_minor, also.length);
  const returning = price.amount_minor !== options.price.amount_minor;
  const { t, locale } = useWords();
  const tc = useTranslations("common");
  const money = (minor: number, currency: string) => moneyText(minor, currency, locale);
  return (
    <>
      <p className="rq-prose">
        {returning
          ? t("checkout.priceReturning", { price: money(price.amount_minor, price.currency) })
          : t("checkout.price", { price: money(price.amount_minor, price.currency) })}
        {options.others.length > 0 && (
          <>
            {" "}
            {t("checkout.others", {
              count: options.others.length,
              price: money(extra_price.amount_minor, extra_price.currency),
            })}
          </>
        )}
      </p>
      {options.others.length > 0 && (
        <ul className="rp-also">
          {options.others.map((o) => (
            <li key={o.profile_id}>
              <label>
                <input
                  type="checkbox"
                  checked={also.includes(o.profile_id)}
                  onChange={() => onToggle(o.profile_id)}
                />{" "}
                {o.business ?? tc("businessUnnamed")} ·{" "}
                {money(extra_price.amount_minor, extra_price.currency)}
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="rq-prose">
        {t("checkout.total", { total: money(total, price.currency), count: also.length + 1 })}
      </p>
      <div className="rp-actions">
        <button className="rp-act" onClick={onPay}>
          {t("checkout.pay", { total: money(total, price.currency) })}
        </button>
        <button className="rp-act" onClick={onCancel}>
          {t("checkout.notNow")}
        </button>
      </div>
    </>
  );
}

/** Pure: one checkout's total, this business in full and each added one at the extra price. */
export function checkoutTotal(full: number, extra: number, added: number): number {
  return full + extra * Math.max(0, added);
}

/** Review 2026-11-01: how long to wait for Stripe's confirmation after coming back (about 30 s). */
const CONFIRM_TRIES = 10;
const CONFIRM_WAIT_MS = 3_000;

export function ReportScreen() {
  const nav = useNav();
  const { t } = useWords();
  const [report, setReport] = useState<ReportView | null>(null);
  const [state, setState] = useState<
    "loading" | "none" | "generating" | "choosing" | "ready" | "error"
  >("loading");
  const [step, setStep] = useState<"reading" | "checkout" | "confirming">("reading");
  const [error, setError] = useState<string | null>(null);
  // I-52a: the owner's other unpaid businesses, offered in the same checkout.
  const [options, setOptions] = useState<CheckoutOptions | null>(null);
  const [also, setAlso] = useState<string[]>([]);

  const load = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/report");
    if (res.ok) {
      setReport((await res.json()) as ReportView);
      setState("ready");
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (!(await load())) setState("none");
      } catch {
        setState("error");
      }
    })();
  }, [load]);

  const pay = useCallback(
    async (ids: string[]) => {
      setState("generating");
      setStep("checkout");
      setError(null);
      try {
        const checkout = await fetch("/api/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ also: ids }),
        });
        const payload = (await checkout.json().catch(() => null)) as {
          checkout_url?: string;
          error?: string;
        } | null;
        if (checkout.ok && payload?.checkout_url) {
          window.location.href = payload.checkout_url;
          return;
        }
        setError(payload?.error ?? t("state.payFailed"));
      } catch {
        setError(t("state.payUnreachable"));
      }
      setState(report ? "ready" : "none");
    },
    [report, t],
  );

  const generate = useCallback(
    async (afterPayment = false) => {
      setState("generating");
      setStep(afterPayment ? "confirming" : "reading");
      setError(null);
      try {
        let res = await fetch("/api/report", { method: "POST" });
        // Review 2026-11-01: back from Stripe, the webhook may still be on its
        // way. Wait for it rather than open another checkout, which could
        // charge twice (and, since I-52a, offer just-paid businesses again).
        for (
          let tries = 0;
          afterPayment && res.status === 402 && tries < CONFIRM_TRIES;
          tries += 1
        ) {
          await new Promise((r) => setTimeout(r, CONFIRM_WAIT_MS));
          res = await fetch("/api/report", { method: "POST" });
        }
        if (res.status === 402 && afterPayment) {
          setError(t("state.notConfirmed"));
          setState(report ? "ready" : "none");
          return;
        }
        if (res.status === 402) {
          // P1-50: the report is paid. Start checkout and hand the browser
          // to Stripe; the webhook makes it real, and coming back here with
          // ?checkout=success retries generation against the paid record.
          // I-52a: an owner with other unpaid businesses is offered them first.
          setStep("checkout");
          const opts = await fetch("/api/checkout")
            .then((r) => (r.ok ? (r.json() as Promise<CheckoutOptions>) : null))
            .catch(() => null);
          // I-52e: a lower first price is said before Stripe opens, too.
          if (
            opts &&
            (opts.others.length > 0 || opts.first_price.amount_minor !== opts.price.amount_minor)
          ) {
            setOptions(opts);
            setAlso([]);
            setState("choosing");
            return;
          }
          await pay([]);
          return;
        }
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(payload?.error ?? t("state.generationFailed"));
          setState(report ? "ready" : "none");
          return;
        }
        setReport((await res.json()) as ReportView);
        setState("ready");
      } catch {
        setError(t("state.unreachable"));
        setState(report ? "ready" : "none");
      }
    },
    [report, pay, t],
  );

  // Back from Stripe: kick generation once, waiting for the webhook if it
  // is still in flight (never a second checkout). Deliberately mount-only.
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    if (new URLSearchParams(window.location.search).get("checkout") === "success") {
      window.history.replaceState(null, "", "/report");
      void generate(true);
    }
  }, [generate]);

  /* ── P1-41: the three non-report states ── */
  if (state !== "ready" || report === null) {
    return (
      <Shell map={null} currency={null} nav={nav} findings={null}>
        <SheetCard
          label={t("state.label")}
          title={state === "none" ? t("state.noReport") : t("panel.diagnosis")}
        >
          {state === "loading" && (
            <p className="rq-prose" role="status">
              {t("state.checking")}
            </p>
          )}
          {state === "error" && (
            <p className="rq-prose" role="alert">
              {t("state.error")}
            </p>
          )}
          {state === "generating" && (
            <>
              {/* An honest status line, live only while the request is in flight. */}
              <p className="rq-status live" role="status" aria-live="polite">
                <span className="live-dot" aria-hidden="true" />{" "}
                {step === "checkout"
                  ? t("state.openingCheckout")
                  : step === "confirming"
                    ? t("state.confirming")
                    : t("state.reading")}
              </p>
              <p className="rq-prose">{t("state.readingLede")}</p>
            </>
          )}
          {state === "choosing" && options && (
            <CheckoutChoice
              options={options}
              also={also}
              onToggle={(id) =>
                setAlso((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
              }
              onPay={() => void pay(also)}
              onCancel={() => setState(report ? "ready" : "none")}
            />
          )}
          {(state === "none" || (state === "ready" && report === null)) && (
            <>
              {error !== null && (
                <p className="rq-prose" role="alert">
                  {error}
                </p>
              )}
              <div className="rp-actions">
                <button className="rp-act" onClick={() => void generate()}>
                  {t("state.readNow")}
                </button>
                <Link className="rp-act" href="/intake">
                  {t("state.answerMore")}
                </Link>
              </div>
            </>
          )}
        </SheetCard>
      </Shell>
    );
  }

  return (
    <Shell
      map={report.fact_map}
      currency={report.unit_economics.currency}
      nav={nav}
      findings={report.findings.length}
    >
      {error !== null && (
        <p className="rq-alert" role="alert">
          {error}
        </p>
      )}
      <ReportBody
        report={report}
        readOnly={false}
        onChanged={async () => {
          await load();
        }}
        foot={<>{t("generatedFrom", { id: report.id.slice(0, 8) })}</>}
      >
        {/* Idea 51: a read-only link to this report. */}
        <ShareCard />
      </ReportBody>
    </Shell>
  );
}
