// Launch readiness on /ops — the deploy checklist of docs/SECURITY-AUDIT.md
// ("Before you deploy main"), computed live by lib/ops/readiness.ts and
// drawn on the sheet system: the page head, one paper sheet per step, a
// ruled table that stacks on a phone, and a worded flag per item. The
// report it is given carries presence and non-secret facts only, so
// nothing here can show a key, however it is changed.

import "../../app/ops-readiness.css";
import { PageHead, SheetCard } from "../sheet/PageHead";
import type { ReadinessItem, ReadinessReport, ReadinessStatus } from "../../lib/ops/readiness";
import { STATUS_WORD } from "../../lib/ops/readiness";

/** The flag tint each status reads in; the word carries the meaning. */
const FLAG: Readonly<Record<ReadinessStatus, string>> = {
  ready: "ok",
  missing: "alarm",
  check: "drift",
  off: "low",
};

function headline(counts: ReadinessReport["counts"]): string {
  if (counts.missing > 0) {
    return `${counts.missing} ${counts.missing === 1 ? "setting is" : "settings are"} missing or wrong, and ${counts.check} ${counts.check === 1 ? "needs" : "need"} checking by hand.`;
  }
  return `Nothing is missing. ${counts.check} ${counts.check === 1 ? "thing needs" : "things need"} checking by hand.`;
}

function tally(items: readonly ReadinessItem[]): string {
  const order: ReadinessStatus[] = ["missing", "check", "ready", "off"];
  return order
    .map((s) => [s, items.filter((i) => i.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${STATUS_WORD[s].toLowerCase()}`)
    .join(" · ");
}

export function LaunchReadiness({ report }: { report: ReadinessReport }) {
  const { counts } = report;
  return (
    <section className="lr" aria-labelledby="lr-title" id="launch-readiness">
      <PageHead
        kicker="Ops · Launch readiness"
        title={<span id="lr-title">{headline(counts)}</span>}
        aside={report.app_origin ?? "APP_URL isn't set"}
      >
        <p className="lr-note">
          I worked this out just now from this deployment&rsquo;s environment and database, in the
          order of &ldquo;Before you deploy main&rdquo;. I show whether a key is set, never its
          value. {counts.ready} ready · {counts.missing} missing · {counts.check} to check ·{" "}
          {counts.off} off.
        </p>
      </PageHead>
      <div className="lr-groups">
        {report.groups.map((g) => (
          <SheetCard
            key={g.key}
            id={`lr-${g.key}`}
            label={g.step}
            title={g.title}
            meta={tally(g.items)}
          >
            <table className="rt rt-stack lr-table">
              <thead>
                <tr>
                  <th scope="col">setting</th>
                  <th scope="col">status</th>
                  <th scope="col">what it is, and what to do</th>
                  <th scope="col">where to get it</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((i) => (
                  <tr key={i.name}>
                    <th scope="row" className="lr-name">
                      {i.name}
                    </th>
                    <td data-label="status">
                      <span className={`flag ${FLAG[i.status]}`}>{STATUS_WORD[i.status]}</span>
                    </td>
                    <td data-label="what to do">
                      {i.says}
                      {i.paste && i.paste.length > 0 && (
                        <span className="lr-paste">
                          {i.paste.map((p) => (
                            <code key={p} className="mono">
                              {p}
                            </code>
                          ))}
                        </span>
                      )}
                      {i.how && (
                        <span className="lr-paste">
                          <code className="mono">{i.how}</code>
                        </span>
                      )}
                    </td>
                    <td data-label="where">
                      {i.where ? (
                        <a href={i.where.href} target="_blank" rel="noreferrer noopener">
                          {i.where.label}
                        </a>
                      ) : (
                        <span className="lr-none">
                          {i.where_text ?? "Nowhere outside this page"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SheetCard>
        ))}
      </div>
      <p className="lr-note lr-foot">
        A key that is set isn&rsquo;t proven to work. The smoke tests prove the real paths:{" "}
        <code className="mono">npm run smoke:email</code>,{" "}
        <code className="mono">smoke:inbound</code>, <code className="mono">smoke:erasure</code> and{" "}
        <code className="mono">smoke:widget</code>.
      </p>
    </section>
  );
}
