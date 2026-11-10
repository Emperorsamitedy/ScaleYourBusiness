// The country compliance matrix on /ops (the v1 build spec §9.2, P7-32):
// every row as it stands, the latest changes with who and why, and one form
// that sets a country's whole row. Server-rendered; the form posts to
// /api/ops/compliance-matrix.

import type { CountryChange, CountryRule } from "../../lib/compliance/matrix";

const yes = (b: boolean) => (b ? "yes" : "no");

export function ComplianceMatrix({
  opsKey,
  rules,
  changes,
  outcome,
}: {
  opsKey: string;
  rules: CountryRule[];
  changes: CountryChange[];
  outcome: string | undefined;
}) {
  return (
    <section className="card ops-card" aria-labelledby="ops-matrix-title">
      <span className="auth-eyebrow" id="ops-matrix-title">
        country compliance matrix · {rules.length} {rules.length === 1 ? "country" : "countries"}
      </span>
      <p className="auth-copy">
        A country with no row is blocked for phone answering and outbound calling. A country is
        unblocked only with counsel&rsquo;s sign-off date and reference. &ldquo;Halted&rdquo; stops
        everything SYB does outside itself for businesses in that country, at every station. Every
        change is logged with who made it and why.
      </p>
      {outcome && (
        <p className="auth-copy" role="status">
          {outcome === "saved" ? "Saved, and logged." : outcome}
        </p>
      )}
      {rules.length > 0 && (
        <table className="ops-table">
          <thead>
            <tr>
              <th>country</th>
              <th>recording</th>
              <th>criminal penalty</th>
              <th>phone answering</th>
              <th>outbound calling</th>
              <th>halted</th>
              <th>counsel&rsquo;s sign-off</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.country}>
                <td className="ops-mono">{r.country}</td>
                <td>{r.recording_regime === "all_party" ? "all-party" : "single-party"}</td>
                <td>{yes(r.criminal_penalty)}</td>
                <td>{r.blocked ? "blocked" : "unblocked"}</td>
                <td>{r.outbound_blocked ? "blocked" : "unblocked"}</td>
                <td>{yes(r.execution_halted)}</td>
                <td>
                  {r.legal_signoff_date
                    ? `${r.legal_signoff_date} · ${r.legal_signoff_reference ?? ""}`
                    : "none"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="ops-form" method="post" action="/api/ops/compliance-matrix">
        <input type="hidden" name="key" value={opsKey} />
        <label className="auth-copy">
          Country (two letters){" "}
          <input name="country" required pattern="[A-Za-z]{2}" maxLength={2} autoComplete="off" />
        </label>
        <label className="auth-copy">
          Recording{" "}
          <select name="recording_regime" defaultValue="all_party">
            <option value="all_party">all-party consent</option>
            <option value="single_party">single-party consent</option>
          </select>
        </label>
        <label className="auth-copy">
          <input type="checkbox" name="criminal_penalty" defaultChecked /> Recording without consent
          is a criminal offence
        </label>
        <label className="auth-copy">
          <input type="checkbox" name="outbound_consent_required" defaultChecked /> Outbound calls
          need prior consent
        </label>
        <label className="auth-copy">
          <input type="checkbox" name="blocked" defaultChecked /> Phone answering blocked
        </label>
        <label className="auth-copy">
          <input type="checkbox" name="outbound_blocked" defaultChecked /> Outbound calling blocked
        </label>
        <label className="auth-copy">
          <input type="checkbox" name="execution_halted" /> Halt everything SYB does outside itself
          here
        </label>
        <label className="auth-copy">
          Counsel&rsquo;s sign-off date <input name="legal_signoff_date" type="date" />
        </label>
        <label className="auth-copy">
          Sign-off reference{" "}
          <input name="legal_signoff_reference" maxLength={300} autoComplete="off" />
        </label>
        <label className="auth-copy">
          Note (optional) <input name="note" maxLength={500} autoComplete="off" />
        </label>
        <label className="auth-copy">
          Your name <input name="actor" required maxLength={200} autoComplete="off" />
        </label>
        <label className="auth-copy">
          Why <input name="reason" required maxLength={500} autoComplete="off" />
        </label>
        <button type="submit" className="next">
          Save this country&rsquo;s row
        </button>
      </form>
      {changes.length > 0 && (
        <table className="ops-table">
          <thead>
            <tr>
              <th>when</th>
              <th>country</th>
              <th>change</th>
              <th>who</th>
              <th>why</th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c) => (
              <tr key={c.id}>
                <td className="ops-mono">{c.at.slice(0, 16).replace("T", " ")}</td>
                <td className="ops-mono">{c.country}</td>
                <td>{c.op.toLowerCase()}</td>
                <td>{c.actor}</td>
                <td>{c.reason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
