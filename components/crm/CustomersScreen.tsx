"use client";

// The customers screen — Phase 4 Sessions A and E. The contact list the
// owner imported under their own attestation; lifecycle counts and the
// four segments with their arithmetic written out; one button that puts
// a win-back and a thank-you in the approval queue; and erasure, one
// click, irreversible, with the suppression that survives it. Nothing
// here sends anything.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Contact {
  id: string;
  name: string | null;
  email: string | null;
  consent_status: "explicit_consent" | "implied_consent" | "no_consent" | "unsure";
  lifecycle: "new" | "active" | "lapsing" | "lapsed" | "unknown";
  last_purchase_at: string | null;
  orders_count: number | null;
  total_spent_minor: number | null;
  spent_currency: string | null;
}

interface SegmentView {
  key: "lapsed" | "lapsing" | "new" | "vip";
  label: string;
  size: number;
  emailable: number;
  excluded: { no_email: number; no_consent: number; suppressed: number };
  evidence: string[];
}

interface CampaignView {
  proposal_id: string;
  summary: string;
  label: string | null;
  approved_at: string | null;
  draft: { id: string; title: string; body: string } | null;
  /** What the law where the business is still wants from the draft. */
  gaps: string[];
  /** Added per recipient at send time, never in the draft. */
  at_send: string[];
  /** The bank questions that close the gaps. */
  ask: { question_id: string; label: string }[];
}

interface Payload {
  posture: "enabled" | "caution" | "disabled" | "unknown";
  contacts: Contact[];
  lifecycle: Record<Contact["lifecycle"], number>;
  segments: SegmentView[];
  /** P4-16: absent from an older API. */
  campaigns?: CampaignView[];
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | (Payload & {
      phase: "ready";
      busy: boolean;
      notice: string | null;
      csv: string;
      status: Contact["consent_status"];
      statement: string;
      currency: string;
      showEvidence: string | null;
    });

const CONSENT_WORD: Record<Contact["consent_status"], string> = {
  explicit_consent: "explicit consent",
  implied_consent: "implied",
  no_consent: "no consent",
  unsure: "unsure",
};

const POSTURE_WORD: Record<Payload["posture"], string> = {
  enabled: "you said customers gave explicit consent — outbound is possible, per contact",
  caution:
    "your consent answer was implied or unsure — only contacts with explicit consent can be emailed",
  disabled: "you said customers gave no consent — outbound email is off",
  unknown: "you haven't answered the consent question (6.4b) — treated as caution",
};

function money(minor: number | null, currency: string | null): string {
  if (minor === null || currency === null) return "—";
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

export function CustomersScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const res = await fetch("/api/crm");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json()) as Payload;
    setState((cur) => ({
      phase: "ready",
      ...j,
      busy: false,
      notice: null,
      csv: "",
      status: cur.phase === "ready" ? cur.status : "explicit_consent",
      statement: cur.phase === "ready" ? cur.statement : "",
      currency: cur.phase === "ready" ? cur.currency : "EUR",
      showEvidence: null,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Opening customers…</p>
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">customers</span>
            <h1 className="auth-title">Start with the intake.</h1>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/intake">
              Begin
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const s = state;
  const act = async (
    payload: Record<string, unknown>,
    done: (j: Record<string, unknown>) => string,
  ) => {
    setState({ ...s, busy: true, notice: null });
    const res = await fetch("/api/crm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await res.json()) as { error?: string } & Record<string, unknown>;
    if (!res.ok) {
      setState({ ...s, busy: false, notice: j.error ?? "that didn't work" });
      return;
    }
    await load();
    setState((cur) => (cur.phase === "ready" ? { ...cur, notice: done(j) } : cur));
  };

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          customers · {s.contacts.length} contacts · {s.lifecycle.lapsed} lapsed ·{" "}
          {s.lifecycle.active} active
        </span>
      </header>

      {s.notice && (
        <section className="card ops-card">
          <p className="auth-copy" aria-live="polite">
            {s.notice}
          </p>
        </section>
      )}

      <section className="card ops-card">
        <span className="auth-eyebrow">segments — arithmetic, with the working shown</span>
        <p className="conn-note">{POSTURE_WORD[s.posture]}</p>
        {s.segments.map((seg) => (
          <article key={seg.key} className="ct-item">
            <div className="ct-item-head">
              <span className="prop-tag">{seg.label}</span>
              <span className="ct-item-title">
                {seg.size} in it · {seg.emailable} may be emailed
              </span>
              <button
                className="prop-btn quiet"
                onClick={() =>
                  setState({ ...s, showEvidence: s.showEvidence === seg.key ? null : seg.key })
                }
              >
                {s.showEvidence === seg.key ? "Hide" : "Why"}
              </button>
            </div>
            {s.showEvidence === seg.key && (
              <ul className="mode-reasons">
                {seg.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}
          </article>
        ))}
        <div className="prop-actions">
          <button
            className="prop-btn signal"
            disabled={s.busy}
            onClick={() =>
              void act({ action: "propose_segments" }, (j) => {
                const created = Number(j.created ?? 0);
                const skipped =
                  (j.skipped as { segment: string; reason: string }[] | undefined) ?? [];
                return created > 0
                  ? `${created} proposal${created === 1 ? "" : "s"} in your approval queue. Nothing sends on approval — sending arrives with its own consent re-check.`
                  : skipped.map((x) => `${x.segment}: ${x.reason}`).join(" · ") ||
                      "Nothing to propose.";
              })
            }
          >
            Propose a win-back and a thank-you
          </button>
          <Link className="prop-btn quiet" href="/proposals">
            Open the queue
          </Link>
        </div>
      </section>

      {(s.campaigns ?? []).length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">approved campaigns — drafted, never sent from here</span>
          {(s.campaigns ?? []).map((c) => (
            <article key={c.proposal_id} className="ct-item">
              <div className="ct-item-head">
                <span className="prop-tag">{c.label ?? "campaign"}</span>
                <span className="ct-item-title">{c.summary}</span>
                {c.draft === null && (
                  <button
                    className="prop-btn signal"
                    disabled={s.busy}
                    onClick={() =>
                      void act({ action: "draft_campaign", proposal_id: c.proposal_id }, (j) =>
                        j.fresh
                          ? "Drafted in your voice, with the AI disclosure and the footer. Read it below — nothing has been sent."
                          : "This campaign already has its draft.",
                      )
                    }
                  >
                    Draft the email
                  </button>
                )}
              </div>
              {c.draft && <pre className="ct-body">{c.draft.body}</pre>}
              {c.gaps.length > 0 ? (
                <p className="conn-note">
                  Before it can send, it still needs: {c.gaps.join("; ")}.{" "}
                  {c.ask.map((q) => (
                    <Link
                      key={q.question_id}
                      href={`/intake?ask=${encodeURIComponent(q.question_id)}`}
                      style={{ marginRight: 12 }}
                    >
                      {q.label}
                    </Link>
                  ))}
                </p>
              ) : (
                <p className="conn-note">
                  Complete for where you are. Added at send time: {c.at_send.join(" and ")}, after
                  consent is checked again for every recipient.
                </p>
              )}
            </article>
          ))}
        </section>
      )}

      <section className="card ops-card">
        <span className="auth-eyebrow">import — under your attestation</span>
        <p className="auth-copy">
          Paste a CSV from your shop or spreadsheet. Columns it understands: email, name, phone, and
          — for lifecycle — last order date, order count, total spent. You state what these contacts
          consented to and how; that statement lands on every row.
        </p>
        <form
          className="ct-goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              {
                action: "import",
                csv: s.csv,
                status: s.status,
                statement: s.statement,
                currency: s.currency,
              },
              (j) =>
                `Imported ${String(j.imported)}. Skipped: ${JSON.stringify(j.skipped)}. Purchase columns: ${JSON.stringify(j.purchase)}.`,
            );
          }}
        >
          <textarea
            className="conn-textarea"
            rows={6}
            placeholder={
              "email,name,last order date,orders,total spent\nanna@example.com,Anna,2026-03-02,4,312.50"
            }
            value={s.csv}
            onChange={(e) => setState({ ...s, csv: e.target.value })}
          />
          <select
            className="ct-input"
            value={s.status}
            onChange={(e) =>
              setState({ ...s, status: e.target.value as Contact["consent_status"] })
            }
          >
            <option value="explicit_consent">They gave explicit consent to marketing email</option>
            <option value="implied_consent">
              Consent is implied (customers, no explicit opt-in)
            </option>
            <option value="unsure">Unsure</option>
            <option value="no_consent">No consent</option>
          </select>
          <input
            className="ct-input"
            placeholder="How was it obtained, in your words — e.g. checkout checkbox since 2024"
            value={s.statement}
            onChange={(e) => setState({ ...s, statement: e.target.value })}
          />
          <input
            className="ct-input"
            placeholder="Currency of the spent column (EUR, HUF, …)"
            value={s.currency}
            onChange={(e) => setState({ ...s, currency: e.target.value })}
          />
          <button
            className="prop-btn"
            disabled={s.busy || s.csv.trim() === "" || s.statement.trim() === ""}
          >
            Import under my attestation
          </button>
        </form>
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">contacts — {s.contacts.length}</span>
        {s.contacts.length === 0 && <p className="conn-note">None yet.</p>}
        {s.contacts.map((c) => (
          <article key={c.id} className="ct-item">
            <div className="ct-item-head">
              <span className="prop-tag">{c.lifecycle}</span>
              <span className="ct-item-title">{c.name ?? c.email ?? "(no name)"}</span>
              <button
                className="prop-btn quiet"
                disabled={s.busy}
                onClick={() => {
                  if (
                    window.confirm(
                      "Erase this contact? The row goes for good; the suppression stays.",
                    )
                  ) {
                    void act(
                      { action: "erase", contact_id: c.id },
                      () => "Erased. The suppression hash stays.",
                    );
                  }
                }}
              >
                Erase
              </button>
            </div>
            <p className="conn-note">
              {c.email ?? "no email"} · {CONSENT_WORD[c.consent_status]} · last order{" "}
              {c.last_purchase_at ? c.last_purchase_at.slice(0, 10) : "—"} · orders{" "}
              {c.orders_count ?? "—"} · spent {money(c.total_spent_minor, c.spent_currency)}
            </p>
          </article>
        ))}
      </section>

      <p className="conn-note">
        Per-customer history comes from your own shop export, not from Phase 2&apos;s connectors,
        which measure the business as a whole. Erasure is GDPR erasure: the row goes, the audit
        trail keeps only ids and hashes. <Link href="/support">Support</Link> ·{" "}
        <Link href="/proposals">Proposals</Link>
      </p>
    </main>
  );
}
