"use client";

// Website changes — Phase 3 Session F, in the owner's instrument design
// (2026-10-17). One tab per proposed change, then the last site audit,
// then the form that proposes a new one. A change's sheet shows the REAL
// page rendered now and as proposed (sandboxed, scripts off), the exact
// text swap, the evidence its proposal carries, the expected effect in
// words, and whether it reverses. Approval happens in the queue like
// every proposal; this screen proposes, shows, applies and undoes.
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "site"
// catalogue; dates and counts in the reader's locale. The page's text, the
// proposed wording, the platform line, the evidence, the expected effect
// and the manual steps are what the server built (L-4) or the business's
// own content (rule 4), shown as they are.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import "../../app/site.css";
import type { SiteAuditView } from "../../lib/site/audit/view";
import { EmergencyStop } from "../execution/EmergencyStop";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { SiteAuditSheet } from "./SiteAuditSheet";
import { bareUrl, dayWord } from "./site-view";

interface SiteDetail {
  url: string;
  find: string;
  replace: string;
  platform: { platform: string; editable: string; marker: string };
  platform_line: string;
  site_preview: { before_html: string; after_html: string } | null;
  preview_note: string | null;
  manual_instructions: string[] | null;
  manual_limits?: string[];
  rationale?: string;
}

interface Scenario {
  assumptions?: { statement: string; sensitivity?: string }[];
  base_case?: { statement: string };
  downside_case?: { statement: string };
}

type ProposalStatus =
  "pending" | "approved" | "rejected" | "expired" | "executed" | "blocked" | "changes_requested";

interface SiteProposal {
  id: string;
  status: ProposalStatus;
  created_at: string;
  originating_finding: string | null;
  blocked_by_limit: string | null;
  action: { summary: string; detail: SiteDetail };
  scenario: Scenario | null;
  reversibility: { level: "easy" | "moderate" | "hard"; if_you_change_your_mind: string } | null;
  execution: { id: string; status: string; undone_by: string | null } | null;
}

/** The last recorded site check, read on the server by app/site/page.tsx. */
export interface SiteAudit {
  checked_at: string;
  pages: string[];
  notes: { code: string; label: string; found_on: string | null }[];
  unreadable: { url: string; reason: string }[];
}

type Tab =
  { kind: "change"; id: string } | { kind: "measured" } | { kind: "audit" } | { kind: "propose" };

/** P5-13: the measured audit, read on the server by app/site/page.tsx. */
export interface MeasuredAudit {
  audit: SiteAuditView | null;
  failure: { at: string; reason: string } | null;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | {
      phase: "ready";
      proposals: SiteProposal[];
      url: string;
      find: string;
      replace: string;
      busy: boolean;
      notice: string | null;
      phone: boolean;
      tab: Tab | null;
    };

/** A proposal's status flag: its words are the catalogue's `status.<status>`. */
const STATUS_TONE: Record<ProposalStatus, string> = {
  pending: "live",
  approved: "ok",
  rejected: "low",
  expired: "low",
  executed: "ok",
  blocked: "alarm",
  changes_requested: "drift",
};

function shortId(id: string): string {
  return `W-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function tabName(p: SiteProposal, tr: Tr): string {
  try {
    const path = new URL(p.action.detail.url).pathname;
    return path === "/" ? tr("homePage") : path.replace(/\/$/, "");
  } catch {
    return tr("page");
  }
}

function headline(proposals: SiteProposal[], tr: Tr): string {
  const pending = proposals.filter((p) => p.status === "pending").length;
  const ready = proposals.filter(
    (p) => p.status === "approved" && !p.action.detail.manual_instructions && !p.execution,
  ).length;
  if (pending > 0) return tr("headline.pending", { count: pending });
  if (ready > 0) return tr("headline.ready", { count: ready });
  if (proposals.length > 0) return tr("headline.none");
  return tr("headline.empty");
}

export function SiteScreen({
  audit,
  measured = { audit: null, failure: null },
}: {
  audit: SiteAudit | null;
  measured?: MeasuredAudit;
}) {
  const { tr, locale } = useTr("site");
  const rich = useTranslations("site");
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const res = await fetch("/api/site");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json()) as { proposals: SiteProposal[] };
    setState((cur) => ({
      phase: "ready",
      proposals: j.proposals,
      url: cur.phase === "ready" ? cur.url : "",
      find: "",
      replace: "",
      busy: false,
      notice: cur.phase === "ready" ? cur.notice : null,
      phone: cur.phase === "ready" ? cur.phone : false,
      tab: cur.phase === "ready" ? cur.tab : null,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="screen st-screen">
        <PageHead kicker={tr("kicker")} title={tr("loading")} />
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">SYB</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">{tr("signedOut.eyebrow")}</span>
            <h1 className="auth-title">{tr("signedOut.title")}</h1>
            <p className="auth-copy">{tr("signedOut.copy")}</p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/intake">
              {tr("signedOut.begin")}
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const s = state;
  const post = async (payload: Record<string, unknown>, done: string) => {
    setState({ ...s, busy: true, notice: null });
    const res = await fetch("/api/site", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await res.json()) as {
      error?: string;
      rolled_back?: boolean;
      proposal_id?: string;
    };
    if (!res.ok) {
      setState({ ...s, busy: false, notice: j.error ?? tr("failed") });
      return;
    }
    await load();
    setState((cur) =>
      cur.phase === "ready"
        ? {
            ...cur,
            tab: j.proposal_id ? { kind: "change", id: j.proposal_id } : cur.tab,
            notice: j.rolled_back ? tr("notice.rolledBack") : done,
          }
        : cur,
    );
  };

  // Pending first, then the rest newest-first (the API's order).
  const ordered = [
    ...s.proposals.filter((p) => p.status === "pending"),
    ...s.proposals.filter((p) => p.status !== "pending"),
  ];
  const missing = audit ? audit.notes.filter((n) => n.found_on === null).length : 0;
  const tab: Tab =
    s.tab ?? (ordered[0] ? { kind: "change", id: ordered[0].id } : { kind: "measured" });
  const current = tab.kind === "change" ? (ordered.find((p) => p.id === tab.id) ?? null) : null;

  const tabs: { key: string; label: string; tab: Tab }[] = [
    ...ordered.map((p) => ({
      key: p.id,
      label: `${shortId(p.id)} · ${tabName(p, tr)}`,
      tab: { kind: "change", id: p.id } as Tab,
    })),
    {
      key: "measured",
      label: measured.audit
        ? tr("tabs.measured", { count: measured.audit.findings.length })
        : tr("tabs.measure"),
      tab: { kind: "measured" } as Tab,
    },
    ...(audit
      ? [
          {
            key: "audit",
            label: tr("tabs.audit", { count: audit.notes.length }),
            tab: { kind: "audit" } as Tab,
          },
        ]
      : []),
    { key: "propose", label: tr("tabs.propose"), tab: { kind: "propose" } as Tab },
  ];
  const isOn = (t: Tab) =>
    t.kind === tab.kind && (t.kind !== "change" || (tab.kind === "change" && t.id === tab.id));

  return (
    <main className="screen st-screen">
      <PageHead kicker={tr("kicker")} title={headline(s.proposals, tr)}>
        {audit
          ? tr("head.checked", {
              day: dayWord(audit.checked_at, locale),
              pages: audit.pages.length,
              missing,
              total: audit.notes.length,
            })
          : tr("head.noCheck")}
        {measured.audit
          ? ` · ${tr("head.measured", {
              day: dayWord(measured.audit.ran_at, locale),
              count: measured.audit.findings.length,
            })}`
          : ""}
      </PageHead>

      <div className="st-stop">
        <EmergencyStop />
      </div>

      {s.notice && (
        <p className="st-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      <div className="st-tabs" role="tablist" aria-label={tr("tabs.aria")}>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`st-tab-${t.key}`}
            aria-selected={isOn(t.tab)}
            aria-controls="st-panel"
            className={`st-tab${isOn(t.tab) ? " on" : ""}`}
            onClick={() => setState({ ...s, tab: t.tab })}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="st-panel" role="tabpanel">
        {current && (
          <ChangeSheet p={current} s={s} setState={setState} post={post} tr={tr} locale={locale} />
        )}

        {tab.kind === "measured" && (
          <SiteAuditSheet initial={measured.audit} failure={measured.failure} />
        )}

        {tab.kind === "audit" && audit && (
          <SheetCard
            label={tr("auditTab.label", { day: dayWord(audit.checked_at, locale) })}
            title={tr("auditTab.title")}
            meta={<span className="word boxed low">{tr("noAction")}</span>}
            foot={
              <>
                {rich.rich("auditTab.foot", {
                  link: (chunks) => <Link href="/blindspots">{chunks}</Link>,
                })}
              </>
            }
          >
            <table className="rt st-table">
              <thead>
                <tr>
                  <th scope="col">{tr("auditTab.what")}</th>
                  <th scope="col">{tr("auditTab.onSite")}</th>
                  <th scope="col">{tr("auditTab.foundOn")}</th>
                </tr>
              </thead>
              <tbody>
                {audit.notes.map((n) => (
                  <tr key={n.code}>
                    <th scope="row" data-label={tr("auditTab.check")}>
                      {n.label}
                    </th>
                    <td data-label={tr("auditTab.onSite")}>
                      <span className={`word ${n.found_on ? "ok" : "drift"}`}>
                        {n.found_on ? tr("auditTab.shown") : tr("auditTab.notFound")}
                      </span>
                    </td>
                    <td className="src" data-label={tr("auditTab.foundOn")}>
                      {n.found_on ? bareUrl(n.found_on) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {audit.unreadable.length > 0 && (
              <ul className="st-unread">
                {audit.unreadable.map((u) => (
                  <li key={u.url}>
                    {tr("auditTab.unreadable", { url: bareUrl(u.url), reason: u.reason })}
                  </li>
                ))}
              </ul>
            )}
          </SheetCard>
        )}

        {tab.kind === "propose" && (
          <SheetCard
            label={tr("propose.label")}
            title={tr("propose.title")}
            foot={tr("propose.foot")}
          >
            <form
              className="st-form"
              onSubmit={(e) => {
                e.preventDefault();
                void post({ url: s.url, find: s.find, replace: s.replace }, tr("notice.proposed"));
              }}
            >
              <label className="cs-label" htmlFor="st-url">
                {tr("propose.url")}
              </label>
              <input
                id="st-url"
                className="st-input"
                placeholder={tr("propose.urlPlaceholder")}
                value={s.url}
                onChange={(e) => setState({ ...s, url: e.target.value })}
              />
              <label className="cs-label" htmlFor="st-find">
                {tr("propose.find")}
              </label>
              <input
                id="st-find"
                className="st-input"
                value={s.find}
                onChange={(e) => setState({ ...s, find: e.target.value })}
              />
              <label className="cs-label" htmlFor="st-replace">
                {tr("propose.replace")}
              </label>
              <input
                id="st-replace"
                className="st-input"
                value={s.replace}
                onChange={(e) => setState({ ...s, replace: e.target.value })}
              />
              <div>
                <button
                  className="next"
                  disabled={s.busy || !s.url.trim() || !s.find.trim() || !s.replace.trim()}
                >
                  {s.busy ? (
                    tr("propose.reading")
                  ) : (
                    <>
                      {tr("propose.preview")} <span aria-hidden="true">→</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </SheetCard>
        )}
      </div>

      <p className="st-fine">{tr("fine")}</p>
    </main>
  );
}

type Ready = Extract<State, { phase: "ready" }>;

function ChangeSheet({
  p,
  s,
  setState,
  post,
  tr,
  locale,
}: {
  p: SiteProposal;
  s: Ready;
  setState: (next: State) => void;
  post: (payload: Record<string, unknown>, done: string) => Promise<void>;
  tr: Tr;
  locale: AppLocale;
}) {
  const d = p.action.detail;
  const tone = STATUS_TONE[p.status];
  const evidence = p.scenario?.assumptions ?? [];
  const canApply = p.status === "approved" && !d.manual_instructions && !p.execution;
  const canUndo = p.execution?.status === "succeeded";
  return (
    <section className="cs st-sheet" aria-labelledby={`st-title-${p.id}`}>
      <header className="cs-head">
        <div>
          <p className="cs-label">
            {shortId(p.id)} ·{" "}
            {p.originating_finding
              ? tr("change.fromFinding", { finding: p.originating_finding })
              : tr("change.proposedOn", { day: dayWord(p.created_at, locale) })}{" "}
            · {d.platform.platform}
          </p>
          <h2 className="cs-title" id={`st-title-${p.id}`}>
            {p.action.summary}
          </h2>
        </div>
        <div className="cs-meta st-flags">
          <span className={`word boxed ${tone}`}>{tr(`status.${p.status}`)}</span>
          {p.execution?.status === "undone" && (
            <span className="word boxed low">
              {p.execution.undone_by ? tr("change.undoneByYou") : tr("change.autoRolledBack")}
            </span>
          )}
        </div>
      </header>

      {d.site_preview ? (
        <>
          <div className="st-preview-bar">
            <span className="cs-label">{tr("change.realPage")}</span>
            <button
              type="button"
              className="prop-btn st-small"
              aria-pressed={s.phone}
              onClick={() => setState({ ...s, phone: !s.phone })}
            >
              {s.phone ? tr("change.desktopWidth") : tr("change.phoneWidth")}
            </button>
          </div>
          <div className="st-frames">
            {(["before_html", "after_html"] as const).map((side) => (
              <div key={side} className="st-frame-col">
                <p className="st-frame-head">
                  <span className="st-frame-word">
                    {side === "before_html" ? tr("change.now") : tr("change.proposed")}
                  </span>
                  <span className="st-frame-url">{bareUrl(d.url)}</span>
                </p>
                <div className={`st-frame-clip${s.phone ? " phone" : ""}`}>
                  <iframe
                    className={`st-frame${s.phone ? " phone" : ""}`}
                    sandbox=""
                    title={
                      side === "before_html" ? tr("change.frameNow") : tr("change.frameProposed")
                    }
                    srcDoc={d.site_preview?.[side]}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        d.preview_note && <p className="st-note">{d.preview_note}</p>
      )}

      <div className="st-changes">
        <table className="rt st-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{tr("change.nowSays")}</th>
              <th scope="col">{tr("change.willSay")}</th>
              <th scope="col">{tr("change.basis")}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="#" className="st-n">
                1
              </td>
              <td data-label={tr("change.nowSays")} className="st-quote">
                {tr("change.quoted", { text: d.find })}
              </td>
              <td data-label={tr("change.willSay")} className="st-quote">
                <span className="marked">{tr("change.quoted", { text: d.replace })}</span>
              </td>
              <td data-label={tr("change.basis")} className="src">
                {tr("change.basisValue")}
              </td>
            </tr>
          </tbody>
        </table>
        {evidence.length > 0 && (
          <>
            <p className="cs-label st-gap">{tr("change.evidence")}</p>
            <ul className="st-evidence">
              {evidence.map((a) => (
                <li key={a.statement}>
                  {a.statement}
                  {a.sensitivity && (
                    <span className="src">
                      {" "}
                      · {tr("change.sensitivity", { value: a.sensitivity })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="st-platform">
        <p className="st-note">
          {d.platform.platform} · {d.platform.editable} — {d.platform_line}
        </p>
        {p.blocked_by_limit && (
          <p className="st-note">{tr("change.blocked", { why: p.blocked_by_limit })}</p>
        )}
        {(d.manual_limits ?? []).map((q) => (
          <p key={q} className="st-note">
            {tr("change.yourLimit", { limit: q })}
          </p>
        ))}
        {d.manual_instructions && (
          <>
            <p className="cs-label st-gap">{tr("change.manual")}</p>
            <ol className="st-steps">
              {d.manual_instructions.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </>
        )}
      </div>

      <div className="st-expect">
        <div>
          <p className="cs-label">{tr("change.expected")}</p>
          <p className="st-expect-line">
            {p.scenario?.base_case?.statement ?? tr("change.expectedDefault")}
          </p>
          {p.scenario?.downside_case?.statement && (
            <p className="st-expect-sub">
              {tr("change.ifWrong", { what: p.scenario.downside_case.statement })}
            </p>
          )}
        </div>
        {p.reversibility && (
          <p className="st-rev">
            <span className={`word boxed ${p.reversibility.level === "hard" ? "alarm" : ""}`}>
              {tr(`reverse.${p.reversibility.level}`)}
            </span>
            <span>{p.reversibility.if_you_change_your_mind}</span>
          </p>
        )}
      </div>

      {(p.status === "pending" || canApply || canUndo) && (
        <footer className="st-actions">
          {p.status === "pending" && (
            <Link className="prop-btn st-wide" href="/proposals">
              {tr("change.decide")} <span aria-hidden="true">→</span>
            </Link>
          )}
          {canApply && (
            <button
              type="button"
              className="next st-wide"
              disabled={s.busy}
              onClick={() =>
                void post({ action: "apply", proposal_id: p.id }, tr("notice.applied"))
              }
            >
              {tr("change.apply")} <span aria-hidden="true">→</span>
            </button>
          )}
          {canUndo && (
            <button
              type="button"
              className="prop-btn st-wide"
              disabled={s.busy}
              onClick={() =>
                void post({ action: "undo", execution_id: p.execution?.id }, tr("notice.undone"))
              }
            >
              {tr("change.undo")}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
