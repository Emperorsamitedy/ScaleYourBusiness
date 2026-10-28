"use client";

// Website changes — Phase 3 Session F, in the owner's instrument design
// (2026-10-17). One tab per proposed change, then the last site audit,
// then the form that proposes a new one. A change's sheet shows the REAL
// page rendered now and as proposed (sandboxed, scripts off), the exact
// text swap, the evidence its proposal carries, the expected effect in
// words, and whether it reverses. Approval happens in the queue like
// every proposal; this screen proposes, shows, applies and undoes.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import "../../app/site.css";
import type { SiteAuditView } from "../../lib/site/audit/view";
import { EmergencyStop } from "../execution/EmergencyStop";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { SiteAuditSheet } from "./SiteAuditSheet";

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

const STATUS_WORD: Record<ProposalStatus, { word: string; tone: string }> = {
  pending: { word: "waiting for you", tone: "live" },
  approved: { word: "approved", tone: "ok" },
  rejected: { word: "declined", tone: "low" },
  expired: { word: "expired", tone: "low" },
  executed: { word: "applied", tone: "ok" },
  blocked: { word: "blocked by a limit", tone: "alarm" },
  changes_requested: { word: "changes requested", tone: "drift" },
};

const REVERSE_WORD: Record<"easy" | "moderate" | "hard", string> = {
  easy: "reversible",
  moderate: "reversible with effort",
  hard: "hard to reverse",
};

function shortId(id: string): string {
  return `W-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

function dayWord(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "shop.example/products/mug" — the address as a reader would say it. */
function bareUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}

function tabName(p: SiteProposal): string {
  try {
    const path = new URL(p.action.detail.url).pathname;
    return path === "/" ? "home page" : path.replace(/\/$/, "");
  } catch {
    return "page";
  }
}

function headline(proposals: SiteProposal[]): string {
  const pending = proposals.filter((p) => p.status === "pending").length;
  const ready = proposals.filter(
    (p) => p.status === "approved" && !p.action.detail.manual_instructions && !p.execution,
  ).length;
  if (pending > 0) {
    return `${pending} ${pending === 1 ? "change" : "changes"} proposed for your site.`;
  }
  if (ready > 0)
    return `${ready} approved ${ready === 1 ? "change is" : "changes are"} ready to apply.`;
  if (proposals.length > 0) return "No site change is waiting on you.";
  return "No site changes proposed yet.";
}

export function SiteScreen({
  audit,
  measured = { audit: null, failure: null },
}: {
  audit: SiteAudit | null;
  measured?: MeasuredAudit;
}) {
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
        <PageHead kicker="Grow · Website" title="Reading your site changes…" />
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">SYB</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">your site</span>
            <h1 className="auth-title">Start with the intake.</h1>
            <p className="auth-copy">Site changes belong to a profile — begin and come back.</p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/intake">
              Begin
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
      setState({ ...s, busy: false, notice: j.error ?? "that didn't work" });
      return;
    }
    await load();
    setState((cur) =>
      cur.phase === "ready"
        ? {
            ...cur,
            tab: j.proposal_id ? { kind: "change", id: j.proposal_id } : cur.tab,
            notice: j.rolled_back
              ? "Applied — and the health check failed, so I rolled it straight back. The reasons are on the card."
              : done,
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
      label: `${shortId(p.id)} · ${tabName(p)}`,
      tab: { kind: "change", id: p.id } as Tab,
    })),
    {
      key: "measured",
      label: measured.audit
        ? `Measured · ${measured.audit.findings.length} ${measured.audit.findings.length === 1 ? "finding" : "findings"}`
        : "Measure the site",
      tab: { kind: "measured" } as Tab,
    },
    ...(audit
      ? [
          {
            key: "audit",
            label: `Audit · ${audit.notes.length} ${audit.notes.length === 1 ? "note" : "notes"}, no action`,
            tab: { kind: "audit" } as Tab,
          },
        ]
      : []),
    { key: "propose", label: "Propose a change", tab: { kind: "propose" } as Tab },
  ];
  const isOn = (t: Tab) =>
    t.kind === tab.kind && (t.kind !== "change" || (tab.kind === "change" && t.id === tab.id));

  return (
    <main className="screen st-screen">
      <PageHead kicker="Grow · Website" title={headline(s.proposals)}>
        {audit
          ? `Last site check ${dayWord(audit.checked_at)} · ${audit.pages.length} ${audit.pages.length === 1 ? "page" : "pages"} read · ${missing} of ${audit.notes.length} checks not shown`
          : "No site check on record yet"}
        {measured.audit
          ? ` · measured ${dayWord(measured.audit.ran_at)}: ${measured.audit.findings.length} ${measured.audit.findings.length === 1 ? "finding" : "findings"}`
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

      <div className="st-tabs" role="tablist" aria-label="Site changes">
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
        {current && <ChangeSheet p={current} s={s} setState={setState} post={post} />}

        {tab.kind === "measured" && (
          <SiteAuditSheet initial={measured.audit} failure={measured.failure} />
        )}

        {tab.kind === "audit" && audit && (
          <SheetCard
            label={`Audit · checked ${dayWord(audit.checked_at)}`}
            title="What customers look for, and whether your site shows it"
            meta={<span className="word boxed low">no action</span>}
            foot={
              <>
                Read-only. Fixing one goes through the approval queue —{" "}
                <Link href="/blindspots">see Blindspots</Link>.
              </>
            }
          >
            <table className="rt st-table">
              <thead>
                <tr>
                  <th scope="col">What they check</th>
                  <th scope="col">On your site</th>
                  <th scope="col">Found on</th>
                </tr>
              </thead>
              <tbody>
                {audit.notes.map((n) => (
                  <tr key={n.code}>
                    <th scope="row" data-label="Check">
                      {n.label}
                    </th>
                    <td data-label="On your site">
                      <span className={`word ${n.found_on ? "ok" : "drift"}`}>
                        {n.found_on ? "shown" : "not found"}
                      </span>
                    </td>
                    <td className="src" data-label="Found on">
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
                    Couldn&rsquo;t read {bareUrl(u.url)} — {u.reason}
                  </li>
                ))}
              </ul>
            )}
          </SheetCard>
        )}

        {tab.kind === "propose" && (
          <SheetCard
            label="Propose a change"
            title="Shown before it is ever applied"
            foot="Checkout, cart, payment and billing pages are refused outright — they cannot even be proposed, at any approval level."
          >
            <form
              className="st-form"
              onSubmit={(e) => {
                e.preventDefault();
                void post(
                  { url: s.url, find: s.find, replace: s.replace },
                  "Proposed — the before/after is on its tab, and the decision is in your queue.",
                );
              }}
            >
              <label className="cs-label" htmlFor="st-url">
                Page address
              </label>
              <input
                id="st-url"
                className="st-input"
                placeholder="yoursite.com/about"
                value={s.url}
                onChange={(e) => setState({ ...s, url: e.target.value })}
              />
              <label className="cs-label" htmlFor="st-find">
                The exact text to change
              </label>
              <input
                id="st-find"
                className="st-input"
                value={s.find}
                onChange={(e) => setState({ ...s, find: e.target.value })}
              />
              <label className="cs-label" htmlFor="st-replace">
                What it should say instead
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
                    "Reading the page…"
                  ) : (
                    <>
                      Preview the change <span aria-hidden="true">→</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </SheetCard>
        )}
      </div>

      <p className="st-fine">
        Every change previews from the real page, applies only after your yes in the queue, keeps
        its undo forever, and rolls itself back on a hard failure — never on a quiet week.
      </p>
    </main>
  );
}

type Ready = Extract<State, { phase: "ready" }>;

function ChangeSheet({
  p,
  s,
  setState,
  post,
}: {
  p: SiteProposal;
  s: Ready;
  setState: (next: State) => void;
  post: (payload: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const d = p.action.detail;
  const flag = STATUS_WORD[p.status];
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
              ? `from finding: ${p.originating_finding}`
              : `proposed ${dayWord(p.created_at)}`}{" "}
            · {d.platform.platform}
          </p>
          <h2 className="cs-title" id={`st-title-${p.id}`}>
            {p.action.summary}
          </h2>
        </div>
        <div className="cs-meta st-flags">
          <span className={`word boxed ${flag.tone}`}>{flag.word}</span>
          {p.execution?.status === "undone" && (
            <span className="word boxed low">
              {p.execution.undone_by ? "undone by you" : "auto-rolled-back"}
            </span>
          )}
        </div>
      </header>

      {d.site_preview ? (
        <>
          <div className="st-preview-bar">
            <span className="cs-label">The real page, scripts off</span>
            <button
              type="button"
              className="prop-btn st-small"
              aria-pressed={s.phone}
              onClick={() => setState({ ...s, phone: !s.phone })}
            >
              {s.phone ? "Desktop width" : "Phone width"}
            </button>
          </div>
          <div className="st-frames">
            {(["before_html", "after_html"] as const).map((side) => (
              <div key={side} className="st-frame-col">
                <p className="st-frame-head">
                  <span className="st-frame-word">
                    {side === "before_html" ? "Now" : "Proposed"}
                  </span>
                  <span className="st-frame-url">{bareUrl(d.url)}</span>
                </p>
                <div className={`st-frame-clip${s.phone ? " phone" : ""}`}>
                  <iframe
                    className={`st-frame${s.phone ? " phone" : ""}`}
                    sandbox=""
                    title={side === "before_html" ? "The page now" : "The page as proposed"}
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
              <th scope="col">Now says</th>
              <th scope="col">Will say</th>
              <th scope="col">Basis</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="#" className="st-n">
                1
              </td>
              <td data-label="Now says" className="st-quote">
                “{d.find}”
              </td>
              <td data-label="Will say" className="st-quote">
                <span className="marked">“{d.replace}”</span>
              </td>
              <td data-label="Basis" className="src">
                found once on the live page · observed
              </td>
            </tr>
          </tbody>
        </table>
        {evidence.length > 0 && (
          <>
            <p className="cs-label st-gap">Evidence the proposal carries</p>
            <ul className="st-evidence">
              {evidence.map((a) => (
                <li key={a.statement}>
                  {a.statement}
                  {a.sensitivity && <span className="src"> · sensitivity {a.sensitivity}</span>}
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
        {p.blocked_by_limit && <p className="st-note">Blocked: {p.blocked_by_limit}</p>}
        {(d.manual_limits ?? []).map((q) => (
          <p key={q} className="st-note">
            Your limit: “{q}”
          </p>
        ))}
        {d.manual_instructions && (
          <>
            <p className="cs-label st-gap">How to make this change yourself</p>
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
          <p className="cs-label">Expected · in words, not a number</p>
          <p className="st-expect-line">
            {p.scenario?.base_case?.statement ?? "The page says the new thing."}
          </p>
          {p.scenario?.downside_case?.statement && (
            <p className="st-expect-sub">If it goes wrong: {p.scenario.downside_case.statement}</p>
          )}
        </div>
        {p.reversibility && (
          <p className="st-rev">
            <span className={`word boxed ${p.reversibility.level === "hard" ? "alarm" : ""}`}>
              {REVERSE_WORD[p.reversibility.level]}
            </span>
            <span>{p.reversibility.if_you_change_your_mind}</span>
          </p>
        )}
      </div>

      {(p.status === "pending" || canApply || canUndo) && (
        <footer className="st-actions">
          {p.status === "pending" && (
            <Link className="prop-btn st-wide" href="/proposals">
              Decide in the queue <span aria-hidden="true">→</span>
            </Link>
          )}
          {canApply && (
            <button
              type="button"
              className="next st-wide"
              disabled={s.busy}
              onClick={() =>
                void post(
                  { action: "apply", proposal_id: p.id },
                  "Applied, and the page passed its health check.",
                )
              }
            >
              Apply it to the page <span aria-hidden="true">→</span>
            </button>
          )}
          {canUndo && (
            <button
              type="button"
              className="prop-btn st-wide"
              disabled={s.busy}
              onClick={() =>
                void post(
                  { action: "undo", execution_id: p.execution?.id },
                  "Undone — the page's previous state is back, byte for byte.",
                )
              }
            >
              Undo — restore the page
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
