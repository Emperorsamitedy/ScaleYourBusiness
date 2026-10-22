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
import Link from "next/link";
import { quietLine, splitByMateriality } from "../../lib/connectors/materiality";
import { delta, moneyFig, moneyText, num } from "../sheet/num";
import { SheetCard } from "../sheet/PageHead";
import type { Basis } from "./basis";
import { BASES, BASIS_MEANING, basisOf, gapWord, sourceLabel } from "./basis";
import {
  columnDecimals,
  fmtDate,
  fmtDay,
  forecastRange,
  isMoneyLike,
  numberDecimals,
  rangeText,
  refigure,
  severityFlag,
  signedMoney,
} from "./figures";
import type { MoneyLike } from "./figures";
import type { MeasureRow } from "./panel";
import {
  fig,
  headline,
  historyLines,
  inputLines,
  inputWords,
  panelRows,
  severityTally,
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
const DECLINE_CHIPS = [
  "we tried this before",
  "not possible in my market",
  "can't take this on right now",
];

const CASE_WORD: Record<string, string> = {
  base: "Base case",
  downside: "Downside",
  upside: "Upside",
};

const NONE = <span className="rq-none">—</span>;

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

/** "Sat 17 Oct 2026 · 14:06" — the viewer's own clock, read after mount. */
function useClock(): string | null {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      setNow(
        `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${hh}:${mm}`,
      );
    };
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);
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
  const clock = useClock();
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
          Ledgerline
        </Link>
        {context.length > 0 && <span className="rq-ctx">{context.join(" · ")}</span>}
      </div>
      <div className="rq-mast-r">
        {nav?.watch && (
          <span className="rq-live">
            <span className="rq-sq" aria-hidden="true" />
            Watching · day {nav.watch.day} of {nav.watch.of}
          </span>
        )}
        {clock && <span className="rq-clock">{clock}</span>}
      </div>
    </header>
  );
}

/* ── the sub-nav ── */

function SubNav({ findings, nav }: { findings: number | null; nav: NavCounts | null }) {
  const count = (n: number | null | undefined) => (n == null ? "—" : num(n));
  return (
    <nav className="rq-sub noprint" aria-label="Report">
      <ul>
        <li>
          <a href="#rq-findings" className="rq-sub-i on" aria-current="page">
            <span>Findings</span>
            <span className="rq-sub-n">{count(findings)}</span>
          </a>
        </li>
        <li>
          <Link href="/proposals" className="rq-sub-i">
            <span>Decisions</span>
            <span className="rq-sub-n">{count(nav?.pending)}</span>
          </Link>
        </li>
        <li>
          <Link href="/profile" className="rq-sub-i">
            <span>The record</span>
            <span className="rq-sub-n">{count(nav?.facts)}</span>
          </Link>
        </li>
        {/* No backing feature yet: shown, not linked, never counted. */}
        <li>
          <span className="rq-sub-i off" aria-disabled="true" title="Not built yet">
            <span>Shadow ledger</span>
            <span className="rq-sub-n">—</span>
          </span>
        </li>
        <li>
          <span className="rq-sub-i off" aria-disabled="true" title="Not built yet">
            <span>Outcomes</span>
            <span className="rq-sub-n">—</span>
          </span>
        </li>
      </ul>
      <hr className="rq-sub-rule" />
      <ul>
        <li>
          <span className="rq-sub-i off" aria-disabled="true" title="Not built yet">
            <span>Standing rules</span>
            <span className="rq-sub-n">—</span>
          </span>
        </li>
        <li>
          <Link href="/connections" className="rq-sub-i">
            <span>Connections</span>
            <span className="rq-sub-n">{count(nav?.connections)}</span>
          </Link>
        </li>
      </ul>
      <button type="button" className="rq-print" onClick={() => window.print()}>
        Print / PDF
      </button>
    </nav>
  );
}

/* ── the provenance of one recorded fact ── */

function BasisWord({ basis }: { basis: Basis | null }) {
  return <b className="rq-basis">{basis ?? "BASIS NOT RECORDED"}</b>;
}

function factLine(f: FactInfo | undefined): ReactNode {
  if (!f) return <>not in this snapshot</>;
  const basis = basisOf(f);
  return (
    <>
      {basis !== null ? (
        <BasisWord basis={basis} />
      ) : (
        <b className="rq-basis">{gapWord(f.status)}</b>
      )}{" "}
      · {sourceLabel(f.source_kind)}
      {f.observed_at !== undefined && <> · {fmtDate(f.observed_at)}</>}
    </>
  );
}

/* ── the diagnostic panel ── */

function signed(m: MoneyLike): string {
  return m.amount_minor < 0
    ? `−${moneyText(-m.amount_minor, m.currency)}`
    : moneyText(m.amount_minor, m.currency);
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
  const head = headline(report.recommendations);
  const tally = severityTally(report.findings);
  const notComputed = rows.filter((r) => r.result === null).length;
  const computed = rows.length - notComputed;
  const prior = report.prior ?? null;

  return (
    <section className="rq-panel" aria-labelledby="rq-panel-h">
      <header className="rq-panel-head">
        <p className="rq-label">
          Diagnostic panel · specimen {report.id.slice(0, 8)} · issued{" "}
          {fmtDate(report.generated_at)}
          {prior && <> · prior {fmtDate(prior.generated_at)}</>}
        </p>
        <h1 id="rq-panel-h" className="rq-head-line">
          {head ? (
            <>
              <span className="rq-big">
                {signed(head.range.low)}–{signed(head.range.high)}
              </span>{" "}
              <span className="rq-big-unit">
                profit change / month · if you do R{head.index + 1} · DERIVED
              </span>
            </>
          ) : rows.length > 0 ? (
            <>
              <span className="rq-big">
                {num(computed)} of {num(rows.length)}
              </span>{" "}
              <span className="rq-big-unit">measures computed · each one says why</span>
            </>
          ) : (
            <span className="rq-big rq-big-words">Diagnosis</span>
          )}
        </h1>
        <p className="rq-tally">
          {tally.map((t, i) => (
            <span key={t.word}>
              {i > 0 && " · "}
              <b className={`rq-n ${t.tone}`}>{t.n}</b> {t.word}
            </span>
          ))}
          {tally.length === 0 && <span>no findings called out</span>}
          {notComputed > 0 && (
            <span>
              {" "}
              · <b className="rq-n low">{notComputed}</b> not computed
            </span>
          )}
        </p>
        <p className="rq-summary">{report.summary}</p>
      </header>

      {rows.length === 0 ? (
        <p className="rq-empty">
          No measure could be computed or refused — the profile has nothing to work from yet.
        </p>
      ) : (
        <div className="rq-table-wrap">
          <table className="rq-table">
            <caption className="sr-only">
              Each measure: its result, the prior report&rsquo;s result, the reference range, a
              flag, money a month, its basis, and how it was worked out
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col" className="num">
                  Result
                </th>
                <th scope="col" className="num">
                  Prior
                </th>
                <th scope="col" className="rq-wrap">
                  Range · act-now line
                </th>
                <th scope="col">Flag</th>
                <th scope="col" className="num rq-wrap">
                  {report.unit_economics.currency} / month
                </th>
                <th scope="col">Basis</th>
                <th scope="col">
                  <span className="sr-only">Derivation</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected === r.id ? "on" : undefined}>
                  <th scope="row" className="rq-measure">
                    {r.name}
                  </th>
                  <td className="num rq-result" data-label="Result">
                    {r.result ? (
                      <>
                        {r.result.text}
                        {r.result.unit !== "" && <span className="rq-unit"> {r.result.unit}</span>}
                      </>
                    ) : (
                      NONE
                    )}
                  </td>
                  <td className="num rq-prior" data-label="Prior report">
                    {r.prior ? fig(r.prior) : NONE}
                  </td>
                  <td className="rq-range" data-label="Range · act-now">
                    {NONE}
                  </td>
                  <td data-label="Flag">
                    {r.flag ? <span className={`word ${r.flag.tone}`}>{r.flag.word}</span> : NONE}
                  </td>
                  <td className="num" data-label={`${report.unit_economics.currency} / month`}>
                    {NONE}
                  </td>
                  <td data-label="Basis">
                    <span className="rq-basis-w">{r.basis ?? "—"}</span>
                  </td>
                  <td className="rq-why-cell">
                    <button
                      type="button"
                      className="rq-why-btn"
                      aria-pressed={selected === r.id}
                      aria-controls="rq-why"
                      onClick={() => onWhy(r.id)}
                    >
                      Why <span aria-hidden="true">→</span>
                      <span className="sr-only"> — how {r.name} was worked out</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="rq-legend">
        Range · act-now line: drawn only where a target of yours or a range the data supports covers
        the measure — none does yet, so it shows —. Money a month is printed only where a
        measure&rsquo;s gap is priced; none is. DERIVED = worked out from other facts; its WHY shows
        the formula and inputs.
      </p>
    </section>
  );
}

/* ── the derivation sheet (non-modal) ── */

function WhySheet({ report, row }: { report: ReportView; row: MeasureRow | null }) {
  if (row === null) {
    return (
      <aside className="rq-why" id="rq-why" aria-label="Derivation sheet">
        <div className="rq-why-head">
          <p className="rq-label">Derivation sheet</p>
          <h2 className="rq-why-title">Nothing selected</h2>
        </div>
        <div className="rq-why-body">
          <p className="rq-why-words">Choose WHY → on a measure to see how it was worked out.</p>
        </div>
      </aside>
    );
  }
  const map = report.fact_map;
  const keys =
    row.computed?.derived_from ?? row.refusal?.missing.filter((k) => !k.includes("<")) ?? [];
  const inputs = inputLines(keys, map);
  const missingWords =
    row.refusal?.missing.filter((k) => k.includes("<")).map((k) => inputWords(k, map)) ?? [];
  const lines = historyLines({
    row,
    issuedAt: report.generated_at,
    priorAt: report.prior?.generated_at ?? null,
    keys,
    history: report.history ?? {},
    map,
  });

  return (
    <aside className="rq-why" id="rq-why" aria-label="Derivation sheet" aria-live="polite">
      <div className="rq-why-head">
        <p className="rq-label">Derivation sheet</p>
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
        <p className="rq-label">{row.computed ? "Formula, in words" : "Why it was not computed"}</p>
        <p className="rq-why-words">{row.computed ? row.words : row.refusal?.why}</p>
        {row.computed && <p className="rq-why-formula">{row.computed.formula}</p>}

        <p className="rq-label">{row.computed ? "Inputs" : "Missing inputs"}</p>
        {inputs.length === 0 && missingWords.length === 0 && (
          <p className="rq-why-none">None recorded.</p>
        )}
        <ul className="rq-inputs">
          {inputs.map((i) => (
            <li key={i.key}>
              <div>
                <span className="rq-in-name">{i.name}</span>
                <span className="rq-in-src">
                  {i.source === "not recorded"
                    ? row.computed
                      ? "not in this snapshot"
                      : "not recorded · missing"
                    : `${i.source} · ${i.basis ?? "basis not recorded"}`}
                </span>
              </div>
              <span className="rq-in-val">{i.value ?? "—"}</span>
            </li>
          ))}
          {missingWords.map((w) => (
            <li key={w}>
              <div>
                <span className="rq-in-name">{w.charAt(0).toUpperCase() + w.slice(1)}</span>
                <span className="rq-in-src">not recorded · missing</span>
              </div>
              <span className="rq-in-val">—</span>
            </li>
          ))}
        </ul>

        <p className="rq-label">History · superseded, never erased</p>
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
        {lines.length <= 1 && (
          <p className="rq-why-none">No input of this figure has been superseded yet.</p>
        )}
      </div>
    </aside>
  );
}

/* ── below the panel ── */

function Evidence({ keys, map }: { keys: string[]; map: FactMap }) {
  return (
    <ul className="rq-evidence">
      {keys.map((k) => {
        const f = map[k];
        return (
          <li key={k}>
            <span className="rq-ev-key">{inputWords(k, map)}</span>
            {f?.value != null && (
              <>
                {" "}
                = <span className="fig">{refigure(f.value)}</span>
              </>
            )}{" "}
            · {factLine(f)}
          </li>
        );
      })}
    </ul>
  );
}

function StatedVsMeasured({ rows, map }: { rows: StatedVsMeasuredRow[]; map: FactMap }) {
  const monies = rows.flatMap((r) =>
    [r.stated.value, r.measured.value].filter((v): v is MoneyLike => isMoneyLike(v)),
  );
  const dec = columnDecimals(monies);
  const show = (v: unknown): ReactNode => {
    if (typeof v === "number") return num(v, numberDecimals([v]));
    if (isMoneyLike(v)) return `${moneyFig(v.amount_minor, v.currency, dec)} ${v.currency}`;
    return NONE;
  };
  return (
    <div className="rq-table-wrap">
      <table className="rt rq-svm">
        <caption className="sr-only">
          What you said against what a connected account measured
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure · window</th>
            <th scope="col" className="num">
              You said
            </th>
            <th scope="col" className="num">
              Measured
            </th>
            <th scope="col" className="num">
              Difference
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
                  {inputWords(s.field_key, map).replace(/^./, (c) => c.toUpperCase())}
                  <span className="src rq-src">
                    OBSERVED · {s.provider} ·{" "}
                    {period
                      ? `${fmtDate(period[1] ?? "")} – ${fmtDate(period[2] ?? "")}`
                      : `read ${fmtDate(s.measured.observed_at)}`}
                  </span>
                  <span className="src rq-src">
                    yours: {statedBasis ?? gapWord(s.stated.status)} ·{" "}
                    {sourceLabel(s.stated.source_kind)} · {fmtDate(s.stated.observed_at)}
                  </span>
                </th>
                <td className="num" data-label="You said">
                  {s.stated.value === null ? "not known" : show(s.stated.value)}
                </td>
                <td className="num" data-label="Measured">
                  {show(s.measured.value)}
                </td>
                <td className="num" data-label="Difference">
                  {d === null ? (
                    NONE
                  ) : (
                    <>
                      {d.currency !== null
                        ? signedMoney({ amount_minor: d.amount, currency: d.currency }, dec)
                        : delta(d.amount, numberDecimals([d.amount]))}
                      {d.pct !== null && <> ({delta(d.pct, 1)} %)</>}
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
  const split = useMemo(() => splitByMateriality(rows), [rows]);
  const [open, setOpen] = useState(false);
  const line = quietLine(split.quiet, rows.length);
  return (
    <SheetCard
      className="rq-card"
      label="Stated against measured"
      title={
        split.material.length === 0
          ? "What you said held up against what was measured."
          : "What you said, against what was measured."
      }
      foot="The analysis uses the measured figure. What you said stays in your history."
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
            {open ? "Hide them" : "Show them"}
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
  const [reason, setReason] = useState("");
  return (
    <div className="rp-decline">
      <p>Optional — why not? This teaches me what not to propose again.</p>
      <div className="rp-chips">
        {DECLINE_CHIPS.map((c) => (
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
          aria-label="Your reason, in your words"
          placeholder="or say it your way"
          value={DECLINE_CHIPS.includes(reason) ? "" : reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
        <button className="ghost" onClick={() => onSubmit(reason)} disabled={busy}>
          {busy ? "recording…" : "Record it"}
        </button>
      </div>
    </div>
  );
}

function Forecast({ rec }: { rec: Rec }) {
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
          <span className="rq-label">Profit change vs today · range</span>
          <span className="fig rq-range-fig">
            {rangeText(range)} <span className="rq-unit">{range.currency} / month</span>
          </span>
        </p>
      )}
      <div className="rq-table-wrap">
        <table className="rt rq-cases">
          <caption className="sr-only">
            The three cases of “{rec.title}”, with the arithmetic
          </caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              {hasFigures && (
                <th scope="col" className="num">
                  {cur !== null ? `${cur} / month` : "Per month"}
                </th>
              )}
              <th scope="col">What happens · the arithmetic</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((o) => (
              <tr key={o.case}>
                <th scope="row">{CASE_WORD[o.case] ?? o.case}</th>
                {hasFigures && (
                  <td className="num" data-label={cur !== null ? `${cur} / month` : "Per month"}>
                    {o.profit_delta_monthly ? signedMoney(o.profit_delta_monthly, dec) : NONE}
                  </td>
                )}
                <td data-label="What happens">
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
}: {
  rec: Rec;
  index: number;
  reportId: string;
  map: FactMap;
  onChanged: () => Promise<void>;
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

  const addresses = rec.addresses.map((i) => `F${i + 1}`).join(", ");
  return (
    <li className="rq-item">
      <p className="rq-item-head">
        <span className="rq-ref">R{index + 1}</span>
        <span className="rq-label">
          effort {rec.effort} · undo {rec.reversibility.level}
          {addresses !== "" && <> · answers {addresses}</>}
        </span>
      </p>
      <h3 className="rq-item-title">{rec.title}</h3>
      <p className="rq-prose">{rec.rationale}</p>
      <Forecast rec={rec} />
      <p className="rq-inset">
        <span className="rq-label">Break-even</span> {rec.scenario.breakeven_condition}
      </p>
      {rec.sensitivity_callouts.map((c) => (
        <p className="rq-prose" key={c}>
          <span className="word drift">High sensitivity</span> {c}
        </p>
      ))}
      <p className="rq-label rq-sub-h">The assumptions, stated</p>
      <ul className="rq-evidence">
        {rec.scenario.assumptions.map((a) => {
          const f = a.source_field !== null ? map[a.source_field] : undefined;
          return (
            <li key={a.statement}>
              <span className="rq-ev-text">{a.statement}</span> ·{" "}
              {a.source_field !== null ? (
                <>
                  {factLine(f)} · from {inputWords(a.source_field, map)}
                </>
              ) : (
                <>
                  <BasisWord basis="ASSUMED" /> · nobody measured or stated this
                </>
              )}{" "}
              · sensitivity {a.sensitivity}
            </li>
          );
        })}
      </ul>
      <p className="rq-prose">
        <strong>If you change your mind:</strong> {rec.reversibility.if_you_change_your_mind}
      </p>

      {/* §8: two actions, equal visual weight — "no" is a legitimate answer */}
      {rec.status === "proposed" && !declining && (
        <div className="rp-actions">
          <button className="rp-act" onClick={() => void respond("look_into")} disabled={busy}>
            Look into this →
          </button>
          <button className="rp-act" onClick={() => setDeclining(true)} disabled={busy}>
            Not for us →
          </button>
        </div>
      )}
      {declining && (
        <Decline busy={busy} onSubmit={(reason) => void respond("not_for_us", reason)} />
      )}
      {rec.status === "accepted" && (
        <p className="rq-responded">
          <span className="rq-label">Recorded</span> you&rsquo;re looking into this
        </p>
      )}
      {rec.status === "rejected" && (
        <p className="rq-responded">
          <span className="rq-label">Declined</span>
          {rec.rejection_reason !== null ? ` “${rec.rejection_reason}”` : " no reason given"}
        </p>
      )}
    </li>
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

export function ReportScreen() {
  const nav = useNav();
  const [report, setReport] = useState<ReportView | null>(null);
  const [state, setState] = useState<"loading" | "none" | "generating" | "ready" | "error">(
    "loading",
  );
  const [step, setStep] = useState<"reading" | "checkout">("reading");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const whyRef = useRef<HTMLDivElement>(null);

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

  const generate = useCallback(async () => {
    setState("generating");
    setStep("reading");
    setError(null);
    try {
      const res = await fetch("/api/report", { method: "POST" });
      if (res.status === 402) {
        // P1-50: the report is paid. Start checkout and hand the browser
        // to Stripe; the webhook makes it real, and coming back here with
        // ?checkout=success retries generation against the paid record.
        setStep("checkout");
        const checkout = await fetch("/api/checkout", { method: "POST" });
        const payload = (await checkout.json().catch(() => null)) as {
          checkout_url?: string;
          error?: string;
        } | null;
        if (checkout.ok && payload?.checkout_url) {
          window.location.href = payload.checkout_url;
          return;
        }
        setError(payload?.error ?? "payment could not be started");
        setState(report ? "ready" : "none");
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(payload?.error ?? "generation failed");
        setState(report ? "ready" : "none");
        return;
      }
      setReport((await res.json()) as ReportView);
      setState("ready");
    } catch {
      setError("I couldn't reach the server — your answers are safe; try again.");
      setState(report ? "ready" : "none");
    }
  }, [report]);

  // Back from Stripe: kick generation once; if the webhook is still in
  // flight the 402 path shows the pay button again rather than
  // double-charging. Deliberately mount-only.
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    if (new URLSearchParams(window.location.search).get("checkout") === "success") {
      window.history.replaceState(null, "", "/report");
      void generate();
    }
  }, [generate]);

  const rows = useMemo(
    () => (report ? panelRows(report.unit_economics, report.prior?.unit_economics ?? null) : []),
    [report],
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

  /* ── P1-41: the three non-report states ── */
  if (state !== "ready" || report === null) {
    return (
      <Shell map={null} currency={null} nav={nav} findings={null}>
        <SheetCard
          label="Diagnostic panel"
          title={state === "none" ? "No report yet" : "Diagnosis"}
        >
          {state === "loading" && (
            <p className="rq-prose" role="status">
              Checking for your report…
            </p>
          )}
          {state === "error" && (
            <p className="rq-prose" role="alert">
              Something went wrong loading the report. Refresh to try again — nothing you told me is
              lost.
            </p>
          )}
          {state === "generating" && (
            <>
              {/* An honest status line, live only while the request is in flight. */}
              <p className="rq-status live" role="status" aria-live="polite">
                <span className="live-dot" aria-hidden="true" />{" "}
                {step === "checkout"
                  ? "Opening checkout — the report is paid for before it is written"
                  : "Reading your profile — the request is running"}
              </p>
              <p className="rq-prose">
                Margins, break-even, the findings and what to do about them. This usually takes
                about a minute; the arithmetic is checked before anything reaches the page.
              </p>
            </>
          )}
          {(state === "none" || (state === "ready" && report === null)) && (
            <>
              <p className="rq-prose" role={error !== null ? "alert" : undefined}>
                {error ??
                  "When you've answered enough, I read the whole profile and write up what I can prove."}
              </p>
              <div className="rp-actions">
                <button className="rp-act" onClick={() => void generate()}>
                  Read my profile now →
                </button>
                <Link className="rp-act" href="/intake">
                  Answer more first →
                </Link>
              </div>
            </>
          )}
        </SheetCard>
      </Shell>
    );
  }

  const eco = report.unit_economics;
  const map = report.fact_map;
  const measured = eco.stated_vs_measured ?? [];

  return (
    <Shell map={map} currency={eco.currency} nav={nav} findings={report.findings.length}>
      {error !== null && (
        <p className="rq-alert" role="alert">
          {error}
        </p>
      )}
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
        label="Findings · most urgent first"
        title={
          report.findings.length === 0
            ? "Nothing the evidence supports strongly enough to call out."
            : `${num(report.findings.length)} finding${report.findings.length === 1 ? "" : "s"}, each with its evidence.`
        }
      >
        {report.findings.length > 0 ? (
          <ol className="rq-list">
            {report.findings.map((f, i) => {
              const flag = severityFlag(f.severity);
              return (
                <li className="rq-item" key={f.title}>
                  <p className="rq-item-head">
                    <span className="rq-ref">F{i + 1}</span>
                    <span className={`word ${flag.tone}`}>{flag.word}</span>
                    <span className="rq-label">{f.area.replace(/_/g, " ")}</span>
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
        label="What I'd do about it"
        title={
          report.recommendations.length === 0
            ? "No recommendation the arithmetic can back yet."
            : `${num(report.recommendations.length)} recommendation${report.recommendations.length === 1 ? "" : "s"}, each with its range.`
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
                onChanged={async () => {
                  await load();
                }}
              />
            ))}
          </ol>
        ) : undefined}
      </SheetCard>

      {/* ── trading hours (P2-30): measured, deterministic, the arithmetic shown ── */}
      {report.trading_hours && (
        <SheetCard
          className="rq-card"
          label={`Trading hours · OBSERVED · ${fmtDay(report.trading_hours.from)} – ${fmtDay(report.trading_hours.to)}`}
          title={
            report.trading_hours.findings.length === 0
              ? "No signal fires on any measured day."
              : `${num(report.trading_hours.findings.length)} signal${report.trading_hours.findings.length === 1 ? "" : "s"} in your hourly sales.`
          }
          meta={report.trading_hours.coverage}
          foot={
            <>
              {report.trading_hours.limit} <Link href="/hours">See every weekday →</Link>
            </>
          }
        >
          <ul className="rq-list">
            {report.trading_hours.findings.map((f) => (
              <li className="rq-item" key={f.signal}>
                <p className="rq-item-head">
                  {f.signal === "too_early" ? (
                    <span className="word low">Too early to say</span>
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
        <SheetCard
          className="rq-card"
          label="What would sharpen this"
          title="The report is only as good as what it rests on."
        >
          <ul className="rq-list">
            {report.data_gaps.map((g) => (
              <li className="rq-gap" key={g.question_id}>
                <div>
                  <p className="rq-item-head">
                    <span className="rq-label">{g.priority}</span>
                    {g.blocking && <span className="word drift">Blocking</span>}
                  </p>
                  <p className="rq-gap-q">{g.prompt}</p>
                  <p className="rq-gap-b">{g.buys}</p>
                </div>
                <Link
                  className="ghost quiet noprint"
                  href={`/intake?ask=${encodeURIComponent(g.question_id)}`}
                >
                  Answer now →
                </Link>
              </li>
            ))}
          </ul>
        </SheetCard>
      )}

      <footer className="rq-foot">
        <p>
          {BASES.map((b, i) => (
            <span key={b}>
              {i > 0 && " · "}
              <b>{b}</b> {BASIS_MEANING[b]}
            </span>
          ))}
        </p>
        <p>
          Every figure prints where it came from. Estimates are marked as estimates; nothing is
          invented. Generated from snapshot {report.id.slice(0, 8)}.
        </p>
      </footer>
    </Shell>
  );
}
