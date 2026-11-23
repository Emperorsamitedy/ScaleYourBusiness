"use client";

// The measured site audit on /site — Phase 5 Session C (P5-13), in the
// sheet design system beside the before/after wording. Read-only: the
// findings with their thresholds and € line (or "not computed"), the path
// to buying in clicks, the pages with what Google measured on each at
// phone and computer widths and whether the numbers are real visitors'
// (field) or one test load (lab), and what the audit refused to open.
// "Run the audit" asks the server to read the site again; the screen says
// when no PageSpeed key is set (speed isn't measured) and when the week's calls run out.
//
// L-3c (TASKS-LANGUAGES.md): the sheet's own words are the "site.audit"
// catalogue; figures and dates in the reader's locale, money in the
// finding's own currency. A finding's title, detail, threshold, formula,
// window and assumptions, the path's step labels and notes, PageSpeed's
// note and a page's speed error come from the server already in the
// reader's language (L-4c, lib/site/localize.ts); a link's own text is the
// site's.
//
// 2026-11-23, the owner: pages a client "can't understand easily". Said
// plainly: each finding is a card, most costly first, titled from its own
// code and figures in the reader's words ("Your home page is slow on phones:
// 4.3 s to appear"), with why it matters, the money at stake where a figure
// exists, and the stored technical wording kept under "Details". The pages
// Google loaded and what the audit left alone fold under "Details" too, and
// the note on what isn't built (a fact about ScaleX, not the site) is gone.

import { useState } from "react";
import type { SiteAuditView } from "../../lib/site/audit/view";
import { NEVER_LINES } from "../../lib/site/audit/view";
import type { SiteFinding } from "../../lib/site/audit/findings";
import { Fold } from "../sheet/Fold";
import { SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import {
  basisOf,
  dayWord,
  euroLine,
  measuredValue,
  neverLine,
  pagePath,
  speedCell,
  weightText,
} from "./site-view";

/** A severity's plain priority: fix first, worth fixing, small (`audit.plain.prio.<prio>`). */
const PRIORITY: Record<SiteFinding["severity"], "first" | "worth" | "small"> = {
  critical: "first",
  high: "first",
  medium: "worth",
  low: "small",
};
const ORDER: Record<SiteFinding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Pure: findings most costly first: by priority, then the money at stake. */
export function rankFindings(findings: readonly SiteFinding[]): SiteFinding[] {
  const stake = (f: SiteFinding) => (f.euro.computed ? f.euro.high_minor : -1);
  return [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || stake(b) - stake(a));
}

export function SiteAuditSheet({
  initial,
  failure,
}: {
  initial: SiteAuditView | null;
  failure: { at: string; reason: string } | null;
}) {
  const { tr: t, locale } = useTr("site");
  const tr = (key: string, values?: Record<string, string | number>) => t(`audit.${key}`, values);
  const [audit, setAudit] = useState<SiteAuditView | null>(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    failure && (!initial || failure.at > initial.ran_at)
      ? tr("notice.lastFailed", { day: dayWord(failure.at, locale), reason: failure.reason })
      : null,
  );

  const run = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch("/api/site/audit", { method: "POST" });
      const j = (await res.json()) as { audit?: SiteAuditView; error?: string };
      if (j.audit) setAudit(j.audit);
      if (!res.ok || !j.audit) setNotice(j.error ?? tr("notice.didntRun"));
      else setNotice(tr("notice.measured"));
    } catch {
      setNotice(tr("notice.tryAgain"));
    } finally {
      setBusy(false);
    }
  };

  const runButton = (
    <button type="button" className="prop-btn st-small" disabled={busy} onClick={() => void run()}>
      {busy ? tr("run.busy") : audit ? tr("run.again") : tr("run.first")}
    </button>
  );

  if (!audit) {
    return (
      <SheetCard label={tr("notRun.label")} title={tr("notRun.title")} meta={runButton}>
        {notice && (
          <p className="st-note" aria-live="polite">
            {notice}
          </p>
        )}
        <ul className="st-evidence">
          {NEVER_LINES.map((l) => (
            <li key={l}>{neverLine(l, t)}</li>
          ))}
        </ul>
      </SheetCard>
    );
  }

  const ps = audit.pagespeed;
  const measured = audit.pages.filter((p) => p.mobile || p.desktop);
  return (
    <SheetCard
      label={tr("plain.ran", { day: dayWord(audit.ran_at, locale), count: audit.page_reads })}
      title={
        audit.findings.length === 0
          ? tr("plain.none")
          : tr("plain.some", { count: audit.findings.length })
      }
      meta={runButton}
      foot={
        <Fold>
          <p>{tr("footFix")}</p>
          <ul className="st-unread">
            {audit.never.map((l) => (
              <li key={l}>{neverLine(l, t)}</li>
            ))}
          </ul>
        </Fold>
      }
    >
      {notice && (
        <p className="st-note" aria-live="polite">
          {notice}
        </p>
      )}
      {ps.note && <p className="st-note">{ps.note}</p>}
      {ps.next_from && (
        <p className="st-note">{tr("plain.again", { day: dayWord(ps.next_from, locale) })}</p>
      )}

      {audit.findings.length > 0 && (
        <ol className="st-fixes">
          {rankFindings(audit.findings).map((f) => {
            const prio = PRIORITY[f.severity];
            const path = pagePath(f.page_url, t);
            const page = path === t("homePage") ? tr("plain.home") : tr("plain.page", { path });
            const title = tr(`plain.title.${f.code}`, {
              page,
              value: measuredValue(f, t, locale),
              device:
                f.evidence.strategy === "desktop" ? tr("plain.onComputer") : tr("plain.onPhone"),
            });
            return (
              <li key={f.id} className="st-fix">
                <span className={`st-prio ${prio}`}>{tr(`plain.prio.${prio}`)}</span>
                <div className="st-fix-body">
                  <h3>{title.charAt(0).toUpperCase() + title.slice(1)}</h3>
                  <p>{tr(`plain.why.${f.code}`)}</p>
                  {f.euro.computed && (
                    <p className="st-cost">
                      <b>{tr("plain.cost", { range: euroLine(f.euro, t, locale) })}</b>
                    </p>
                  )}
                  <Fold summary={tr("plain.details")} className="st-fix-more">
                    <p>
                      {f.title.en}. {f.detail.en}
                    </p>
                    <p className="src">
                      {measuredValue(f, t, locale)} · {tr(`basis.${f.evidence.basis}`)}
                      {f.evidence.strategy ? ` · ${tr(`strategy.${f.evidence.strategy}`)}` : ""}
                      {" · "}
                      {f.threshold}
                    </p>
                    {f.euro.computed && (
                      <p className="src">
                        {f.euro.formula}.{" "}
                        {f.euro.window.charAt(0).toUpperCase() + f.euro.window.slice(1)}.{" "}
                        {f.euro.assumed.join(" ")}
                      </p>
                    )}
                  </Fold>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <p className="cs-label st-gap">
        {tr("path.label", {
          what:
            audit.path.clicks === null
              ? tr("path.notCounted")
              : tr("path.fromHome", { count: audit.path.clicks }),
        })}
      </p>
      <ol className="st-steps st-path">
        {audit.path.steps.map((s) => (
          <li key={`${s.clicks}-${s.label}`}>
            <span className="st-n">{s.clicks}</span> {s.label}
            {s.kind === "page" && s.url && <span className="src"> · {pagePath(s.url, t)}</span>}
          </li>
        ))}
      </ol>
      {audit.path.notes.map((n) => (
        <p key={n} className="st-note">
          {n}
        </p>
      ))}

      <Fold summary={tr("plain.pagesDetails")} className="st-fix-more">
        {measured.length > 0 && (
          <>
            <p className="cs-label st-gap">{tr("pages.label")}</p>
            <table className="rt st-table">
              <thead>
                <tr>
                  <th scope="col">{tr("pages.page")}</th>
                  <th scope="col">{tr("pages.phone")}</th>
                  <th scope="col">{tr("pages.computer")}</th>
                  <th scope="col">{tr("pages.weight")}</th>
                  <th scope="col">{tr("pages.from")}</th>
                </tr>
              </thead>
              <tbody>
                {measured.map((p) => (
                  <tr key={p.url}>
                    <th scope="row" data-label={tr("pages.page")}>
                      {pagePath(p.url, t)}
                      <span className="st-sub">
                        {tr("pages.role", { role: tr(`role.${p.role}`), count: p.clicks })}
                      </span>
                    </th>
                    <td className="src" data-label={tr("pages.phone")}>
                      {speedCell(p.mobile, t, locale)}
                    </td>
                    <td className="src" data-label={tr("pages.computer")}>
                      {speedCell(p.desktop, t, locale)}
                    </td>
                    <td className="src" data-label={tr("pages.weight")}>
                      {weightText(p.mobile?.lab.page_bytes, t, locale)}
                    </td>
                    <td className="src" data-label={tr("pages.from")}>
                      {basisOf(p.mobile, t)}
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
                  {pagePath(p.url, t)}: {p.speed_error}
                </li>
              ))}
          </ul>
        )}

        {audit.refused.length > 0 && (
          <>
            <p className="cs-label st-gap">{tr("refused.label")}</p>
            <ul className="st-unread">
              {audit.refused.slice(0, 8).map((r) => (
                <li key={r.url}>
                  {r.reason === "external_booking" ? new URL(r.url).hostname : pagePath(r.url, t)}:{" "}
                  {tr(`refused.${r.reason}`)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Fold>
    </SheetCard>
  );
}
