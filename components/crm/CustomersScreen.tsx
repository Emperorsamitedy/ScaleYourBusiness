"use client";

// The customers screen — Phase 4 Sessions A and E, in the owner's
// instrument design (2026-10-17). One sentence counted from the contact
// list; FIND A CUSTOMER (search + lifecycle filters) over a ruled list;
// the open customer's record beside it — their purchase figures, the
// consent recorded for them (rule 19), the segment they fall in, and
// erasure (rule 22: their details go, the suppression hash stays). Below:
// the segments with their arithmetic, approved campaigns, and the import
// under the owner's attestation. Emails are partly masked on screen; the
// full address never needs to be shown. P4-15: a campaign sends only after
// the owner approves the email itself, through the execution engine, and
// its card shows where the send stands and which gate holds it.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import "../../app/customers.css";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyExact, num } from "../sheet/num";
import type { CampaignView } from "./CampaignCard";
import { CampaignCard } from "./CampaignCard";
import {
  LIFECYCLE_ORDER,
  LIFECYCLE_WORD,
  type Lifecycle,
  customersHeadline,
  filterContacts,
  maskEmail,
} from "./customers-view";

interface Contact {
  id: string;
  name: string | null;
  email: string | null;
  consent_status: "explicit_consent" | "implied_consent" | "no_consent" | "unsure";
  lifecycle: Lifecycle;
  last_purchase_at: string | null;
  orders_count: number | null;
  total_spent_minor: number | null;
  spent_currency: string | null;
  /** ISO alpha-2, from the import; null = unknown. */
  country?: string | null;
}

interface SegmentView {
  key: "lapsed" | "lapsing" | "new" | "vip";
  label: string;
  size: number;
  emailable: number;
  excluded: { no_email: number; no_consent: number; suppressed: number };
  evidence: string[];
}

interface Payload {
  posture: "enabled" | "caution" | "disabled" | "unknown";
  contacts: Contact[];
  lifecycle: Record<Lifecycle, number>;
  segments: SegmentView[];
  /** P4-16: absent from an older API. */
  campaigns?: CampaignView[];
  /** P4-15: the business name, for the campaign's default subject line. */
  business_name?: string | null;
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
      query: string;
      filter: Lifecycle | "all";
      open: string | null;
      confirmErase: string | null;
      shown: number;
    });

const PAGE = 50;

const CONSENT_WORD: Record<Contact["consent_status"], string> = {
  explicit_consent: "explicit consent",
  implied_consent: "implied consent — not explicit",
  no_consent: "no consent",
  unsure: "unsure — not explicit",
};

const POSTURE_WORD: Record<Payload["posture"], string> = {
  enabled: "You said customers gave explicit consent — outbound is possible, per contact.",
  caution:
    "Your consent answer was implied or unsure — only contacts with explicit consent can be emailed.",
  disabled: "You said customers gave no consent — outbound email is off.",
  unknown: "You haven't answered the consent question (6.4b) — treated as caution.",
};

/** The import's outcome in words — never a JSON dump. */
function importNotice(j: Record<string, unknown>): string {
  const skipped = (j.skipped ?? {}) as Record<string, number>;
  const purchase = (j.purchase ?? { columns: [], unreadable: 0 }) as {
    columns: string[];
    unreadable: number;
  };
  const country = (j.country ?? { column: false, unreadable: 0 }) as {
    column: boolean;
    unreadable: number;
  };
  const words: Record<string, string> = {
    suppressed: "on the unsubscribe list",
    already_exists: "already here",
    duplicate_in_batch: "repeated in the file",
    invalid: "unreadable rows",
  };
  const skips = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${words[k] ?? k}`);
  const parts = [`Imported ${String(j.imported ?? 0)}.`];
  if (skips.length > 0) parts.push(`Skipped ${skips.join(", ")}.`);
  if (purchase.columns.length > 0) {
    parts.push(
      `Purchase history read from ${purchase.columns.length} column${purchase.columns.length === 1 ? "" : "s"}${purchase.unreadable > 0 ? `; ${purchase.unreadable} value${purchase.unreadable === 1 ? "" : "s"} couldn't be read and were left empty` : ""}.`,
    );
  }
  if (country.column && country.unreadable > 0) {
    parts.push(
      `${country.unreadable} countr${country.unreadable === 1 ? "y wasn't" : "ies weren't"} recognised and ${country.unreadable === 1 ? "was" : "were"} left unknown.`,
    );
  }
  return parts.join(" ");
}

function spent(c: Contact): string {
  return c.total_spent_minor === null || c.spent_currency === null
    ? "—"
    : moneyExact(c.total_spent_minor, c.spent_currency);
}

function lastOrder(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

export function CustomersScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const recordRef = useRef<HTMLElement | null>(null);

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
      query: cur.phase === "ready" ? cur.query : "",
      filter: cur.phase === "ready" ? cur.filter : "all",
      open: cur.phase === "ready" && j.contacts.some((c) => c.id === cur.open) ? cur.open : null,
      confirmErase: null,
      shown: cur.phase === "ready" ? cur.shown : PAGE,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="screen cu-screen">
        <PageHead kicker="Customers" title="Opening customers…" />
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

  const list = filterContacts(s.contacts, s.filter, s.query);
  const visible = list.slice(0, s.shown);
  const open = s.contacts.find((c) => c.id === s.open) ?? visible[0] ?? null;
  const segmentOf = (c: Contact) =>
    c.lifecycle === "lapsed" || c.lifecycle === "lapsing" || c.lifecycle === "new"
      ? s.segments.find((seg) => seg.key === c.lifecycle)
      : undefined;

  const pick = (id: string) => {
    setState({ ...s, open: id, confirmErase: null });
    if (window.matchMedia("(max-width: 1099px)").matches) {
      requestAnimationFrame(() => recordRef.current?.scrollIntoView({ block: "start" }));
    }
  };

  const who = (c: Contact) => c.name ?? maskEmail(c.email);

  return (
    <main className="screen cu-screen">
      <PageHead
        kicker="Customers"
        title={customersHeadline(s.contacts.length, s.lifecycle.lapsed)}
        aside="From the list you imported · nothing sends without your approval of the email"
      />

      {s.notice && (
        <p className="cu-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      <div className="cu-grid">
        <section className="cs cu-list" aria-label="Customers">
          <div className="cu-find">
            <label className="cs-label" htmlFor="cu-q">
              Find a customer
            </label>
            <input
              id="cu-q"
              className="cu-search"
              type="search"
              placeholder="name or email"
              autoComplete="off"
              value={s.query}
              onChange={(e) => setState({ ...s, query: e.target.value, shown: PAGE })}
            />
            <div className="cu-filters" role="group" aria-label="Filter by pattern">
              <button
                type="button"
                className={`cu-chip${s.filter === "all" ? " on" : ""}`}
                aria-pressed={s.filter === "all"}
                onClick={() => setState({ ...s, filter: "all", shown: PAGE })}
              >
                All · {num(s.contacts.length)}
              </button>
              {LIFECYCLE_ORDER.filter((l) => s.lifecycle[l] > 0).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`cu-chip${s.filter === l ? " on" : ""}`}
                  aria-pressed={s.filter === l}
                  onClick={() => setState({ ...s, filter: l, shown: PAGE })}
                >
                  {LIFECYCLE_WORD[l].word} · {num(s.lifecycle[l])}
                </button>
              ))}
            </div>
          </div>

          <div className="cu-table-wrap">
            {visible.length === 0 ? (
              <p className="cu-empty">
                {s.contacts.length === 0
                  ? "No customers yet. Import your shop's export below — under your own attestation of what they consented to."
                  : "Nobody matches that."}
              </p>
            ) : (
              <table className="rt cu-table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col" className="num">
                      Orders
                    </th>
                    <th scope="col" className="num">
                      Spent
                    </th>
                    <th scope="col" className="num">
                      Last order
                    </th>
                    <th scope="col">Pattern</th>
                    <th scope="col">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => {
                    const w = LIFECYCLE_WORD[c.lifecycle];
                    return (
                      <tr key={c.id} className={open?.id === c.id ? "on" : undefined}>
                        <th scope="row">
                          <span className="cu-name">{who(c)}</span>
                          {c.name && <span className="src cu-sub">{maskEmail(c.email)}</span>}
                        </th>
                        <td className="num" data-label="Orders">
                          {c.orders_count ?? "—"}
                        </td>
                        <td className="num" data-label="Spent">
                          {spent(c)}
                        </td>
                        <td className="num" data-label="Last order">
                          {lastOrder(c.last_purchase_at)}
                        </td>
                        <td data-label="Pattern">
                          <span className={`word boxed ${w.tone}`}>{w.word}</span>
                        </td>
                        <td className="cu-open">
                          <button
                            type="button"
                            className="prop-btn cu-open-btn"
                            aria-pressed={open?.id === c.id}
                            aria-label={`Open ${who(c)}`}
                            onClick={() => pick(c.id)}
                          >
                            Open
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <footer className="cs-foot cu-foot">
            <span>
              Showing {num(visible.length)} of {num(list.length)}
              {list.length !== s.contacts.length ? ` (${num(s.contacts.length)} in all)` : ""} ·
              emails are partly hidden on screen
            </span>
            {list.length > visible.length && (
              <button
                type="button"
                className="prop-btn quiet"
                onClick={() => setState({ ...s, shown: s.shown + PAGE })}
              >
                Show {Math.min(PAGE, list.length - visible.length)} more
              </button>
            )}
          </footer>
        </section>

        {open && (
          <section
            className="cs cu-record"
            ref={recordRef}
            aria-labelledby="cu-record-name"
            aria-live="polite"
          >
            <header className="cu-rec-head">
              <p className="cs-label">Customer record</p>
              <h2 className="cs-title" id="cu-record-name">
                {open.name ?? "No name on record"}
              </h2>
              <p className="cu-rec-sub">
                {maskEmail(open.email)} · {open.country ?? "country unknown"}
              </p>
            </header>
            <dl className="cu-stats">
              <div>
                <dt>Orders</dt>
                <dd>{open.orders_count ?? "—"}</dd>
              </div>
              <div>
                <dt>Spent</dt>
                <dd>{spent(open)}</dd>
              </div>
              <div>
                <dt>Last</dt>
                <dd>{lastOrder(open.last_purchase_at)}</dd>
              </div>
            </dl>
            <div className="cu-rec-block">
              <p className="cs-label">On record</p>
              <ul className="cu-facts">
                <li>Consent: {CONSENT_WORD[open.consent_status]} · as you attested at import</li>
                <li>Pattern: {LIFECYCLE_WORD[open.lifecycle].word}</li>
                {segmentOf(open) && (
                  <li>
                    Segment: {segmentOf(open)?.label} · {segmentOf(open)?.size} in it
                  </li>
                )}
              </ul>
              <p className="cu-rec-note">
                Order-by-order history isn&rsquo;t imported — these are the totals from your export.
              </p>
            </div>
            <div className="cu-rec-block cu-erase">
              <p className="cu-erase-title">Erase this customer</p>
              <p className="cu-erase-copy">
                For a deletion request. Removes their name, email, details and support conversations
                from Ledgerline for good. Their address stays on the unsubscribe list as a hash, so
                they are never emailed again; the audit log keeps only anonymous ids.
              </p>
              {s.confirmErase === open.id ? (
                <div className="cu-erase-confirm">
                  <p className="cu-erase-copy">
                    <span className="word alarm">irreversible</span> This cannot be undone.
                  </p>
                  <button
                    type="button"
                    className="next cu-wide"
                    disabled={s.busy}
                    onClick={() =>
                      void act(
                        { action: "erase", contact_id: open.id },
                        () => "Erased. The suppression hash stays.",
                      )
                    }
                  >
                    Erase permanently <span aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    className="prop-btn quiet"
                    onClick={() => setState({ ...s, confirmErase: null })}
                  >
                    Keep them
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="prop-btn cu-wide"
                  disabled={s.busy}
                  onClick={() => setState({ ...s, confirmErase: open.id })}
                >
                  Erase {open.name ?? "this customer"}… <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="cu-lower">
        <SheetCard label="Segments" title="Arithmetic, with the working shown">
          <p className="cu-posture">{POSTURE_WORD[s.posture]}</p>
          <table className="rt cu-seg">
            <thead>
              <tr>
                <th scope="col">Segment</th>
                <th scope="col" className="num">
                  In it
                </th>
                <th scope="col" className="num">
                  May be emailed
                </th>
                <th scope="col">
                  <span className="sr-only">Working</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {s.segments.map((seg) => (
                <tr key={seg.key}>
                  <th scope="row">
                    {seg.label}
                    {s.showEvidence === seg.key && (
                      <ul className="cu-evidence">
                        {seg.evidence.map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    )}
                  </th>
                  <td className="num" data-label="In it">
                    {num(seg.size)}
                  </td>
                  <td className="num" data-label="May be emailed">
                    {num(seg.emailable)}
                  </td>
                  <td className="cu-open">
                    <button
                      type="button"
                      className="prop-btn quiet"
                      aria-expanded={s.showEvidence === seg.key}
                      onClick={() =>
                        setState({
                          ...s,
                          showEvidence: s.showEvidence === seg.key ? null : seg.key,
                        })
                      }
                    >
                      {s.showEvidence === seg.key ? "Hide" : "Why"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cu-actions">
            <button
              type="button"
              className="prop-btn"
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
        </SheetCard>

        <SheetCard label="Import" title="Under your attestation">
          <p className="cu-prose">
            Paste a CSV from your shop or spreadsheet. Columns it understands: email, name, phone,
            country (so each customer&rsquo;s own email rules apply), and — for lifecycle — last
            order date, order count, total spent. You state what these contacts consented to and
            how; that statement lands on every row.
          </p>
          <form
            className="cu-form"
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
                (j) => importNotice(j),
              );
            }}
          >
            <label className="cs-label" htmlFor="cu-csv">
              The CSV
            </label>
            <textarea
              id="cu-csv"
              className="cu-textarea"
              rows={6}
              placeholder={
                "email,name,last order date,orders,total spent\nanna@example.com,Anna,2026-03-02,4,312.50"
              }
              value={s.csv}
              onChange={(e) => setState({ ...s, csv: e.target.value })}
            />
            <label className="cs-label" htmlFor="cu-status">
              What they consented to
            </label>
            <select
              id="cu-status"
              className="cu-input"
              value={s.status}
              onChange={(e) =>
                setState({ ...s, status: e.target.value as Contact["consent_status"] })
              }
            >
              <option value="explicit_consent">
                They gave explicit consent to marketing email
              </option>
              <option value="implied_consent">
                Consent is implied (customers, no explicit opt-in)
              </option>
              <option value="unsure">Unsure</option>
              <option value="no_consent">No consent</option>
            </select>
            <label className="cs-label" htmlFor="cu-statement">
              How it was obtained, in your words
            </label>
            <input
              id="cu-statement"
              className="cu-input"
              placeholder="e.g. checkout checkbox since 2024"
              value={s.statement}
              onChange={(e) => setState({ ...s, statement: e.target.value })}
            />
            <label className="cs-label" htmlFor="cu-currency">
              Currency of the spent column
            </label>
            <input
              id="cu-currency"
              className="cu-input"
              placeholder="EUR, HUF, …"
              value={s.currency}
              onChange={(e) => setState({ ...s, currency: e.target.value })}
            />
            <div>
              <button
                className="next"
                disabled={s.busy || s.csv.trim() === "" || s.statement.trim() === ""}
              >
                Import under my attestation <span aria-hidden="true">→</span>
              </button>
            </div>
          </form>
        </SheetCard>
      </div>

      {(s.campaigns ?? []).length > 0 && (
        <SheetCard
          label="Approved campaigns"
          title="Sent only after you approve the email itself"
          className="cu-campaigns"
        >
          {(s.campaigns ?? []).map((c) => (
            <CampaignCard
              key={c.proposal_id}
              c={c}
              busy={s.busy}
              act={act}
              businessName={s.business_name ?? null}
            />
          ))}
        </SheetCard>
      )}

      <p className="cu-fine">
        Per-customer history comes from your own shop export, not from your connected accounts,
        which measure the business as a whole. Erasing a customer is GDPR erasure: their details go,
        and the record keeps only anonymous ids.
      </p>
    </main>
  );
}
