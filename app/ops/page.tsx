// /ops?key=… — the P1-53 dashboard: funnel, abandonment, cost.
// Server component; reads the summaries directly, no client fetch. The
// same OPS_KEY gates it, and a wrong key renders the same nothing a
// wrong URL would.

import { secretMatches } from "../../lib/core/secret-compare";
import type { Metadata } from "next";
import { abandonmentSummary, costSummary, funnelSummary } from "../../lib/ops/summary";

export const metadata: Metadata = { title: "Ops — Ledgerline" };
export const dynamic = "force-dynamic";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const eur = (x: number) => `€${x.toFixed(4)}`;

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ key?: string; days?: string }>;
}) {
  const params = await searchParams;
  const secret = process.env.OPS_KEY;
  if (!secretMatches(params.key, secret)) {
    return (
      <main className="auth-stage">
        <p className="auth-copy">There is nothing here.</p>
      </main>
    );
  }
  const days = Math.min(365, Math.max(1, Number.parseInt(params.days ?? "30", 10) || 30));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const [funnel, abandonment, costs] = await Promise.all([
    funnelSummary(since),
    abandonmentSummary(since),
    costSummary(since),
  ]);

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          ops · last {days} days · {new Date().toISOString().slice(0, 10)}
        </span>
      </header>

      <section className="card ops-card">
        <span className="auth-eyebrow">funnel</span>
        <div className="ops-funnel">
          <div>
            <b>{funnel.started}</b>
            <span>started</span>
          </div>
          <i>→</i>
          <div>
            <b>{funnel.core_completed}</b>
            <span>core complete · {pct(funnel.conversion.core)}</span>
          </div>
          <i>→</i>
          <div>
            <b>{funnel.report_delivered}</b>
            <span>report delivered · {pct(funnel.conversion.report)}</span>
          </div>
          <i>→</i>
          <div>
            <b>{funnel.responded}</b>
            <span>responded · {pct(funnel.conversion.responded)}</span>
          </div>
        </div>
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">where intakes stall</span>
        {abandonment.length === 0 ? (
          <p className="auth-copy">No stalled intakes in this window.</p>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>last question shown</th>
                <th>stalled profiles</th>
              </tr>
            </thead>
            <tbody>
              {abandonment.slice(0, 15).map((row) => (
                <tr key={row.question_id}>
                  <td className="ops-mono">{row.question_id}</td>
                  <td>{row.stalled_profiles}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">
          cost · {eur(costs.total_eur)} across {costs.total_calls} calls
        </span>
        <p className="auth-copy">
          {Object.entries(costs.by_workload)
            .map(([w, c]) => `${w} ${eur(c)}`)
            .join(" · ") || "No metered calls in this window."}
        </p>
        {costs.accounts.length > 0 && (
          <table className="ops-table">
            <thead>
              <tr>
                <th>account</th>
                <th>calls</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {costs.accounts.slice(0, 20).map((a) => (
                <tr key={a.account_id}>
                  <td className="ops-mono">{a.account_id.slice(0, 8)}</td>
                  <td>{a.calls}</td>
                  <td>{eur(a.cost_eur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
