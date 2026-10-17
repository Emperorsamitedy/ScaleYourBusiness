// The sample diagnosis page — the landing page's hero (ux-spec §7.1).
// A flat sheet, not a device mockup, and labelled as fictional at its
// top edge. Every figure follows the number grammar: value in mono,
// a named comparison in the column header, a reference range, a worded
// flag, and its source, date and basis printed beside it.

import { RangeBar } from "../sheet/RangeBar";
import { delta, moneyFig, num } from "../sheet/num";
import type { Flag, SampleRow } from "../../lib/marketing/sample-diagnosis";
import { RECOVERY_RANGE, SAMPLE } from "../../lib/marketing/sample-diagnosis";

const FLAG_TONE: Record<Flag, string> = {
  "IN RANGE": "ok",
  "BELOW RANGE": "low",
  "ABOVE RANGE": "drift",
  "ACT NOW": "alarm",
  "NOT PROVIDED": "none",
};

function FlagWord({ flag }: { flag: Flag }) {
  return <span className={`flag ${FLAG_TONE[flag]}`}>{flag}</span>;
}

const unitText = (u: SampleRow["unit"]) => (u === "EUR" ? " EUR" : u === "%" ? " %" : "×");

function Row({ r }: { r: SampleRow }) {
  const v = r.value;
  const d = v !== null && r.prior !== null ? delta(v - r.prior, r.decimals) : "—";
  return (
    <tr className={r.flag === "ACT NOW" ? "is-alarm" : undefined}>
      <th scope="row" className="ds-measure">
        <span className="ds-measure-name">{r.measure}</span>
        <span className="ds-src mono">
          <b>{r.basis}</b> · {r.source} · {r.observed}
        </span>
      </th>
      <td className="fig num-col" data-label="Value">
        {v === null ? (
          <span className="ds-missing">Not provided</span>
        ) : (
          <span>
            {num(v, r.decimals)}
            <span className="ds-unit">{unitText(r.unit)}</span>
          </span>
        )}
      </td>
      <td className="fig num-col" data-label="vs prior 28 d">
        {d}
      </td>
      <td className="fig num-col ds-range" data-label="Reference range">
        {r.range ? (
          <span>
            {num(r.range[0], r.decimals)} – {num(r.range[1], r.decimals)}
            <span className="ds-range-from">{r.range_from}</span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td className="ds-bar">
        {v !== null && <RangeBar scale={r.scale} value={v} band={r.range} actAt={r.act_at} />}
      </td>
      <td className="ds-flag" data-label="Flag">
        <FlagWord flag={r.flag} />
      </td>
    </tr>
  );
}

export function SampleSheet() {
  const s = SAMPLE;
  return (
    <article className="sheet ds" aria-labelledby="ds-store">
      <p className="ds-stamp label">Sample · fictional store · not a customer</p>

      <header className="ds-head">
        <div>
          <p className="label ds-kicker">
            Diagnosis {s.ref} · issued {s.issued}
          </p>
          <h3 id="ds-store" className="ds-store">
            {s.store}
          </h3>
          <p className="mono ds-sub">
            {s.platform} · {s.currency} · {s.window.from} – {s.window.to} ·{" "}
            <span className="fig">{s.window.days}</span> d ·{" "}
            <span className="fig">{num(s.orders)}</span> orders
          </p>
        </div>
        <div className="ds-primary">
          <p className="label">Could recover · EUR a month · range</p>
          <p className="display ds-fig">
            {moneyFig(RECOVERY_RANGE.low_minor, s.currency)} –{" "}
            {moneyFig(RECOVERY_RANGE.high_minor, s.currency)}
          </p>
          <p className="mono ds-fig-note">
            from F1–F3 · rests on 2 <b>ASSUMED</b> inputs
          </p>
        </div>
      </header>

      <p className="ds-summary">{s.summary}</p>

      <section aria-labelledby="ds-results">
        <h4 id="ds-results" className="ds-h label">
          1 · Results
        </h4>
        <div className="ds-scroll">
          <table className="ds-table">
            <caption className="vh">
              Results for {s.window.from} to {s.window.to}, compared with the prior 28 days
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure · source · date</th>
                <th scope="col" className="num-col">
                  Value
                </th>
                <th scope="col" className="num-col">
                  vs prior 28 d
                </th>
                <th scope="col" className="num-col">
                  Reference range
                </th>
                <th scope="col">
                  <span className="vh">Position in range</span>
                </th>
                <th scope="col">Flag</th>
              </tr>
            </thead>
            <tbody>
              {s.rows.map((r) => (
                <Row key={r.measure} r={r} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="ds-legend mono">
          <span className="rbar ds-legend-bar" aria-hidden="true">
            <span className="rbar-band" style={{ left: "30%", width: "40%" }} />
            <span className="rbar-act" style={{ left: "12%" }} />
            <span className="rbar-tick" style={{ left: "55%" }} />
          </span>{" "}
          tinted band = reference range · ink tick = your value · dashed line = act now past here
        </p>
      </section>

      <section aria-labelledby="ds-findings">
        <h4 id="ds-findings" className="ds-h label">
          2 · Findings, most urgent first
        </h4>
        <ol className="ds-findings">
          {s.findings.map((f) => (
            <li key={f.ref} className="ds-finding">
              <p className="ds-finding-head">
                <span className="mono ds-ref">{f.ref}</span>
                <FlagWord flag={f.flag} />
              </p>
              <h5 className="ds-finding-title">{f.title}</h5>
              <p className="ds-finding-detail">{f.detail}</p>
              <ul className="ds-evidence mono">
                {f.evidence.map((e) => (
                  <li key={e.fact}>
                    {e.fact} · <b>{e.basis}</b> · {e.source}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="ds-recovery">
        <h4 id="ds-recovery" className="ds-h label">
          3 · How the recoverable range is built
        </h4>
        <div className="ds-scroll">
          <table className="ds-table ds-table-tight">
            <caption className="vh">Recoverable amount per fix, EUR a month, low to high</caption>
            <thead>
              <tr>
                <th scope="col">Fix</th>
                <th scope="col" className="num-col">
                  EUR / month, low
                </th>
                <th scope="col" className="num-col">
                  high
                </th>
                <th scope="col">Basis · how</th>
              </tr>
            </thead>
            <tbody>
              {s.recovery.map((p) => (
                <tr key={p.label}>
                  <th scope="row">{p.label}</th>
                  <td className="fig num-col" data-label="Low">
                    {moneyFig(p.low_minor, s.currency)}
                  </td>
                  <td className="fig num-col" data-label="High">
                    {moneyFig(p.high_minor, s.currency)}
                  </td>
                  <td className="ds-how" data-label="Basis · how">
                    <span>
                      <b className="mono">{p.basis}</b> · {p.how}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="fig num-col" data-label="Low">
                  {moneyFig(RECOVERY_RANGE.low_minor, s.currency)}
                </td>
                <td className="fig num-col" data-label="High">
                  {moneyFig(RECOVERY_RANGE.high_minor, s.currency)}
                </td>
                <td className="ds-how" data-label="Note">
                  <span>a range, never one number: it rests on your choices</span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <footer className="ds-foot mono">
        <b>OBSERVED</b> read from a connected account · <b>DERIVED</b> worked out from other facts ·{" "}
        <b>ESTIMATED</b> your own estimate · <b>ASSUMED</b> an input to a forecast
      </footer>
    </article>
  );
}
