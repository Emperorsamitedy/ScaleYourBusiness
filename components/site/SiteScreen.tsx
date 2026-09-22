"use client";

// Website changes — Phase 3 Session F. The visual approval card the
// spec promised: the REAL page rendered before and after, live in the
// owner's own browser at desktop and phone widths (scripts off), with
// the platform named from evidence, the two rule-18 walls upstream,
// and — for Wix/Squarespace — the honest instructions instead of a
// progress bar over a lie. Approval happens in the queue like every
// proposal; this screen proposes, shows, applies and undoes.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface SiteDetail {
  url: string;
  find: string;
  replace: string;
  platform: { platform: string; editable: string; marker: string };
  platform_line: string;
  site_preview: { before_html: string; after_html: string } | null;
  preview_note: string | null;
  manual_instructions: string[] | null;
}

interface SiteProposal {
  id: string;
  status: string;
  created_at: string;
  action: { summary: string; detail: SiteDetail };
  execution: { id: string; status: string; undone_by: string | null } | null;
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
    };

export function SiteScreen() {
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
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading your site changes…</p>
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">your site</span>
            <h1 className="auth-title">Start with the intake.</h1>
            <p className="auth-copy">Site changes belong to a profile — begin and come back.</p>
            <Link className="next auth-cta" style={{ marginTop: 22 }} href="/intake">
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
    const j = (await res.json()) as { error?: string; rolled_back?: boolean };
    if (!res.ok) {
      setState({ ...s, busy: false, notice: j.error ?? "that didn't work" });
      return;
    }
    await load();
    setState((cur) =>
      cur.phase === "ready"
        ? {
            ...cur,
            notice: j.rolled_back
              ? "Applied — and the health check failed, so I rolled it straight back. The reasons are on the card."
              : done,
          }
        : cur,
    );
  };

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">your site · preview first · checkout untouchable</span>
      </header>

      {s.notice && (
        <section className="card ops-card">
          <p className="auth-copy" aria-live="polite">
            {s.notice}
          </p>
        </section>
      )}

      <section className="card ops-card">
        <span className="auth-eyebrow">propose a change — shown before it is ever applied</span>
        <form
          className="st-form"
          onSubmit={(e) => {
            e.preventDefault();
            void post(
              { url: s.url, find: s.find, replace: s.replace },
              "Proposed — the before/after is below, and the decision is in your queue.",
            );
          }}
        >
          <input
            className="ct-input"
            placeholder="Page address, e.g. yoursite.com/about"
            value={s.url}
            onChange={(e) => setState({ ...s, url: e.target.value })}
          />
          <input
            className="ct-input"
            placeholder="The exact text to change"
            value={s.find}
            onChange={(e) => setState({ ...s, find: e.target.value })}
          />
          <input
            className="ct-input"
            placeholder="What it should say instead"
            value={s.replace}
            onChange={(e) => setState({ ...s, replace: e.target.value })}
          />
          <button
            className="prop-btn"
            disabled={s.busy || !s.url.trim() || !s.find.trim() || !s.replace.trim()}
          >
            {s.busy ? "Reading the page…" : "Preview the change"}
          </button>
        </form>
        <p className="conn-note">
          Checkout, cart, payment and billing pages are refused outright — they cannot even be
          proposed, at any approval level.
        </p>
      </section>

      {s.proposals.map((p) => {
        const d = p.action.detail;
        return (
          <section key={p.id} className="card ops-card">
            <div className="prop-head">
              <span className={`prop-tag ${p.status}`}>{p.status}</span>
              {p.execution && p.execution.status === "undone" && (
                <span className="prop-tag">
                  {p.execution.undone_by ? "undone by you" : "auto-rolled-back"}
                </span>
              )}
              <span className="conn-note" style={{ margin: 0 }}>
                {d.platform.platform} · {d.platform.editable}
              </span>
            </div>
            <h2 className="prop-title small" style={{ marginTop: 10 }}>
              {p.action.summary}
            </h2>
            <p className="conn-note">{d.platform_line}</p>

            {d.site_preview && (
              <>
                <div className="st-preview-bar">
                  <span className="auth-eyebrow">before / after — the real page, scripts off</span>
                  <button
                    className="prop-btn quiet"
                    onClick={() => setState({ ...s, phone: !s.phone })}
                  >
                    {s.phone ? "Desktop width" : "Phone width"}
                  </button>
                </div>
                <div className="st-frames">
                  {(["before_html", "after_html"] as const).map((side) => (
                    <div key={side} className="st-frame-col">
                      <span className="tr-label">
                        {side === "before_html" ? "before" : "after"}
                      </span>
                      <div className={`st-frame-clip${s.phone ? " phone" : ""}`}>
                        <iframe
                          className={`st-frame${s.phone ? " phone" : ""}`}
                          sandbox=""
                          title={side}
                          srcDoc={d.site_preview?.[side]}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {d.preview_note && <p className="conn-note">{d.preview_note}</p>}

            {d.manual_instructions && (
              <>
                <span className="auth-eyebrow" style={{ marginTop: 14 }}>
                  how to make this change yourself
                </span>
                <ol className="st-steps">
                  {d.manual_instructions.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
              </>
            )}

            <div className="prop-actions">
              {p.status === "pending" && (
                <Link className="prop-btn signal" href="/proposals">
                  Decide in the queue
                </Link>
              )}
              {p.status === "approved" && !d.manual_instructions && (
                <button
                  className="prop-btn signal"
                  disabled={s.busy}
                  onClick={() =>
                    void post(
                      { action: "apply", proposal_id: p.id },
                      "Applied, and the page passed its health check.",
                    )
                  }
                >
                  Apply it
                </button>
              )}
              {p.execution?.status === "succeeded" && (
                <button
                  className="prop-btn"
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
            </div>
          </section>
        );
      })}

      <p className="conn-note">
        Every change previews from the real page, applies only after your yes in the queue, keeps
        its undo forever, and rolls itself back on a hard failure — never on a quiet week.{" "}
        <Link href="/proposals">Proposals</Link> · <Link href="/history">The record</Link>
      </p>
    </main>
  );
}
