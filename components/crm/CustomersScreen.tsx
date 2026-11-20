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
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "customers"
// catalogue; figures, money (in the contact's own currency, never
// converted) and dates in the reader's locale. Names, addresses, segment
// labels and their evidence, and the server's notices are content or built
// by the server, in the reader's language since L-4c, shown as they come. The CSV example and the
// currency codes stay as they are: the importer reads English headers.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import "../../app/customers.css";
import { SegBar } from "../charts/Viz";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyExact, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import { dayMonth, dayMonthYear } from "../../lib/i18n/format";
import type { Tr } from "../../lib/i18n/tr";
import type { CampaignView } from "./CampaignCard";
import { CampaignCard } from "./CampaignCard";
import {
  LIFECYCLE_ORDER,
  LIFECYCLE_TONE,
  LIFECYCLE_WORD,
  type Lifecycle,
  customersHeadline,
  filterContacts,
  lifecycleWord,
  maskEmail,
} from "./customers-view";
import { Logo } from "../brand/Mark";

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

// L6 (docs/DASHBOARD-OVERHAUL.md): less at once. Fifteen rows open the list,
// where fifty made the page 4,700 px tall; each press adds thirty. Search and
// the filters read every customer, never only the rows on screen.
const FIRST = 15;
const MORE = 30;

/** The consent question the posture comes from, by its bank id. */
const CONSENT_QUESTION = "6.4b";
/** The example year in the statement box's placeholder. */
const EXAMPLE_YEAR = "2024";
/** The CSV box's example: the importer reads English column headers, in every language. */
const CSV_EXAMPLE =
  "email,name,last order date,orders,total spent\nanna@example.com,Anna,2026-03-02,4,312.50";
/** The currency box's example: ISO codes, the same in every language. */
const CURRENCY_EXAMPLE = "EUR, HUF, …";
const SKIP_KINDS = ["suppressed", "already_exists", "duplicate_in_batch", "invalid"];

/** A count as the import notice always printed it in English (ungrouped); grouped otherwise. */
const count = (n: number, locale: AppLocale) => (locale === "en" ? String(n) : num(n, 0, locale));

/** The import's outcome in words — never a JSON dump. */
function importNotice(j: Record<string, unknown>, tr: Tr, locale: AppLocale): string {
  const skipped = (j.skipped ?? {}) as Record<string, number>;
  const purchase = (j.purchase ?? { columns: [], unreadable: 0 }) as {
    columns: string[];
    unreadable: number;
    refreshed?: number;
  };
  const country = (j.country ?? { column: false, unreadable: 0 }) as {
    column: boolean;
    unreadable: number;
  };
  const skips = Object.entries(skipped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) =>
      SKIP_KINDS.includes(k)
        ? tr(`import.skip.${k}`, { count: count(n, locale) })
        : `${count(n, locale)} ${k}`,
    );
  const parts = [tr("import.imported", { count: count(Number(j.imported ?? 0), locale) })];
  if (skips.length > 0) parts.push(tr("import.skipped", { list: skips.join(tr("import.sep")) }));
  if (purchase.columns.length > 0) {
    parts.push(
      purchase.unreadable > 0
        ? tr("import.purchaseUnreadable", {
            columns: purchase.columns.length,
            unreadable: purchase.unreadable,
          })
        : tr("import.purchase", { columns: purchase.columns.length }),
    );
  }
  if ((purchase.refreshed ?? 0) > 0) {
    parts.push(tr("import.refreshed", { count: purchase.refreshed ?? 0 }));
  }
  if (country.column && country.unreadable > 0) {
    parts.push(tr("import.country", { count: country.unreadable }));
  }
  return parts.join(" ");
}

function spent(c: Contact, locale: AppLocale): string {
  return c.total_spent_minor === null || c.spent_currency === null
    ? "-"
    : moneyExact(c.total_spent_minor, c.spent_currency, locale);
}

function lastOrder(iso: string | null, locale: AppLocale): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  if (locale !== "en") {
    const day = d.toISOString().slice(0, 10);
    return sameYear ? dayMonth(day, locale) : dayMonthYear(day, locale);
  }
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

export function CustomersScreen() {
  const { tr, locale } = useTr("customers");
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
      shown: cur.phase === "ready" ? cur.shown : FIRST,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="screen cu-screen">
        <PageHead kicker={tr("kicker")} title={tr("opening")} />
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">
            <Logo onDark />
          </span>
          <section className="card auth-card">
            <span className="auth-eyebrow">{tr("signedOut.eyebrow")}</span>
            <h1 className="auth-title">{tr("signedOut.title")}</h1>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/intake">
              {tr("signedOut.begin")}
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
      setState({ ...s, busy: false, notice: j.error ?? tr("failed") });
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

  const who = (c: Contact) => c.name ?? maskEmail(c.email, tr);

  const stages = LIFECYCLE_ORDER.filter((l) => s.lifecycle[l] > 0);
  const pickStage = (key: string) => {
    const l = stages.find((x) => x === key);
    if (l) setState({ ...s, filter: s.filter === l ? "all" : l, shown: FIRST });
  };

  return (
    <main className="screen cu-screen">
      <PageHead
        kicker={tr("kicker")}
        title={customersHeadline(s.contacts.length, s.lifecycle.lapsed, tr)}
      />

      {s.notice && (
        <p className="cu-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      <div className="cu-grid">
        <section className="cs cu-list" aria-label={tr("list.label")}>
          <div className="cu-find">
            <label className="cs-label" htmlFor="cu-q">
              {tr("list.find")}
            </label>
            <input
              id="cu-q"
              className="cu-search"
              type="search"
              placeholder={tr("list.search")}
              autoComplete="off"
              value={s.query}
              onChange={(e) => setState({ ...s, query: e.target.value, shown: FIRST })}
            />
            {stages.length > 0 && (
              <SegBar
                bare
                segs={stages.map((l) => ({
                  key: l,
                  label: lifecycleWord(l, tr),
                  value: s.lifecycle[l],
                  display: num(s.lifecycle[l], 0, locale),
                  tone: LIFECYCLE_TONE[l],
                }))}
                label={customersHeadline(s.contacts.length, s.lifecycle.lapsed, tr)}
                active={s.filter === "all" ? null : s.filter}
                onPick={pickStage}
              />
            )}
            <div className="cu-filters" role="group" aria-label={tr("list.filters")}>
              <button
                type="button"
                className={`cu-chip${s.filter === "all" ? " on" : ""}`}
                aria-pressed={s.filter === "all"}
                onClick={() => setState({ ...s, filter: "all", shown: FIRST })}
              >
                {tr("list.all", { count: num(s.contacts.length, 0, locale) })}
              </button>
              {LIFECYCLE_ORDER.filter((l) => s.lifecycle[l] > 0).map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`cu-chip${s.filter === l ? " on" : ""}`}
                  aria-pressed={s.filter === l}
                  onClick={() => setState({ ...s, filter: l, shown: FIRST })}
                >
                  {lifecycleWord(l, tr)} · {num(s.lifecycle[l], 0, locale)}
                </button>
              ))}
            </div>
          </div>

          <div className="cu-table-wrap">
            {visible.length === 0 ? (
              <p className="cu-empty">
                {s.contacts.length === 0 ? tr("list.empty") : tr("list.noMatch")}
              </p>
            ) : (
              <table className="rt cu-table">
                <thead>
                  <tr>
                    <th scope="col">{tr("list.customer")}</th>
                    <th scope="col" className="num">
                      {tr("list.purchases")}
                    </th>
                    <th scope="col" className="num">
                      {tr("list.spent")}
                    </th>
                    <th scope="col" className="num">
                      {tr("list.lastPurchase")}
                    </th>
                    <th scope="col">{tr("list.pattern")}</th>
                    <th scope="col">
                      <span className="sr-only">{tr("list.open")}</span>
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
                          {c.name && <span className="src cu-sub">{maskEmail(c.email, tr)}</span>}
                        </th>
                        <td className="num" data-label={tr("list.purchases")}>
                          {c.orders_count === null ? "-" : count(c.orders_count, locale)}
                        </td>
                        <td className="num" data-label={tr("list.spent")}>
                          {spent(c, locale)}
                        </td>
                        <td className="num" data-label={tr("list.lastPurchase")}>
                          {lastOrder(c.last_purchase_at, locale)}
                        </td>
                        <td data-label={tr("list.pattern")}>
                          <span className={`word boxed ${w.tone}`}>
                            {lifecycleWord(c.lifecycle, tr)}
                          </span>
                        </td>
                        <td className="cu-open">
                          <button
                            type="button"
                            className="prop-btn cu-open-btn"
                            aria-pressed={open?.id === c.id}
                            aria-label={tr("list.openWho", { name: who(c) })}
                            onClick={() => pick(c.id)}
                          >
                            {tr("list.open")}
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
              {list.length !== s.contacts.length
                ? tr("list.showingFiltered", {
                    shown: num(visible.length, 0, locale),
                    total: num(list.length, 0, locale),
                    all: num(s.contacts.length, 0, locale),
                  })
                : tr("list.showing", {
                    shown: num(visible.length, 0, locale),
                    total: num(list.length, 0, locale),
                  })}
            </span>
            {list.length > visible.length && (
              <button
                type="button"
                className="prop-btn quiet"
                onClick={() => setState({ ...s, shown: s.shown + MORE })}
              >
                {tr("list.more", {
                  count: num(Math.min(MORE, list.length - visible.length), 0, locale),
                })}
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
              <p className="cs-label">{tr("record.label")}</p>
              <h2 className="cs-title" id="cu-record-name">
                {open.name ?? tr("record.noName")}
              </h2>
              <p className="cu-rec-sub">
                {maskEmail(open.email, tr)} · {open.country ?? tr("record.countryUnknown")}
              </p>
            </header>
            <dl className="cu-stats">
              <div>
                <dt>{tr("record.purchases")}</dt>
                <dd>{open.orders_count === null ? "-" : count(open.orders_count, locale)}</dd>
              </div>
              <div>
                <dt>{tr("record.spent")}</dt>
                <dd>{spent(open, locale)}</dd>
              </div>
              <div>
                <dt>{tr("record.last")}</dt>
                <dd>{lastOrder(open.last_purchase_at, locale)}</dd>
              </div>
            </dl>
            <div className="cu-rec-block">
              <p className="cs-label">{tr("record.onRecord")}</p>
              <ul className="cu-facts">
                <li>{tr("record.consent", { consent: tr(`consent.${open.consent_status}`) })}</li>
                <li>{tr("record.pattern", { pattern: lifecycleWord(open.lifecycle, tr) })}</li>
                {segmentOf(open) && (
                  <li>
                    {tr("record.segment", {
                      segment: segmentOf(open)?.label ?? "",
                      size: count(segmentOf(open)?.size ?? 0, locale),
                    })}
                  </li>
                )}
              </ul>
              <p className="cu-rec-note">{tr("record.note")}</p>
            </div>
            <div className="cu-rec-block cu-erase">
              <p className="cu-erase-title">{tr("erase.title")}</p>
              <Fold>
                <p>{tr("erase.copy")}</p>
              </Fold>
              {s.confirmErase === open.id ? (
                <div className="cu-erase-confirm">
                  <p className="cu-erase-copy">
                    <span className="word alarm">{tr("erase.irreversible")}</span>{" "}
                    {tr("erase.cannotUndo")}
                  </p>
                  <button
                    type="button"
                    className="next cu-wide"
                    disabled={s.busy}
                    onClick={() =>
                      void act({ action: "erase", contact_id: open.id }, () => tr("erase.done"))
                    }
                  >
                    {tr("erase.confirm")} <span aria-hidden="true">→</span>
                  </button>
                  <button
                    type="button"
                    className="prop-btn quiet"
                    onClick={() => setState({ ...s, confirmErase: null })}
                  >
                    {tr("erase.keep")}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="prop-btn cu-wide"
                  disabled={s.busy}
                  onClick={() => setState({ ...s, confirmErase: open.id })}
                >
                  {open.name ? tr("erase.button", { name: open.name }) : tr("erase.buttonUnnamed")}{" "}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      <div className="cu-lower">
        <SheetCard label={tr("segments.label")} title={tr("segments.title")}>
          <p className="cu-posture">{tr(`posture.${s.posture}`, { question: CONSENT_QUESTION })}</p>
          <table className="rt cu-seg">
            <thead>
              <tr>
                <th scope="col">{tr("segments.segment")}</th>
                <th scope="col" className="num">
                  {tr("segments.inIt")}
                </th>
                <th scope="col" className="num">
                  {tr("segments.emailable")}
                </th>
                <th scope="col">
                  <span className="sr-only">{tr("segments.working")}</span>
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
                  <td className="num" data-label={tr("segments.inIt")}>
                    {num(seg.size, 0, locale)}
                  </td>
                  <td className="num" data-label={tr("segments.emailable")}>
                    {num(seg.emailable, 0, locale)}
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
                      {s.showEvidence === seg.key ? tr("segments.hide") : tr("segments.why")}
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
                    (j.skipped as
                      { segment: string; reason: string; line?: string }[] | undefined) ?? [];
                  // A skipped segment's line comes from the server, in the reader's language (L-4c).
                  return created > 0
                    ? tr("segments.proposed", { count: created })
                    : skipped.map((x) => x.line ?? `${x.segment}: ${x.reason}`).join(" · ") ||
                        tr("segments.nothing");
                })
              }
            >
              {tr("segments.propose")}
            </button>
            <Link className="prop-btn quiet" href="/proposals">
              {tr("segments.queue")}
            </Link>
          </div>
        </SheetCard>

        <SheetCard label={tr("import.label")} title={tr("import.title")}>
          <Fold className="cu-fold">
            <p>{tr("import.prose")}</p>
          </Fold>
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
                (j) => importNotice(j, tr, locale),
              );
            }}
          >
            <label className="cs-label" htmlFor="cu-csv">
              {tr("import.csv")}
            </label>
            <textarea
              id="cu-csv"
              className="cu-textarea"
              rows={6}
              placeholder={CSV_EXAMPLE}
              value={s.csv}
              onChange={(e) => setState({ ...s, csv: e.target.value })}
            />
            <label className="cs-label" htmlFor="cu-status">
              {tr("import.status")}
            </label>
            <select
              id="cu-status"
              className="cu-input"
              value={s.status}
              onChange={(e) =>
                setState({ ...s, status: e.target.value as Contact["consent_status"] })
              }
            >
              <option value="explicit_consent">{tr("import.option.explicit_consent")}</option>
              <option value="implied_consent">{tr("import.option.implied_consent")}</option>
              <option value="unsure">{tr("import.option.unsure")}</option>
              <option value="no_consent">{tr("import.option.no_consent")}</option>
            </select>
            <label className="cs-label" htmlFor="cu-statement">
              {tr("import.statement")}
            </label>
            <input
              id="cu-statement"
              className="cu-input"
              placeholder={tr("import.statementPlaceholder", { year: EXAMPLE_YEAR })}
              value={s.statement}
              onChange={(e) => setState({ ...s, statement: e.target.value })}
            />
            <label className="cs-label" htmlFor="cu-currency">
              {tr("import.currency")}
            </label>
            <input
              id="cu-currency"
              className="cu-input"
              placeholder={CURRENCY_EXAMPLE}
              value={s.currency}
              onChange={(e) => setState({ ...s, currency: e.target.value })}
            />
            <div>
              <button
                className="next"
                disabled={s.busy || s.csv.trim() === "" || s.statement.trim() === ""}
              >
                {tr("import.submit")} <span aria-hidden="true">→</span>
              </button>
            </div>
          </form>
        </SheetCard>
      </div>

      {(s.campaigns ?? []).length > 0 && (
        <SheetCard
          label={tr("campaigns.label")}
          title={tr("campaigns.title")}
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

      <Fold className="cu-fine on-desk">
        <p>{tr("fine")}</p>
      </Fold>
    </main>
  );
}
