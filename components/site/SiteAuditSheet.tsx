"use client";

// The measured site audit on /site — Phase 5 Session C (P5-13), in the
// sheet design system beside the before/after wording. Read-only: the
// findings with their thresholds and € line (or "not computed"), the path
// to buying in clicks, the pages with what Google measured on each at
// phone and computer widths and whether the numbers are real visitors'
// (field) or one test load (lab), and what the audit refused to open.
// "Run the audit" asks the server to read the site again; the screen says
// when Google's shared keyless quota was used and when the week's calls run out.

import { useState } from "react";
import type { SiteAuditView } from "../../lib/site/audit/view";
import { NEVER_LINES, NOT_BUILT, REFUSAL_WORDS } from "../../lib/site/audit/view";
import type { EuroFigure, SiteFinding } from "../../lib/site/audit/findings";
import type { PageSpeedResult } from "../../lib/site/audit/pagespeed";
import { SheetCard } from "../sheet/PageHead";

const SEVERITY: Record<SiteFinding["severity"], { word: string; tone: string }> = {
  critical: { word: "ACT NOW", tone: "alarm" },
  high: { word: "HIGH", tone: "drift" },
  medium: { word: "MEDIUM", tone: "low" },
  low: { word: "LOW", tone: "low" },
};

const BASIS: Record<SiteFinding["evidence"]["basis"], string> = {
  field: "real visitors",
  field_origin: "real visitors, whole site",
  lab: "one test load",
  page_read: "page read",
};

function dayWord(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function bare(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? "home page" : u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

function euroLine(e: EuroFigure): string {
  if (!e.computed) return e.why;
  const f = (m: number) =>
    new Intl.NumberFormat("en-IE", {
      style: "currency",
      currency: e.currency,
      maximumFractionDigits: 0,
    }).format(m / 100);
  return `${f(e.low_minor)}–${f(e.high_minor)} a month`;
}

function measuredValue(f: SiteFinding): string {
  const v = f.evidence.value;
  if (v === undefined) return "—";
  switch (f.evidence.unit) {
    case "ms":
      return f.evidence.metric === "lcp_ms" ? `${(v / 1000).toFixed(1)} s` : `${v} ms`;
    case "bytes":
      return `${(v / 1_000_000).toFixed(1)} MB`;
    case "clicks":
      return `${v} clicks`;
    case "score":
      return v.toFixed(2);
    default:
      return f.code === "broken_link" ? `status ${v}` : String(v);
  }
}

/** One page's phone or computer numbers, field first. */
function speedCell(r: PageSpeedResult | null): string {
  if (!r) return "—";
  const lcp = r.field?.lcp_ms?.p75 ?? r.lab.lcp_ms;
  const cls = r.field?.cls?.p75 ?? r.lab.cls;
  const inp = r.field?.inp_ms?.p75;
  const parts = [
    lcp !== null && lcp !== undefined ? `LCP ${(lcp / 1000).toFixed(1)} s` : null,
    cls !== null && cls !== undefined ? `CLS ${cls.toFixed(2)}` : null,
    inp !== undefined
      ? `INP ${Math.round(inp)} ms`
      : r.lab.tbt_ms !== null
        ? `TBT ${Math.round(r.lab.tbt_ms)} ms (lab)`
        : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function basisOf(r: PageSpeedResult | null): string {
  if (!r) return "not measured";
  if (!r.field) return "lab only — too few visitors for Google's field data";
  return r.field.origin_fallback ? "field (whole site) + lab" : "field + lab";
}

export function SiteAuditSheet({
  initial,
  failure,
}: {
  initial: SiteAuditView | null;
  failure: { at: string; reason: string } | null;
}) {
  const [audit, setAudit] = useState<SiteAuditView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    failure && (!initial || failure.at > initial.ran_at)
      ? `The last run, ${dayWord(failure.at)}, failed: ${failure.reason}`
      : null,
  );

  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/site/audit", { method: "POST" });
      const j = (await res.json()) as { audit?: SiteAuditView; error?: string };
      if (j.audit) setAudit(j.audit);
      if (!res.ok || !j.audit) setNotice(j.error ?? "the audit didn't run");
      else setNotice("Measured — the findings below are this run's.");
    } catch {
      setNotice("the audit didn't run — try again in a moment");
    } finally {
      setBusy(false);
    }
  };

  const runButton = (
    <button type="button" className="prop-btn st-small" disabled={busy} onClick={() => void run()}>
      {busy
        ? "Reading the site… (up to two minutes)"
        : audit
          ? "Run the audit again"
          : "Run the audit"}
    </button>
  );

  if (!audit) {
    return (
      <SheetCard
        label="Measured · not run yet"
        title="Speed, phones and the path to buying, measured"
        meta={runButton}
        foot={NOT_BUILT}
      >
        {notice && (
          <p className="st-note" aria-live="polite">
            {notice}
          </p>
        )}
        <ul className="st-evidence">
          {NEVER_LINES.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </SheetCard>
    );
  }

  const ps = audit.pagespeed;
  const measured = audit.pages.filter((p) => p.mobile || p.desktop);
  return (
    <SheetCard
      label={`Measured · ran ${dayWord(audit.ran_at)} · ${audit.page_reads} pages read · ${ps.calls} PageSpeed calls`}
      title={
        audit.findings.length === 0
          ? "Nothing outside the stated thresholds."
          : `${audit.findings.length} measured finding${audit.findings.length === 1 ? "" : "s"}, each against a stated threshold`
      }
      meta={
        <>
          <span className="word boxed low">no action</span>
          {runButton}
        </>
      }
      foot={
        <>
          {NOT_BUILT} Fixing one goes through a proposal and the queue; checkout is never changed
          automatically — findings there come with instructions.
        </>
      }
    >
      {notice && (
        <p className="st-note" aria-live="polite">
          {notice}
        </p>
      )}
      {!ps.keyed && ps.calls > 0 && (
        <p className="st-note">
          Measured on Google&rsquo;s shared PageSpeed quota — no API key is set, so a busy hour can
          cut a run short.
        </p>
      )}
      {ps.note && <p className="st-note">{ps.note}</p>}
      {ps.next_from && (
        <p className="st-note">
          {ps.used_this_week} of {ps.weekly_cap} PageSpeed calls this week; speed can be measured
          again from {dayWord(ps.next_from)}.
        </p>
      )}

      {audit.findings.length > 0 && (
        <table className="rt st-table">
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">What was measured</th>
              <th scope="col">Measured</th>
              <th scope="col">Threshold</th>
              <th scope="col">€ at stake</th>
            </tr>
          </thead>
          <tbody>
            {audit.findings.map((f) => {
              const flag = SEVERITY[f.severity];
              return (
                <tr key={f.id}>
                  <td data-label="Severity">
                    <span className={`word ${flag.tone}`}>{flag.word}</span>
                  </td>
                  <th scope="row" data-label="What was measured">
                    {f.title.en}
                    <span className="st-sub">{f.detail.en}</span>
                  </th>
                  <td className="src" data-label="Measured">
                    {measuredValue(f)}
                    <span className="st-sub">
                      {BASIS[f.evidence.basis]}
                      {f.evidence.strategy ? ` · ${f.evidence.strategy}` : ""}
                    </span>
                  </td>
                  <td className="src" data-label="Threshold">
                    {f.threshold}
                  </td>
                  <td className="src" data-label="€ at stake">
                    {euroLine(f.euro)}
                    {f.euro.computed && (
                      <span className="st-sub">
                        {f.euro.formula}. {f.euro.window}. {f.euro.assumed.join(" ")}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <p className="cs-label st-gap">
        The path to buying ·{" "}
        {audit.path.clicks === null
          ? "not counted"
          : `${audit.path.clicks} click${audit.path.clicks === 1 ? "" : "s"} from home`}
      </p>
      <ol className="st-steps st-path">
        {audit.path.steps.map((s) => (
          <li key={`${s.clicks}-${s.label}`}>
            <span className="st-n">{s.clicks}</span> {s.label}
            {s.kind === "page" && s.url && <span className="src"> · {bare(s.url)}</span>}
          </li>
        ))}
      </ol>
      {audit.path.notes.map((n) => (
        <p key={n} className="st-note">
          {n}
        </p>
      ))}

      {measured.length > 0 && (
        <>
          <p className="cs-label st-gap">The pages Google loaded</p>
          <table className="rt st-table">
            <thead>
              <tr>
                <th scope="col">Page</th>
                <th scope="col">On a phone</th>
                <th scope="col">On a computer</th>
                <th scope="col">Weight</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {measured.map((p) => (
                <tr key={p.url}>
                  <th scope="row" data-label="Page">
                    {bare(p.url)}
                    <span className="st-sub">
                      {p.role} · {p.clicks} click{p.clicks === 1 ? "" : "s"} from home
                    </span>
                  </th>
                  <td className="src" data-label="On a phone">
                    {speedCell(p.mobile)}
                  </td>
                  <td className="src" data-label="On a computer">
                    {speedCell(p.desktop)}
                  </td>
                  <td className="src" data-label="Weight">
                    {p.mobile?.lab.page_bytes
                      ? `${(p.mobile.lab.page_bytes / 1_000_000).toFixed(1)} MB`
                      : "—"}
                  </td>
                  <td className="src" data-label="From">
                    {basisOf(p.mobile)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {audit.pages.some((p) => p.speed_error) && (
        <ul className="st-unread">
          {audit.pages
            .filter((p) => p.speed_error)
            .map((p) => (
              <li key={p.url}>
                {bare(p.url)} — {p.speed_error}
              </li>
            ))}
        </ul>
      )}

      {audit.refused.length > 0 && (
        <>
          <p className="cs-label st-gap">Seen and left alone</p>
          <ul className="st-unread">
            {audit.refused.slice(0, 8).map((r) => (
              <li key={r.url}>
                {r.reason === "external_booking" ? new URL(r.url).hostname : bare(r.url)} —{" "}
                {REFUSAL_WORDS[r.reason]}
              </li>
            ))}
          </ul>
        </>
      )}
      <ul className="st-unread">
        {audit.never.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </SheetCard>
  );
}
