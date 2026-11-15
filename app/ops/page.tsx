// /ops?key=… — the P1-53 dashboard: funnel, abandonment, cost — and, since
// P3-24d, what Blob storage holds and costs, read from the store itself —
// and the launch-readiness checklist, computed live from the environment
// and the database (lib/ops/readiness.ts), presence only, never a value.
// Server component; reads the summaries directly, no client fetch. The
// same OPS_KEY gates it, and a wrong key renders the same nothing a
// wrong URL would.

import { secretMatches } from "../../lib/core/secret-compare";
import type { Metadata } from "next";
import {
  abandonmentSummary,
  costSummary,
  funnelSummary,
  storageSummary,
} from "../../lib/ops/summary";
import type { StorageSummary } from "../../lib/ops/summary";
import { REGIMES } from "../../lib/crm/jurisdiction";
import { jurisdictionTableHash, latestLawReview, lawReviewVerdict } from "../../lib/crm/law-review";
import { campaignsAwaitingReview } from "../../lib/crm/campaign-review";
import { launchReadiness } from "../../lib/ops/readiness";
import { readReadinessFacts } from "../../lib/ops/readiness-facts";
import { LaunchReadiness } from "../../components/ops/LaunchReadiness";
import { ComplianceMatrix } from "../../components/ops/ComplianceMatrix";
import { listCountryRules, recentCountryChanges } from "../../lib/compliance/matrix";
import { Logo } from "../../components/brand/Mark";

export const metadata: Metadata = { title: "Ops — ScaleX" };
export const dynamic = "force-dynamic";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const eur = (x: number) => `€${x.toFixed(4)}`;
/** Integer micro-dollars as dollars, to the micro-dollar — never a float in the data. */
const usdMicro = (m: number) =>
  `$${Math.floor(m / 1_000_000)}.${String(m % 1_000_000).padStart(6, "0")}`;
const size = (bytes: number) =>
  bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
    : bytes >= 1_000_000
      ? `${(bytes / 1_000_000).toFixed(1)} MB`
      : `${(bytes / 1_000).toFixed(1)} kB`;

/** P3-24d: the storage line, read from the media store itself. */
function storageLine(st: StorageSummary): string {
  if (!st.known) return st.reason;
  return [
    `${size(st.bytes)} in ${st.objects} ${st.objects === 1 ? "render" : "renders"}${st.truncated ? " (at least — the listing stopped at its cap)" : ""}`,
    `${usdMicro(st.monthly_list_micro_usd)} a month at list price (${usdMicro(st.price_micro_usd_per_gb_month)} per GB-month; verify at build)`,
    st.within_hobby_included ? "within Hobby's included 1 GB" : "over Hobby's included 1 GB",
  ].join(" · ");
}

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{
    key?: string;
    days?: string;
    law_review?: string;
    campaign_review?: string;
    compliance_matrix?: string;
  }>;
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
  const [funnel, abandonment, costs, storage, review, awaiting, matrix, matrixChanges] =
    await Promise.all([
      funnelSummary(since),
      abandonmentSummary(since),
      costSummary(since),
      storageSummary(),
      latestLawReview(),
      campaignsAwaitingReview(),
      listCountryRules(),
      recentCountryChanges(),
    ]);
  // P4-15: the email-law review — the table as it is now, and whether a review covers it.
  const tableHash = jurisdictionTableHash();
  const verdict = lawReviewVerdict(review, tableHash);
  // The deploy checklist: this deployment's env and a few database facts, never a secret's value.
  const readiness = launchReadiness(
    process.env,
    await readReadinessFacts({
      law_review: { state: verdict.state, words: verdict.words },
      first_campaigns_waiting: awaiting.length,
    }),
  );

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">
          <Logo onDark />
        </span>
        <span className="ops-meta">
          ops · last {days} days · {new Date().toISOString().slice(0, 10)} ·{" "}
          <a href="#launch-readiness">
            launch readiness: {readiness.counts.missing} missing, {readiness.counts.check} to check
          </a>
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
        <p className="auth-copy">Blob storage · {storageLine(storage)}</p>
      </section>

      <section className="card ops-card" aria-labelledby="ops-law-title">
        <span className="auth-eyebrow" id="ops-law-title">
          email-law review · {verdict.state}
        </span>
        <p className="auth-copy">
          {verdict.words} No campaign sends unless the latest review&rsquo;s hash matches the table
          below. Editing the table voids the review.
          {review && ` Last review: ${review.reviewer}, ${review.reviewed_on}.`}
        </p>
        {params.law_review && (
          <p className="auth-copy" role="status">
            {params.law_review === "recorded" ? "Review recorded." : params.law_review}
          </p>
        )}
        <p className="auth-copy">
          Table hash <span className="ops-mono">{tableHash}</span>
        </p>
        <table className="ops-table">
          <thead>
            <tr>
              <th>regime</th>
              <th>countries</th>
              <th>each message must carry</th>
              <th>unsubscribe honoured within</th>
              <th>link must work for</th>
              <th>source</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(REGIMES).map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td className="ops-mono">{r.countries.join(" ")}</td>
                <td>{r.requires.join(", ").replace(/_/g, " ")}</td>
                <td>
                  {r.honour_unsubscribe_business_days === null
                    ? "without undue delay"
                    : `${r.honour_unsubscribe_business_days} business days`}
                </td>
                <td>
                  {r.unsubscribe_link_min_days === null
                    ? "no stated minimum"
                    : `${r.unsubscribe_link_min_days} days`}
                </td>
                <td>{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <form className="ops-form" method="post" action="/api/ops/law-review">
          <input type="hidden" name="key" value={params.key ?? ""} />
          <input type="hidden" name="table_sha256" value={tableHash} />
          <label className="auth-copy">
            Reviewer (a person&rsquo;s name){" "}
            <input name="reviewer" required maxLength={200} autoComplete="off" />
          </label>
          <label className="auth-copy">
            Reviewed on <input name="reviewed_on" type="date" required />
          </label>
          <label className="auth-copy">
            Note (optional) <input name="note" maxLength={500} autoComplete="off" />
          </label>
          <button type="submit" className="next">
            Record that this table was reviewed against current law
          </button>
        </form>
      </section>

      <section className="card ops-card" aria-labelledby="ops-first-campaign-title">
        <span className="auth-eyebrow" id="ops-first-campaign-title">
          first campaigns · {awaiting.length} waiting
        </span>
        <p className="auth-copy">
          Each account&rsquo;s first campaign waits for a person to read it before it sends, because
          every campaign goes out from ScaleX&rsquo;s own sending address. Read the email and the
          sender it goes out as; record it only if it reads like a real business writing to its own
          customers. Later campaigns from the same account don&rsquo;t wait.
        </p>
        {params.campaign_review && (
          <p className="auth-copy" role="status">
            {params.campaign_review === "recorded" ? "Review recorded." : params.campaign_review}
          </p>
        )}
        {awaiting.length === 0 ? (
          <p className="auth-copy">No first campaign is waiting.</p>
        ) : (
          awaiting.map((c) => (
            <div key={c.proposal_id} className="ops-review">
              <p className="auth-copy">
                Account <span className="ops-mono">{c.account_id.slice(0, 8)}</span> · campaign{" "}
                <span className="ops-mono">{c.proposal_id}</span> · {c.recipients} recipients
                approved · sent as &ldquo;{c.sender_name ?? "not connected yet"} via ScaleX&rdquo;
              </p>
              <p className="auth-copy">{c.summary}</p>
              <p className="auth-copy">Subject: {c.subject ?? "not approved yet"}</p>
              <pre className="ops-mono ops-body">{c.body ?? "No email drafted yet."}</pre>
              <form className="ops-form" method="post" action="/api/ops/campaign-review">
                <input type="hidden" name="key" value={params.key ?? ""} />
                <input type="hidden" name="proposal_id" value={c.proposal_id} />
                <label className="auth-copy">
                  Reviewer (a person&rsquo;s name){" "}
                  <input name="reviewer" required maxLength={200} autoComplete="off" />
                </label>
                <label className="auth-copy">
                  Reviewed on <input name="reviewed_on" type="date" required />
                </label>
                <button type="submit" className="next">
                  Record that I read this account&rsquo;s first campaign
                </button>
              </form>
            </div>
          ))
        )}
      </section>

      <ComplianceMatrix
        opsKey={params.key ?? ""}
        rules={matrix}
        changes={matrixChanges}
        outcome={params.compliance_matrix}
      />

      <LaunchReadiness report={readiness} />
    </main>
  );
}
