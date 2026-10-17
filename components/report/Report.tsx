"use client";

// The diagnosis report — Session G (P1-34..41), UX spec §7, on the sheet
// system (§2): one paper sheet, set like a lab report.
//
// Structure top to bottom: the plain summary → the numbers as results
// tables (value, a named comparison where one exists, a worded flag where
// the data supports one) → findings with their evidence boxes →
// recommendations with the forecast as a range, the assumptions stated in
// the open, and two equal-weight actions → what would sharpen this.
//
// Every fact prints its basis, source and date as visible text. Basis is
// a named class (components/report/basis.ts), never a confidence
// percentage. No reference range is printed: the report data carries
// none, and an invented one would be a claim the code does not back.
//
// Everything rendered here was computed or evidence-checked in code
// before it reached the page; this component adds no numbers of its own
// beyond re-printing them through components/sheet/num.ts.

import "../../app/report.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { delta, moneyFig, num } from "../sheet/num";
import type { Basis, BasisInput } from "./basis";
import { BASES, BASIS_MEANING, basisMix, basisOf, basisOfKey, gapWord, sourceLabel } from "./basis";
import type { MoneyLike, Severity } from "./figures";
import {
  columnDecimals,
  fmtDate,
  forecastRange,
  isMoneyLike,
  keyWords,
  numberDecimals,
  rangeText,
  refigure,
  severityFlag,
  signedMoney,
} from "./figures";

/* ── shapes from lib/report/service.ts ── */

interface FactInfo extends BasisInput {
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
  /** Not yet sent by the report service; printed as soon as it is. */
  observed_at?: string;
  note?: string | null;
  source_detail?: string | null;
}
interface Computed<T> {
  value: T;
  derived_from: string[];
  formula: string;
  confidence: number;
}
interface OfferEco {
  offer_id: string;
  name: string;
  price: MoneyLike;
  cost_to_deliver: MoneyLike | null;
  margin_pct: Computed<number> | null;
  contribution: Computed<MoneyLike> | null;
  volume: number | null;
}
/** Rule 11 (P2-11): a connector superseded the owner's figure, and both are shown. */
interface StatedVsMeasuredRow {
  field_key: string;
  provider: string;
  stated: {
    value: unknown;
    status: string;
    source_kind: string;
    observed_at: string;
    note: string | null;
  };
  measured: { value: unknown; method: string; observed_at: string };
  delta: { amount: number; currency: string | null; pct: number | null } | null;
}
interface BreakEven {
  units_per_month: number;
  revenue_per_month?: MoneyLike;
}
interface Economics {
  /** Absent on reports generated before Phase 2. */
  stated_vs_measured?: StatedVsMeasuredRow[];
  currency: string;
  offers: OfferEco[];
  blended_margin_pct: Computed<number> | null;
  break_even: Computed<BreakEven> | null;
  average_order_value?: Computed<MoneyLike> | null;
  /** Absent on reports generated before Phase 2 Session D. */
  cost_per_acquisition?: Computed<MoneyLike> | null;
  return_on_ad_spend?: Computed<number> | null;
  fixed_costs_monthly: Computed<MoneyLike> | null;
  stated_vs_computed_margin: { stated_pct: number; computed_pct: number; delta_pts: number } | null;
  refusals?: { what: string; missing: string[]; why: string }[];
}
interface Finding {
  area: string;
  title: string;
  detail: string;
  evidence: string[];
  severity: Severity;
}
interface Outcome {
  case: string;
  statement: string;
  profit_delta_monthly?: MoneyLike | null;
  formula: string | null;
}
interface Rec {
  addresses: number[];
  title: string;
  rationale: string;
  effort: string;
  reversibility: { level: string; if_you_change_your_mind: string };
  sensitivity_callouts: string[];
  scenario: {
    assumptions: { statement: string; source_field: string | null; sensitivity: string }[];
    base_case: Outcome;
    downside_case: Outcome;
    upside_case: Outcome;
    breakeven_condition: string;
  };
  status: "proposed" | "accepted" | "rejected";
  rejection_reason: string | null;
}
interface Gap {
  question_id: string;
  prompt: string;
  priority: string;
  buys: string;
  blocking: boolean;
}
interface HoursFinding {
  signal: "opening" | "closing" | "attention" | "too_early";
  weekdays: string[];
  title: string;
  detail: string;
  arithmetic: string[];
}
interface TradingHours {
  from: string;
  to: string;
  coverage: string;
  limit: string;
  findings: HoursFinding[];
}
interface ReportView {
  id: string;
  generated_at: string;
  summary: string;
  completeness: number;
  unit_economics: Economics;
  findings: Finding[];
  recommendations: Rec[];
  data_gaps: Gap[];
  /** P2-30: absent on reports generated before it, null when nothing is measured. */
  trading_hours?: TradingHours | null;
  fact_map: Record<string, FactInfo>;
}
type FactMap = Record<string, FactInfo>;

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

/* ── the mono lines: basis · source · date, always visible ── */

function BasisWord({ basis }: { basis: Basis | null }) {
  return <b className="rs-basis">{basis ?? "BASIS NOT RECORDED"}</b>;
}

/** The provenance of one recorded fact. */
function factLine(f: FactInfo | undefined): ReactNode {
  if (!f) return <>not in this snapshot</>;
  const basis = basisOf(f);
  return (
    <>
      {basis !== null ? (
        <BasisWord basis={basis} />
      ) : (
        <b className="rs-basis">{gapWord(f.status)}</b>
      )}{" "}
      · {sourceLabel(f.source_kind)}
      {f.observed_at !== undefined && <> · {fmtDate(f.observed_at)}</>}
    </>
  );
}

/** Words for one derivation input: a profile key, or a connector series. */
function inputWords(key: string, map: FactMap): string {
  if (key.startsWith("connector:")) {
    const [, provider = "", series = ""] = key.split(":");
    return `${provider} ${series.replace(/[._]/g, " ")}`.trim();
  }
  const offer = /^offers\.([^.]+)\.(.+)$/.exec(key);
  if (offer) {
    const name = map[`offers.${offer[1]}.name`]?.value;
    return `${name ?? "offer"} ${keyWords(`x.${offer[2]}`)}`;
  }
  return keyWords(key);
}

/** The provenance of a computed figure: DERIVED, its formula, what it rests on, when. */
function DerivedLine({ c, map, issued }: { c: Computed<unknown>; map: FactMap; issued: string }) {
  const mix = basisMix(c.derived_from.map((k) => basisOfKey(k, map)));
  return (
    <span className="rs-src">
      <BasisWord basis="DERIVED" /> · {c.formula}
      {mix !== "" && <> · rests on {mix}</>} · computed {issued}
    </span>
  );
}

function Flag({ word, tone }: { word: string; tone: "ok" | "low" | "drift" | "alarm" | "none" }) {
  return <span className={`flag ${tone}`}>{word}</span>;
}

/** A dash where the data has nothing to say — never an invented figure. */
const NONE = <span className="rs-none">—</span>;

/* ── 1 · the numbers ── */

function OffersTable({ eco, map, issued }: { eco: Economics; map: FactMap; issued: string }) {
  const currencies = new Set(eco.offers.map((o) => o.price.currency));
  const common = currencies.size === 1 ? [...currencies][0] : null;
  const priceDec = columnDecimals(eco.offers.map((o) => o.price));
  const costDec = columnDecimals(eco.offers.map((o) => o.cost_to_deliver));
  const contribDec = columnDecimals(eco.offers.map((o) => o.contribution?.value));
  const volDec = numberDecimals(eco.offers.map((o) => o.volume));
  const unit = common !== null ? ` ${common}` : "";
  const cellCur = (m: MoneyLike) => (common === null ? ` ${m.currency}` : "");

  return (
    <div className="rs-scroll">
      <table className="rs-table">
        <caption className="sr-only">
          Each offer: price, cost to deliver, contribution and margin per sale, and units sold a
          month
        </caption>
        <thead>
          <tr>
            <th scope="col">Offer · basis · source</th>
            <th scope="col" className="num-col">
              Price{unit}
            </th>
            <th scope="col" className="num-col">
              Cost to deliver{unit}
            </th>
            <th scope="col" className="num-col">
              Contribution{unit}
            </th>
            <th scope="col" className="num-col">
              Margin %
            </th>
            <th scope="col" className="num-col">
              Units / month
            </th>
            <th scope="col">Flag</th>
          </tr>
        </thead>
        <tbody>
          {eco.offers.map((o) => {
            const priceFact = map[`offers.${o.offer_id}.price`];
            const costFact = map[`offers.${o.offer_id}.cost_to_deliver`];
            const volFact = map[`offers.${o.offer_id}.volume_period`];
            const belowCost = o.margin_pct !== null && o.margin_pct.value < 0;
            return (
              <tr key={o.offer_id} className={belowCost ? "is-alarm" : undefined}>
                <th scope="row" className="rs-measure">
                  <span className="rs-measure-name">{o.name}</span>
                  <span className="rs-src">price {factLine(priceFact)}</span>
                  {o.cost_to_deliver !== null && (
                    <span className="rs-src">cost {factLine(costFact)}</span>
                  )}
                  {o.volume !== null && <span className="rs-src">units {factLine(volFact)}</span>}
                  {o.margin_pct !== null && (
                    <DerivedLine c={o.margin_pct} map={map} issued={issued} />
                  )}
                </th>
                <td className="fig num-col" data-label={`Price${unit}`}>
                  {moneyFig(o.price.amount_minor, o.price.currency, priceDec)}
                  {cellCur(o.price)}
                </td>
                <td className="fig num-col" data-label={`Cost to deliver${unit}`}>
                  {o.cost_to_deliver !== null ? (
                    <>
                      {moneyFig(
                        o.cost_to_deliver.amount_minor,
                        o.cost_to_deliver.currency,
                        costDec,
                      )}
                      {cellCur(o.cost_to_deliver)}
                    </>
                  ) : (
                    NONE
                  )}
                </td>
                <td className="fig num-col" data-label={`Contribution${unit}`}>
                  {o.contribution !== null ? (
                    <>
                      {moneyFig(
                        o.contribution.value.amount_minor,
                        o.contribution.value.currency,
                        contribDec,
                      )}
                      {cellCur(o.contribution.value)}
                    </>
                  ) : (
                    NONE
                  )}
                </td>
                <td className="fig num-col" data-label="Margin %">
                  {o.margin_pct !== null ? num(o.margin_pct.value, 1) : NONE}
                </td>
                <td className="fig num-col" data-label="Units / month">
                  {o.volume !== null ? num(o.volume, volDec) : NONE}
                </td>
                <td className="rs-flag" data-label="Flag">
                  {o.cost_to_deliver === null ? (
                    <Flag word="NOT PROVIDED" tone="none" />
                  ) : belowCost ? (
                    <Flag word="ACT NOW" tone="alarm" />
                  ) : (
                    NONE
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

interface WideRow {
  measure: string;
  value: string;
  unit: string;
  comparison: ReactNode;
  src: ReactNode;
}

function BusinessTable({ eco, map, issued }: { eco: Economics; map: FactMap; issued: string }) {
  const cur = eco.currency;
  const moneyCells = [
    eco.fixed_costs_monthly?.value,
    eco.average_order_value?.value,
    eco.break_even?.value.revenue_per_month,
    eco.cost_per_acquisition?.value,
  ];
  const dec = columnDecimals(moneyCells);
  const money = (m: MoneyLike) => moneyFig(m.amount_minor, m.currency, dec);
  const rows: WideRow[] = [];
  const svc = eco.stated_vs_computed_margin;

  if (eco.blended_margin_pct) {
    rows.push({
      measure: "Blended margin",
      value: num(eco.blended_margin_pct.value, 1),
      unit: "%",
      comparison: svc ? (
        <>
          you said <span className="fig">{num(svc.stated_pct, 1)} %</span> ·{" "}
          <span className="fig">{delta(svc.computed_pct - svc.stated_pct, 1)}</span> pts
        </>
      ) : (
        NONE
      ),
      src: <DerivedLine c={eco.blended_margin_pct} map={map} issued={issued} />,
    });
  }
  if (eco.fixed_costs_monthly) {
    rows.push({
      measure: "Fixed costs",
      value: money(eco.fixed_costs_monthly.value),
      unit: `${eco.fixed_costs_monthly.value.currency} / month`,
      comparison: NONE,
      src: <DerivedLine c={eco.fixed_costs_monthly} map={map} issued={issued} />,
    });
  }
  if (eco.average_order_value) {
    rows.push({
      measure: "Average order value",
      value: money(eco.average_order_value.value),
      unit: eco.average_order_value.value.currency,
      comparison: NONE,
      src: <DerivedLine c={eco.average_order_value} map={map} issued={issued} />,
    });
  }
  if (eco.break_even) {
    rows.push({
      measure: "Break-even volume",
      value: num(eco.break_even.value.units_per_month, 0),
      unit: "units / month",
      comparison: NONE,
      src: <DerivedLine c={eco.break_even} map={map} issued={issued} />,
    });
    const rev = eco.break_even.value.revenue_per_month;
    if (rev) {
      rows.push({
        measure: "Revenue at break-even",
        value: money(rev),
        unit: `${rev.currency} / month`,
        comparison: NONE,
        src: <DerivedLine c={eco.break_even} map={map} issued={issued} />,
      });
    }
  }
  if (eco.cost_per_acquisition) {
    rows.push({
      measure: "Cost to acquire a customer",
      value: money(eco.cost_per_acquisition.value),
      unit: eco.cost_per_acquisition.value.currency,
      comparison: NONE,
      src: <DerivedLine c={eco.cost_per_acquisition} map={map} issued={issued} />,
    });
  }
  if (eco.return_on_ad_spend) {
    rows.push({
      measure: "Return on ad spend",
      value: num(eco.return_on_ad_spend.value, 2),
      unit: "× ad spend",
      comparison: NONE,
      src: <DerivedLine c={eco.return_on_ad_spend} map={map} issued={issued} />,
    });
  }
  if (rows.length === 0) return null;

  return (
    <div className="rs-scroll">
      <table className="rs-table">
        <caption className="sr-only">
          Business-wide figures in {cur}, each with how it was computed
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure · basis · how</th>
            <th scope="col" className="num-col">
              Value
            </th>
            <th scope="col">vs what you said</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.measure}>
              <th scope="row" className="rs-measure">
                <span className="rs-measure-name">{r.measure}</span>
                {r.src}
              </th>
              <td className="fig num-col" data-label="Value">
                {r.value}
                <span className="rs-unit"> {r.unit}</span>
              </td>
              <td className="rs-cmp" data-label="vs what you said">
                {r.comparison}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The owner-facing noun for a measured field key. */
function measureNoun(key: string, map: FactMap): string {
  // P2-16 / P2-18: a measured figure for one matched offer or channel.
  const volume = /^offers\.([^.]+)\.volume_period$/.exec(key);
  if (volume) return `Units a month of ${map[`offers.${volume[1]}.name`]?.value ?? "this product"}`;
  const traffic = /^channels\.([^.]+)\.monthly_sessions$/.exec(key);
  if (traffic)
    return `Monthly visits from ${map[`channels.${traffic[1]}.type`]?.value ?? "this channel"}`;
  const named: Record<string, string> = {
    "revenue.monthly_revenue": "Monthly revenue",
    "revenue.order_count_monthly": "Orders a month",
    "marketing.monthly_ad_spend": "Monthly ad spend",
    "marketing.cost_per_purchase": "Cost per purchase from ads",
    "presence.monthly_sessions": "Monthly website visits",
  };
  const n = named[key] ?? keyWords(key);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function StatedVsMeasuredTable({ rows, map }: { rows: StatedVsMeasuredRow[]; map: FactMap }) {
  const monies = rows.flatMap((r) =>
    [r.stated.value, r.measured.value].filter((v): v is MoneyLike => isMoneyLike(v)),
  );
  const dec = columnDecimals(monies);
  const show = (v: unknown): ReactNode => {
    if (typeof v === "number") return num(v, numberDecimals([v]));
    if (isMoneyLike(v))
      return (
        <>
          {moneyFig(v.amount_minor, v.currency, dec)}
          <span className="rs-unit"> {v.currency}</span>
        </>
      );
    return NONE;
  };
  return (
    <div className="rs-scroll">
      <table className="rs-table">
        <caption className="sr-only">
          What you said against what a connected account measured, with the difference
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure · window</th>
            <th scope="col" className="num-col">
              You said
            </th>
            <th scope="col" className="num-col">
              Measured
            </th>
            <th scope="col" className="num-col">
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
                <th scope="row" className="rs-measure">
                  <span className="rs-measure-name">{measureNoun(s.field_key, map)}</span>
                  <span className="rs-src">
                    <BasisWord basis="OBSERVED" /> · {s.provider} ·{" "}
                    {period
                      ? `${fmtDate(period[1] ?? "")} – ${fmtDate(period[2] ?? "")}`
                      : `read ${fmtDate(s.measured.observed_at)}`}
                  </span>
                  <span className="rs-src">
                    yours:{" "}
                    {statedBasis !== null ? (
                      <BasisWord basis={statedBasis} />
                    ) : (
                      <b className="rs-basis">{gapWord(s.stated.status)}</b>
                    )}{" "}
                    · {sourceLabel(s.stated.source_kind)} · {fmtDate(s.stated.observed_at)}
                  </span>
                </th>
                <td className="fig num-col" data-label="You said">
                  {s.stated.value === null ? (
                    <span className="rs-missing">not known</span>
                  ) : (
                    show(s.stated.value)
                  )}
                </td>
                <td className="fig num-col" data-label="Measured">
                  {show(s.measured.value)}
                </td>
                <td className="fig num-col" data-label="Difference">
                  {d === null ? (
                    NONE
                  ) : (
                    <>
                      {d.currency !== null
                        ? signedMoney({ amount_minor: d.amount, currency: d.currency }, dec)
                        : delta(d.amount, numberDecimals([d.amount]))}
                      {d.pct !== null && <span className="rs-unit"> ({delta(d.pct, 1)} %)</span>}
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

/* ── 2 · findings ── */

function Evidence({ keys, map }: { keys: string[]; map: FactMap }) {
  return (
    <ul className="rs-evidence">
      {keys.map((k) => {
        const f = map[k];
        return (
          <li key={k}>
            <span className="rs-ev-key">{inputWords(k, map)}</span>
            {f?.value !== null && f?.value !== undefined && (
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

/* ── 3 · recommendations ── */

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
    <div className="rs-forecast">
      {range !== null && (
        <div className="rs-forecast-head">
          <p className="label">Profit change vs today · {range.currency} / month · range</p>
          <p className="fig rs-range">
            {rangeText(range)} <span className="rs-unit">{range.currency} / month</span>
          </p>
        </div>
      )}
      <p className="rs-base">
        <span className="label">Base case</span> {s.base_case.statement}
      </p>
      <div className="rs-scroll">
        <table className="rs-table rs-table-tight">
          <caption className="sr-only">
            The three cases of “{rec.title}”, with the arithmetic
          </caption>
          <thead>
            <tr>
              <th scope="col">Case</th>
              {hasFigures && (
                <th scope="col" className="num-col">
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
                  <td
                    className="fig num-col"
                    data-label={cur !== null ? `${cur} / month` : "Per month"}
                  >
                    {o.profit_delta_monthly ? signedMoney(o.profit_delta_monthly, dec) : NONE}
                  </td>
                )}
                <td className="rs-how" data-label="What happens">
                  <span>
                    {o.statement}
                    {o.formula !== null && <code className="rs-formula">{o.formula}</code>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecommendationCard({
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
    <li className="rs-rec">
      <p className="rs-item-head">
        <span className="fig rs-ref">R{index + 1}</span>
        <span className="label">
          effort {rec.effort} · undo {rec.reversibility.level}
          {addresses !== "" && <> · answers {addresses}</>}
        </span>
      </p>
      <h3 className="rs-item-title">{rec.title}</h3>
      <p className="rs-prose">{rec.rationale}</p>

      <Forecast rec={rec} />

      <div className="rs-inset">
        <p className="label">Break-even</p>
        <p>{rec.scenario.breakeven_condition}</p>
      </div>

      {rec.sensitivity_callouts.map((c) => (
        <p className="rs-callout" key={c}>
          <Flag word="HIGH SENSITIVITY" tone="drift" /> {c}
        </p>
      ))}

      <h4 className="rs-h4">The assumptions, stated</h4>
      <ul className="rs-evidence">
        {rec.scenario.assumptions.map((a) => {
          const f = a.source_field !== null ? map[a.source_field] : undefined;
          return (
            <li key={a.statement}>
              <span className="rs-ev-text">{a.statement}</span> ·{" "}
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

      <p className="rs-undo">
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
        <p className="rs-responded">
          <span className="label">Recorded</span> you&rsquo;re looking into this
        </p>
      )}
      {rec.status === "rejected" && (
        <p className="rs-responded">
          <span className="label">Declined</span>
          {rec.rejection_reason !== null ? ` “${rec.rejection_reason}”` : " no reason given"}
        </p>
      )}
    </li>
  );
}

/* ── the screen ── */

function BasisLegend() {
  return (
    <p className="rs-legend">
      {BASES.map((b, i) => (
        <span key={b}>
          {i > 0 && " · "}
          <b>{b}</b> {BASIS_MEANING[b]}
        </span>
      ))}
    </p>
  );
}

export function ReportScreen() {
  const [report, setReport] = useState<ReportView | null>(null);
  const [state, setState] = useState<"loading" | "none" | "generating" | "ready" | "error">(
    "loading",
  );
  const [step, setStep] = useState<"reading" | "checkout">("reading");
  const [error, setError] = useState<string | null>(null);

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

  // Back from Stripe: the webhook has (usually) landed before the
  // redirect. Kick generation once; if the webhook is still in flight
  // the 402 path shows the pay button again rather than double-charging.
  // Deliberately mount-only — `generate` is stable enough and re-running
  // on its identity change would re-trigger checkout.
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current) return;
    kicked.current = true;
    if (new URLSearchParams(window.location.search).get("checkout") === "success") {
      window.history.replaceState(null, "", "/report");
      void generate();
    }
  }, [generate]);

  /* ── P1-41: the three non-report states ── */
  if (state === "loading") {
    return (
      <main className="rp-shell rs">
        <p className="rs-empty" role="status">
          Checking for your report…
        </p>
      </main>
    );
  }
  if (state === "error") {
    return (
      <main className="rp-shell rs">
        <p className="rs-empty" role="alert">
          Something went wrong loading the report. Refresh to try again — nothing you told me is
          lost.
        </p>
      </main>
    );
  }
  if (state === "generating") {
    // An honest status line, live only while the request is in flight —
    // no spinner, no padded progress steps (ux-spec §2 motion).
    return (
      <main className="rp-shell rs">
        <h1 className="display rs-h1">Diagnosis</h1>
        <p className="rs-status live" role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />{" "}
          {step === "checkout"
            ? "Opening checkout — the report is paid for before it is written"
            : "Reading your profile — the request is running"}
        </p>
        <p className="rs-prose">
          Margins, break-even, the findings and what to do about them. This usually takes about a
          minute; the arithmetic is checked before anything reaches the page.
        </p>
      </main>
    );
  }
  if (state === "none" || report === null) {
    return (
      <main className="rp-shell rs">
        <h1 className="display rs-h1">No report yet</h1>
        <p className="rs-prose" role={error !== null ? "alert" : undefined}>
          {error !== null
            ? error
            : "When you've answered enough, I read the whole profile and write up what I can prove."}
        </p>
        <div className="rp-actions rs-none-actions">
          <button className="rp-act" onClick={() => void generate()}>
            Read my profile now →
          </button>
          <Link className="rp-act" href="/intake">
            Answer more first →
          </Link>
        </div>
      </main>
    );
  }

  const eco = report.unit_economics;
  const map = report.fact_map;
  const issued = fmtDate(report.generated_at);
  const business = map["identity.legal_name"]?.value ?? null;
  const measured = eco.stated_vs_measured ?? [];
  const refusals = eco.refusals ?? [];

  return (
    <main className="rp-shell rs">
      <header className="rs-head">
        <div>
          <p className="label rs-kicker">
            Issued {issued} · snapshot {report.id.slice(0, 8)}
          </p>
          <h1 className="display rs-h1">Diagnosis</h1>
          <p className="rs-sub">
            {business !== null && <>{business} · </>}
            {eco.currency} · completeness{" "}
            <span className="fig">{num(Math.round(report.completeness * 100))} %</span>
          </p>
        </div>
        <button className="rp-act noprint rs-print" onClick={() => window.print()}>
          Print / PDF
        </button>
      </header>

      {/* ── the three sentences ── */}
      <p className="rs-summary">{report.summary}</p>

      {/* ── 1 · the numbers ── */}
      <section className="rs-section" aria-labelledby="rs-numbers">
        <h2 id="rs-numbers" className="rs-h2">
          1 · The numbers
        </h2>
        {eco.offers.length === 0 ? (
          <p className="rs-empty">No offers with prices yet — the economics need them.</p>
        ) : (
          <OffersTable eco={eco} map={map} issued={issued} />
        )}
        <BusinessTable eco={eco} map={map} issued={issued} />

        {/* Rule 11 (P2-11): a measurement replaced an estimate, and both are shown. */}
        {measured.length > 0 && (
          <>
            <h3 className="rs-h3">What you said, against what was measured</h3>
            <StatedVsMeasuredTable rows={measured} map={map} />
            <p className="rs-note">
              The analysis uses the measured figure. What you said stays in your history.
            </p>
          </>
        )}
        {eco.stated_vs_computed_margin && (
          <p className="rs-note">
            The margin you gave and the one your own product figures compute to differ, so both are
            shown above; the analysis uses the computed one.
          </p>
        )}
        {refusals.length > 0 && (
          <>
            <h3 className="rs-h3">Not computed</h3>
            <ul className="rs-refusals">
              {refusals.map((r) => (
                <li key={r.what}>
                  <Flag word="NOT PROVIDED" tone="none" /> <strong>{r.what}</strong> — {r.why}
                  {r.missing.length > 0 && (
                    <span className="rs-src">
                      missing: {r.missing.map((k) => inputWords(k, map)).join(" · ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {/* ── 2 · findings: a worded flag; colour only tints the word ── */}
      <section className="rs-section" aria-labelledby="rs-findings">
        <h2 id="rs-findings" className="rs-h2">
          2 · Findings, most urgent first
        </h2>
        {report.findings.length === 0 && (
          <p className="rs-empty">Nothing the evidence supports strongly enough to call out.</p>
        )}
        <ol className="rs-list">
          {report.findings.map((f, i) => {
            const flag = severityFlag(f.severity);
            return (
              <li className="rs-finding" key={f.title}>
                <p className="rs-item-head">
                  <span className="fig rs-ref">F{i + 1}</span>
                  <Flag word={flag.word} tone={flag.tone} />
                  <span className="label rs-area">{f.area.replace(/_/g, " ")}</span>
                </p>
                <h3 className="rs-item-title">{f.title}</h3>
                <p className="rs-prose">{f.detail}</p>
                <Evidence keys={f.evidence} map={map} />
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── trading hours (P2-30): measured, deterministic, the arithmetic shown ── */}
      {report.trading_hours && (
        <section className="rs-section" aria-labelledby="rs-hours">
          <h2 id="rs-hours" className="rs-h2">
            Your trading hours
          </h2>
          <p className="rs-src rs-src-block">
            <BasisWord basis="OBSERVED" /> · hourly sales · {fmtDate(report.trading_hours.from)} –{" "}
            {fmtDate(report.trading_hours.to)} · {report.trading_hours.coverage}
          </p>
          {report.trading_hours.findings.length === 0 && (
            <p className="rs-prose">No signal fires on any measured day.</p>
          )}
          <ul className="rs-list">
            {report.trading_hours.findings.map((f) => (
              <li className="rs-finding" key={f.signal}>
                <p className="rs-item-head">
                  {f.signal === "too_early" ? (
                    <Flag word="TOO EARLY TO SAY" tone="low" />
                  ) : (
                    <span className="label">{f.weekdays.join(" · ")}</span>
                  )}
                </p>
                <h3 className="rs-item-title">{f.title}</h3>
                <p className="rs-prose">{f.detail}</p>
                {f.arithmetic.length > 0 && (
                  <ul className="rs-evidence">
                    {f.arithmetic.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          <p className="rs-note">
            {report.trading_hours.limit} <Link href="/hours">See every weekday →</Link>
          </p>
        </section>
      )}

      {/* ── 3 · recommendations with scenarios and the two equal actions ── */}
      <section className="rs-section" aria-labelledby="rs-recs">
        <h2 id="rs-recs" className="rs-h2">
          3 · What I&rsquo;d do about it
        </h2>
        {report.recommendations.length === 0 && (
          <p className="rs-empty">No recommendation the arithmetic can back yet.</p>
        )}
        <ol className="rs-list">
          {report.recommendations.map((rec, i) => (
            <RecommendationCard
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
      </section>

      {/* ── 4 · what would sharpen this ── */}
      {report.data_gaps.length > 0 && (
        <section className="rs-section" aria-labelledby="rs-gaps">
          <h2 id="rs-gaps" className="rs-h2">
            4 · What would sharpen this
          </h2>
          <p className="rs-prose">
            The report is only as good as what it rests on. These answers would buy the most:
          </p>
          <ul className="rs-list">
            {report.data_gaps.map((g) => (
              <li className="rs-gap" key={g.question_id}>
                <div>
                  <p className="rs-item-head">
                    <span className="label">{g.priority}</span>
                    {g.blocking && <Flag word="BLOCKING" tone="drift" />}
                  </p>
                  <p className="rs-gap-q">{g.prompt}</p>
                  <p className="rs-gap-b">{g.buys}</p>
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
        </section>
      )}

      <footer className="rs-foot">
        <BasisLegend />
        <p>
          Every figure above prints where it came from. Estimates are marked as estimates; nothing
          is invented. Generated from snapshot {report.id.slice(0, 8)}.
        </p>
      </footer>
    </main>
  );
}
