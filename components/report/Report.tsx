"use client";

// The diagnosis report — Session G (P1-34..41), UX spec §7.
//
// Long-form, readable, printable. Structure top to bottom: three-sentence
// summary → unit economics with every figure's mono source line → findings
// (severity as MONO LABEL, never a colour) → recommendations with their
// scenario blocks and two equal-weight actions → what would sharpen this.
//
// Everything rendered here was computed or evidence-checked in code
// before it reached the row; this component adds no numbers of its own.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

/* ── shapes from lib/report/service.ts ── */

interface FactInfo {
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
}
interface Computed<T> {
  value: T;
  derived_from: string[];
  formula: string;
  confidence: number;
}
interface MoneyV {
  amount_minor: number;
  currency: string;
}
interface OfferEco {
  offer_id: string;
  name: string;
  price: MoneyV;
  cost_to_deliver: MoneyV | null;
  margin_pct: Computed<number> | null;
  contribution: Computed<MoneyV> | null;
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
interface Economics {
  /** Absent on reports generated before Phase 2. */
  stated_vs_measured?: StatedVsMeasuredRow[];
  currency: string;
  offers: OfferEco[];
  blended_margin_pct: Computed<number> | null;
  break_even: Computed<{ units_per_month: number }> | null;
  /** Absent on reports generated before Phase 2 Session D. */
  cost_per_acquisition?: Computed<MoneyV> | null;
  return_on_ad_spend?: Computed<number> | null;
  fixed_costs_monthly: Computed<MoneyV> | null;
  stated_vs_computed_margin: { stated_pct: number; computed_pct: number; delta_pts: number } | null;
}
interface Finding {
  area: string;
  title: string;
  detail: string;
  evidence: string[];
  severity: "critical" | "high" | "medium" | "low";
  confidence: number;
}
interface Outcome {
  case: string;
  statement: string;
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

const SOURCE_LABEL: Record<string, string> = {
  owner_input: "you told me",
  conversation: "from our conversation",
  inferred: "computed",
  web_research: "researched",
  connector: "measured",
  system_default: "assumed",
};

/** UX spec §7: reasons pre-filled as chips — a required field produces junk. */
const DECLINE_CHIPS = [
  "we tried this before",
  "not possible in my market",
  "can't take this on right now",
];

const fmtMoney = (m: MoneyV): string =>
  `${Math.round(m.amount_minor / 100)
    .toLocaleString("en-US")
    .replace(/,/g, " ")} ${m.currency}`;

/** P1-36: the mono source line under a figure. */
function SourceLine({ from, map }: { from: string[]; map: Record<string, FactInfo> }) {
  const kinds = [...new Set(from.map((k) => map[k]?.source_kind ?? "unknown"))];
  const conf = Math.min(...from.map((k) => map[k]?.confidence ?? 0));
  return (
    <span className="rp-src">
      {kinds.map((k) => SOURCE_LABEL[k] ?? k).join(" + ")} · confidence{" "}
      {Number.isFinite(conf) ? Math.round(conf * 100) : "?"}%
    </span>
  );
}

function EvidenceLine({ keys, map }: { keys: string[]; map: Record<string, FactInfo> }) {
  return (
    <p className="rp-evidence">
      rests on:{" "}
      {keys.map((k, i) => {
        const f = map[k];
        return (
          <span key={k}>
            {i > 0 && " · "}
            <span className="rp-ev-key">{k.split(".").pop()?.replace(/_/g, " ")}</span>
            {f?.value !== null && f?.value !== undefined && <> = {f.value}</>}
            {f && <em> ({SOURCE_LABEL[f.source_kind] ?? f.source_kind})</em>}
          </span>
        );
      })}
    </p>
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

function RecommendationCard({
  rec,
  index,
  reportId,
  onChanged,
}: {
  rec: Rec;
  index: number;
  reportId: string;
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

  return (
    <article className="rp-rec">
      <header className="rp-rec-head">
        <h3>{rec.title}</h3>
        <span className="rp-mono">
          effort {rec.effort} · undo {rec.reversibility.level}
        </span>
      </header>
      <p className="rp-body">{rec.rationale}</p>

      <div className="rp-breakeven">{rec.scenario.breakeven_condition}</div>

      {rec.sensitivity_callouts.map((c) => (
        <p className="rp-callout" key={c}>
          ⚠ {c}
        </p>
      ))}

      <div className="rp-cases">
        {[rec.scenario.base_case, rec.scenario.downside_case, rec.scenario.upside_case].map((o) => (
          <div className="rp-case" key={o.case}>
            <span className="rp-mono">{o.case.toUpperCase()}</span>
            <p>{o.statement}</p>
            {o.formula !== null && <code>{o.formula}</code>}
          </div>
        ))}
      </div>

      <details className="rp-assumptions">
        <summary>the assumptions, stated</summary>
        <ul>
          {rec.scenario.assumptions.map((a) => (
            <li key={a.statement}>
              {a.statement}
              <em>
                {" "}
                — {a.source_field !== null ? `from ${a.source_field}` : "an assumption"} ·
                sensitivity {a.sensitivity}
              </em>
            </li>
          ))}
        </ul>
      </details>

      <p className="rp-undo">
        <strong>If you change your mind:</strong> {rec.reversibility.if_you_change_your_mind}
      </p>

      {/* §8: two actions, equal visual weight — "no" is a legitimate answer */}
      {rec.status === "proposed" && !declining && (
        <div className="rp-actions">
          <button className="rp-act" onClick={() => void respond("look_into")} disabled={busy}>
            Look into this
          </button>
          <button className="rp-act" onClick={() => setDeclining(true)} disabled={busy}>
            Not for us
          </button>
        </div>
      )}
      {declining && (
        <Decline busy={busy} onSubmit={(reason) => void respond("not_for_us", reason)} />
      )}
      {rec.status === "accepted" && (
        <p className="rp-responded">✓ you&rsquo;re looking into this</p>
      )}
      {rec.status === "rejected" && (
        <p className="rp-responded">
          declined{rec.rejection_reason !== null ? ` — “${rec.rejection_reason}”` : ""}
        </p>
      )}
    </article>
  );
}

export function ReportScreen() {
  const [report, setReport] = useState<ReportView | null>(null);
  const [state, setState] = useState<"loading" | "none" | "generating" | "ready" | "error">(
    "loading",
  );
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
    setError(null);
    try {
      const res = await fetch("/api/report", { method: "POST" });
      if (res.status === 402) {
        // P1-50: the report is paid. Start checkout and hand the browser
        // to Stripe; the webhook makes it real, and coming back here with
        // ?checkout=success retries generation against the paid record.
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
      <main className="rp-shell">
        <p className="rp-empty">Checking for your report…</p>
      </main>
    );
  }
  if (state === "error") {
    return (
      <main className="rp-shell">
        <p className="rp-empty">
          Something went wrong loading the report. Refresh to try again — nothing you told me is
          lost.
        </p>
      </main>
    );
  }
  if (state === "generating") {
    return (
      <main className="rp-shell">
        <div className="rp-generating">
          <span className="rp-gen-ring" aria-hidden="true" />
          <h1>Reading everything you told me…</h1>
          <p>
            Margins, break-even, the findings and what to do about them. This takes about a minute —
            the arithmetic is checked before anything reaches the page.
          </p>
        </div>
      </main>
    );
  }
  if (state === "none" || report === null) {
    return (
      <main className="rp-shell">
        <div className="rp-none">
          <h1>No report yet.</h1>
          <p>
            {error !== null
              ? error
              : "When you've answered enough, I read the whole profile and write up what I can prove."}
          </p>
          <div className="rp-actions" style={{ maxWidth: 420 }}>
            <button className="rp-act" onClick={() => void generate()}>
              Read my profile now
            </button>
            <Link className="rp-act quietlink" href="/intake">
              Answer more first
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const eco = report.unit_economics;

  return (
    <main className="rp-shell">
      <header className="rp-top noprint">
        <span className="wordmark">Ledgerline</span>
        <button className="rp-print" onClick={() => window.print()}>
          Print / PDF
        </button>
      </header>

      <div className="rp-title">
        <span className="rp-mono">
          DIAGNOSIS ·{" "}
          {new Date(report.generated_at).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}{" "}
          · COMPLETENESS {Math.round(report.completeness * 100)}%
        </span>
        <h1>Here&rsquo;s what I can see.</h1>
      </div>

      {/* ── the three sentences ── */}
      <section className="rp-summary">
        <p>{report.summary}</p>
      </section>

      {/* ── unit economics, every figure with its mono source line ── */}
      <section className="rp-block">
        <h2>The numbers</h2>
        {eco.offers.length === 0 && (
          <p className="rp-empty">No offers with prices yet — the economics need them.</p>
        )}
        {eco.offers.map((o) => (
          <div className="rp-eco-row" key={o.offer_id}>
            <span className="rp-eco-name">{o.name}</span>
            <span className="rp-eco-fig">
              {fmtMoney(o.price)}
              {o.cost_to_deliver && <> − {fmtMoney(o.cost_to_deliver)} cost</>}
              {o.volume !== null && <> · {o.volume}/mo</>}
            </span>
            <span className="rp-eco-margin">
              {o.margin_pct ? (
                <>
                  {o.margin_pct.value}% margin
                  <SourceLine from={o.margin_pct.derived_from} map={report.fact_map} />
                </>
              ) : (
                <em>margin unknowable — cost missing</em>
              )}
            </span>
          </div>
        ))}
        {/* Rule 11 (P2-11): a measurement replaced an estimate, and both are shown. */}
        {(eco.stated_vs_measured ?? []).map((s) => {
          // P2-16 / P2-18: a measured figure for one matched offer or channel.
          const volume = /^offers\.([^.]+)\.volume_period$/.exec(s.field_key);
          const traffic = /^channels\.([^.]+)\.monthly_sessions$/.exec(s.field_key);
          const entityNoun = volume
            ? `units a month of ${report.fact_map[`offers.${volume[1]}.name`]?.value ?? "this product"}`
            : traffic
              ? `monthly visits from your ${report.fact_map[`channels.${traffic[1]}.type`]?.value ?? "channel"} channel`
              : null;
          const noun =
            entityNoun ??
            (
              {
                "revenue.monthly_revenue": "monthly revenue",
                "revenue.order_count_monthly": "orders a month",
                "marketing.monthly_ad_spend": "monthly ad spend",
                "marketing.cost_per_purchase": "cost per purchase from ads",
                "presence.monthly_sessions": "monthly website visits",
              } as Record<string, string>
            )[s.field_key] ??
            s.field_key;
          const show = (v: unknown): string => {
            if (typeof v === "number") return v.toLocaleString("en-US").replace(/,/g, " ");
            const m = v as MoneyV | null;
            return m !== null && typeof m === "object" && typeof m.amount_minor === "number"
              ? fmtMoney(m)
              : "—";
          };
          const period = /over (\S+)\.\.(\S+)/.exec(s.measured.method);
          const span = period ? ` between ${period[1]} and ${period[2]}` : "";
          const pct = s.delta?.pct;
          const change = pct !== null && pct !== undefined ? ` (${pct > 0 ? "+" : ""}${pct}%)` : "";
          return (
            <p className="rp-discrepancy" key={s.field_key}>
              {s.stated.value === null
                ? `You didn't know your ${noun}. ${s.provider} measured ${show(s.measured.value)}${span}.`
                : `You estimated ${show(s.stated.value)} for ${noun}. ${s.provider} measured ${show(s.measured.value)}${span}${change}.`}{" "}
              The analysis uses the measured figure, and your estimate stays in your history.
            </p>
          );
        })}
        {eco.stated_vs_computed_margin && (
          <p className="rp-discrepancy">
            You said {eco.stated_vs_computed_margin.stated_pct}% margin; your own product figures
            compute to {eco.stated_vs_computed_margin.computed_pct}% — a{" "}
            {Math.abs(eco.stated_vs_computed_margin.delta_pts).toFixed(0)}-point gap. Both are
            shown; the analysis uses the computed one.
          </p>
        )}
        {/* P2-21: what the ads pay back, computed only when both sides were measured or stated. */}
        {eco.cost_per_acquisition && (
          <p className="rp-eco-be">
            Cost to acquire a new customer: {fmtMoney(eco.cost_per_acquisition.value)}{" "}
            <SourceLine from={eco.cost_per_acquisition.derived_from} map={report.fact_map} />
          </p>
        )}
        {eco.return_on_ad_spend && (
          <p className="rp-eco-be">
            Return on ad spend: {eco.return_on_ad_spend.value.toFixed(2)}× revenue per unit of ad
            spend, blended across everything you sell{" "}
            <SourceLine from={eco.return_on_ad_spend.derived_from} map={report.fact_map} />
          </p>
        )}
        {eco.break_even && (
          <p className="rp-eco-be">
            Break-even: {eco.break_even.value.units_per_month} units/month{" "}
            <span className="rp-src">
              {eco.break_even.formula} · confidence {Math.round(eco.break_even.confidence * 100)}%
            </span>
          </p>
        )}
      </section>

      {/* ── findings: mono severity label, never a colour ── */}
      <section className="rp-block">
        <h2>Findings</h2>
        {report.findings.map((f) => (
          <article className="rp-finding" key={f.title}>
            <header>
              <span className="rp-sev">{f.severity.toUpperCase()}</span>
              <h3>{f.title}</h3>
            </header>
            <p className="rp-body">{f.detail}</p>
            <EvidenceLine keys={f.evidence} map={report.fact_map} />
          </article>
        ))}
      </section>

      {/* ── trading hours (P2-30): measured, deterministic, the arithmetic shown ── */}
      {report.trading_hours && (
        <section className="rp-block">
          <h2>Your trading hours</h2>
          <p className="rp-body">
            From measured hourly sales, {report.trading_hours.from} to {report.trading_hours.to}.{" "}
            Measured: {report.trading_hours.coverage}.
          </p>
          {report.trading_hours.findings.length === 0 && (
            <p className="rp-body">No signal fires on any measured day.</p>
          )}
          {report.trading_hours.findings.map((f) => (
            <article className="rp-finding" key={f.signal}>
              <header>
                <span className="rp-sev">
                  {f.signal === "too_early" ? "TOO EARLY" : "MEASURED"}
                </span>
                <h3>{f.title}</h3>
              </header>
              <p className="rp-body">{f.detail}</p>
              {f.arithmetic.map((a) => (
                <p className="rp-src" key={a}>
                  {a}
                </p>
              ))}
            </article>
          ))}
          <p className="rp-src">
            {report.trading_hours.limit} <Link href="/hours">See every weekday →</Link>
          </p>
        </section>
      )}

      {/* ── recommendations with scenarios and the two equal actions ── */}
      <section className="rp-block">
        <h2>What I&rsquo;d do about it</h2>
        {report.recommendations.map((rec, i) => (
          <RecommendationCard
            key={rec.title}
            rec={rec}
            index={i}
            reportId={report.id}
            onChanged={async () => {
              await load();
            }}
          />
        ))}
      </section>

      {/* ── what would sharpen this ── */}
      {report.data_gaps.length > 0 && (
        <section className="rp-block">
          <h2>What would sharpen this</h2>
          <p className="rp-body">
            The report is only as good as what it rests on. These answers would buy the most:
          </p>
          {report.data_gaps.map((g) => (
            <div className="rp-gap" key={g.question_id}>
              <div>
                <p className="rp-gap-q">{g.prompt}</p>
                <p className="rp-gap-b">{g.buys}</p>
              </div>
              <Link
                className="ghost quiet noprint"
                href={`/intake?ask=${encodeURIComponent(g.question_id)}`}
              >
                Answer now
              </Link>
            </div>
          ))}
        </section>
      )}

      <footer className="rp-foot">
        Every figure above can say where it came from. Estimates are marked as estimates; nothing is
        invented. Generated from snapshot {report.id.slice(0, 8)}.
      </footer>
    </main>
  );
}
