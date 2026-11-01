"use client";

// Customers · Pipeline — Phase 5 Session D (P5-17), on the sheet system.
// Only for a business that sells to businesses: the menu shows it when
// 6.1a is b2b or both (PIPELINE_APPLIES, a condition in data), and the API
// answers `applies: false` otherwise.
//
// Top to bottom: the headline stated from the weighted range (or why it
// can't be weighed); the board, stages as columns, each deal with its value
// and age; the deals gone quiet, each with its follow-up's state — a
// proposal through the queue, a draft the owner sends from their own mail;
// what's likely to close, with its window, sources and ASSUMED lines
// (rule 25); then adding a deal and importing a CSV under the owner's
// attestation (P4-03). Nothing on this screen sends anything.

import "../../app/pipeline.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { DealCardView, PipelineView, StaleView } from "../../app/api/pipeline/route";
import type { DealStage } from "../../lib/pipeline/stages";
import { DEAL_STAGES, STAGE_LABELS } from "../../lib/pipeline/stages";
import { minorUnitExponent } from "../../lib/core/money";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import {
  dateWords,
  dayWords,
  followUpWord,
  money,
  pipelineHeadline,
  quietSentence,
  rateWords,
  roughMoney,
  staleWhy,
} from "./pipeline-view";

type Act = (body: Record<string, unknown>, done?: (j: Record<string, unknown>) => string) => void;

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="screen pl-screen">
      <PageHead kicker="Customers · Pipeline" title={title} aside={aside} />
      {children}
    </main>
  );
}

/** "4800" or "48.50" typed by the owner → minor units, or null. */
function toMinor(raw: string, currency: string): number | null {
  const v = raw.trim().replace(/[\s,]/g, "");
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const exp = minorUnitExponent(currency.trim().toUpperCase() || "EUR");
  const [whole = "0", frac = ""] = v.split(".");
  if (frac.length > exp) return null;
  return Number(`${whole}${frac.padEnd(exp, "0")}`);
}

function DealCard({ d, busy, act }: { d: DealCardView; busy: boolean; act: Act }) {
  const [step, setStep] = useState(d.next_step ?? "");
  const [due, setDue] = useState(d.next_step_due ?? "");
  return (
    <li className={`pl-deal${d.stale ? " stale" : ""}`}>
      <p className="pl-who">{d.who}</p>
      <p className="pl-title">{d.title}</p>
      <p className="pl-fig">
        {d.value ? money(d.value) : "no value"}
        {d.value_basis === "estimated" && <span className="pl-src"> your estimate</span>}
      </p>
      <p className="pl-age">
        {num(d.age.days_in_stage)} d in stage
        {d.stale && <span className="flag drift"> stale</span>}
      </p>
      <details className="pl-edit">
        <summary>Change</summary>
        <label className="pl-field">
          <span className="label">Stage</span>
          <select
            value={d.stage}
            disabled={busy}
            onChange={(e) =>
              act({ action: "update", deal_id: d.id, change: { stage: e.target.value } })
            }
          >
            {DEAL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="pl-field">
          <span className="label">Next step</span>
          <input value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
        <label className="pl-field">
          <span className="label">By</span>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <div className="pl-edit-acts">
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() =>
              act({
                action: "update",
                deal_id: d.id,
                change: { next_step: { text: step, due: due || null } },
              })
            }
          >
            Save next step
          </button>
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() => act({ action: "update", deal_id: d.id, change: { contacted: {} } })}
          >
            I spoke to them today
          </button>
        </div>
      </details>
    </li>
  );
}

function Board({ view, busy, act }: { view: PipelineView; busy: boolean; act: Act }) {
  const ageing = new Map((view.ageing ?? []).map((a) => [a.stage, a]));
  return (
    <div className="pl-board" tabIndex={0} aria-label="Deals by stage">
      {(view.columns ?? []).map((col) => {
        const a = ageing.get(col.stage);
        const total = col.deals.reduce<Record<string, number>>((acc, d) => {
          if (d.value) acc[d.value.currency] = (acc[d.value.currency] ?? 0) + d.value.amount_minor;
          return acc;
        }, {});
        return (
          <section key={col.stage} className="pl-col" aria-label={col.label}>
            <header className="pl-col-head">
              <h3>{col.label}</h3>
              <p className="pl-col-meta">
                {num(col.deals.length)}
                {Object.entries(total).map(([c, v]) => (
                  <span key={c}> · {money({ amount_minor: v, currency: c })}</span>
                ))}
              </p>
              {a && a.median_days !== null && (
                <p className="pl-col-meta">
                  median {num(a.median_days)} d · oldest {num(a.oldest_days ?? 0)} d
                </p>
              )}
              {(col.stage === "won" || col.stage === "lost") && (
                <p className="pl-col-meta">closed in the last 90 days</p>
              )}
            </header>
            <ol className="pl-deals">
              {col.deals.map((d) => (
                <DealCard key={d.id} d={d} busy={busy} act={act} />
              ))}
              {col.deals.length === 0 && <li className="pl-none">none</li>}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function StaleRow({ s, busy, act }: { s: StaleView; busy: boolean; act: Act }) {
  const f = s.followup;
  const w = f ? followUpWord(f) : null;
  const [copied, setCopied] = useState(false);
  return (
    <li className="pl-stale-row">
      <div>
        <p className="pl-stale-head">
          <strong>{quietSentence(s.deal.who, s.deal.age)}</strong>
          {w && <span className={`word ${w.tone}`}>{w.word}</span>}
        </p>
        <p className="pl-stale-why">
          {s.deal.title} · {STAGE_LABELS[s.deal.stage].toLowerCase()} ·{" "}
          {s.deal.stale ? staleWhy(s.deal.stale) : ""}
        </p>
        {f?.status === "blocked" && f.blocked_by_limit && (
          <p className="pl-stale-why">Your rule ({f.blocked_by_limit}) rules out the email.</p>
        )}
        {f?.status === "pending" && (
          <p className="pl-stale-why">
            The follow-up waits in <Link href="/proposals">Waiting for you</Link>.
          </p>
        )}
        {f?.status === "approved" && !f.draft && (
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() =>
              act(
                { action: "draft_followup", proposal_id: f.proposal_id },
                () => "Drafted. Read it, change what you like, and send it from your own mail.",
              )
            }
          >
            Draft the email <span aria-hidden="true">→</span>
          </button>
        )}
        {f?.filled && (
          <div className="pl-draft">
            <pre>{f.filled}</pre>
            <p className="pl-stale-why">
              I don&apos;t send this. Copy it into your own email to them.{" "}
              <button
                type="button"
                className="pl-link"
                onClick={() => {
                  void navigator.clipboard?.writeText(f.filled ?? "").then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy the text"}
              </button>
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * I-54b: of the deals the owner expects to close in the next 30 days, how
 * much is likely won, by their own win rate. This one has a date, so it
 * goes on SYB's track record and is checked against the deals marked won.
 */
function DueBy({ view }: { view: PipelineView }) {
  const d = view.due;
  if (!d) return null;
  if (!d.ok) {
    return (
      <SheetCard label={`Likely won by ${dateWords(d.by)}`} title="Not forecast yet">
        <p className="pl-copy">{d.reason}</p>
        {d.undated > 0 && (
          <p className="pl-fine">
            {num(d.undated)} open deal{d.undated === 1 ? " has" : "s have"} no expected close date.
          </p>
        )}
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label={`Likely won by ${dateWords(d.by)} · win rate ${d.basis === "measured" ? "MEASURED" : "STATED"}`}
      title="The deals you expect to close in the next 30 days"
      meta="On my track record: I check it against the deals you mark won by then."
    >
      <ul className="pl-list">
        {d.lines.map((l) => (
          <li key={l.currency}>
            {num(l.deals.length)} deal{l.deals.length === 1 ? "" : "s"} worth {money(l.total)}:
            about {roughMoney(l.low)} – {roughMoney(l.high)} likely won.
          </li>
        ))}
      </ul>
      {(d.unvalued > 0 || d.undated > 0) && (
        <p className="pl-copy">
          {d.unvalued > 0
            ? `${num(d.unvalued)} of the deals due have no value and aren't in these figures. `
            : ""}
          {d.undated > 0
            ? `${num(d.undated)} open deal${d.undated === 1 ? " has" : "s have"} no expected close date, so ${d.undated === 1 ? "it isn't" : "they aren't"} in this forecast.`
            : ""}
        </p>
      )}
      <p className="cs-label pl-gap">Assumed</p>
      <ul className="pl-list">
        {d.assumed.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="pl-fine">Sources: {d.sources.join("; ")}.</p>
    </SheetCard>
  );
}

function Weighing({ view }: { view: PipelineView }) {
  const w = view.weighted;
  const rate = view.win_rate;
  if (!w || !rate) return null;
  if (!w.ok) {
    return (
      <SheetCard label="What's likely to close" title="Not weighed yet">
        <p className="pl-copy">{w.reason}</p>
        <div className="pl-cols2">
          <div>
            <p className="cs-label">I can</p>
            <ul className="pl-list">
              {w.can.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="cs-label">I can&apos;t yet</p>
            <ul className="pl-list">
              {w.cant.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="pl-copy">
          Ready {w.ready_when}.{" "}
          <Link href={`/intake?ask=${encodeURIComponent(view.win_rate_question ?? "6.1f")}`}>
            State your win rate
          </Link>
        </p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label={`What's likely to close · win rate ${rate.basis === "measured" ? "MEASURED" : "STATED"}`}
      title="Open value, weighed by your own win rate"
      meta={rateWords(rate)}
    >
      <table className="rt pl-weigh">
        <thead>
          <tr>
            <th scope="col">Currency</th>
            <th scope="col" className="num">
              Deals
            </th>
            <th scope="col" className="num">
              Open
            </th>
            <th scope="col" className="num">
              Likely to close
            </th>
          </tr>
        </thead>
        <tbody>
          {w.lines.map((l) => (
            <tr key={l.currency}>
              <th scope="row">{l.currency}</th>
              <td className="num">{num(l.deals)}</td>
              <td className="num">{money(l.open_total)}</td>
              <td className="num">
                {roughMoney(l.low)} – {roughMoney(l.high)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {w.unvalued > 0 && (
        <p className="pl-copy">
          {num(w.unvalued)} open deal{w.unvalued === 1 ? " has" : "s have"} no value and{" "}
          {w.unvalued === 1 ? "isn't" : "aren't"} in these figures.
        </p>
      )}
      <p className="cs-label pl-gap">Assumed</p>
      <ul className="pl-list">
        {w.assumed.map((a) => (
          <li key={a}>{a}</li>
        ))}
      </ul>
      <p className="pl-fine">
        Window {dateWords(w.window.from)} to {dateWords(w.window.to)}. Sources:{" "}
        {w.sources.join("; ")}.
        {rate.basis === "measured" && rate.stated !== null && (
          <> You told me {rate.stated}%; this uses what your own closed deals show.</>
        )}
        {rate.basis === "stated" && (
          <>
            {" "}
            After {num(rate.needed)} more closed deal{rate.needed === 1 ? "" : "s"} I measure it
            instead.
          </>
        )}
      </p>
    </SheetCard>
  );
}

function AddDeal({ busy, act }: { busy: boolean; act: Act }) {
  const blank = {
    company: "",
    contact_name: "",
    email: "",
    title: "",
    stage: "lead" as DealStage,
    value: "",
    currency: "EUR",
    basis: "quoted",
    next_step: "",
    next_step_due: "",
  };
  const [f, setF] = useState(blank);
  const minor = f.value.trim() === "" ? null : toMinor(f.value, f.currency);
  const field = (key: keyof typeof blank, label: string, extra: Record<string, unknown> = {}) => (
    <label className="pl-field">
      <span className="label">{label}</span>
      <input value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} {...extra} />
    </label>
  );
  return (
    <SheetCard
      label="Add a deal"
      title="Who it's with, and what it's for"
      foot="A new contact is recorded as UNSURE consent: a sales conversation isn't permission to market to them."
    >
      <form
        className="pl-form"
        onSubmit={(e) => {
          e.preventDefault();
          act(
            {
              action: "add",
              deal: {
                company: f.company,
                contact_name: f.contact_name,
                email: f.email,
                title: f.title,
                stage: f.stage,
                value:
                  minor === null
                    ? null
                    : { amount_minor: minor, currency: f.currency, basis: f.basis },
                next_step: f.next_step,
                next_step_due: f.next_step_due || null,
              },
            },
            () => {
              setF(blank);
              return "Added.";
            },
          );
        }}
      >
        {field("company", "Company")}
        {field("contact_name", "Contact")}
        {field("email", "Their email", { type: "email" })}
        <label className="pl-field pl-wide">
          <span className="label">The deal</span>
          <input
            value={f.title}
            placeholder="e.g. Spring tableware for the café"
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </label>
        <label className="pl-field">
          <span className="label">Stage</span>
          <select
            value={f.stage}
            onChange={(e) => setF({ ...f, stage: e.target.value as DealStage })}
          >
            {DEAL_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        {field("value", "Value", { inputMode: "decimal", placeholder: "4800" })}
        {field("currency", "Currency", { maxLength: 3 })}
        <label className="pl-field">
          <span className="label">The value is</span>
          <select value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })}>
            <option value="quoted">What I quoted them</option>
            <option value="estimated">My estimate</option>
          </select>
        </label>
        {field("next_step", "Next step")}
        {field("next_step_due", "By", { type: "date" })}
        <div className="pl-wide">
          <button
            className="act"
            disabled={
              busy ||
              f.title.trim() === "" ||
              (f.company.trim() === "" && f.contact_name.trim() === "" && f.email.trim() === "") ||
              (f.value.trim() !== "" && minor === null)
            }
          >
            Add the deal <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
    </SheetCard>
  );
}

function ImportDeals({ busy, act }: { busy: boolean; act: Act }) {
  const [csv, setCsv] = useState("");
  const [status, setStatus] = useState("unsure");
  const [statement, setStatement] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [basis, setBasis] = useState("estimated");
  return (
    <SheetCard
      label="Import"
      title="Deals from a spreadsheet, under your attestation"
      foot="Columns I read: company, contact, email, phone, deal, stage, value, expected close, next step, next step due, last contact."
    >
      <p className="pl-copy">
        A deals file brings people with it, so it comes in the way a customer list does: you state
        what the people in it consented to and how, and that statement lands on every contact it
        adds. Contacts you already have keep their consent; an erased or unsubscribed address is
        refused.
      </p>
      <form
        className="pl-form"
        onSubmit={(e) => {
          e.preventDefault();
          act({ action: "import", csv, status, statement, currency, value_basis: basis }, (j) => {
            setCsv("");
            const sk = (j.skipped ?? {}) as Record<string, number>;
            const left = (sk.suppressed ?? 0) + (sk.already_exists ?? 0) + (sk.invalid ?? 0);
            return (
              `Imported ${String(j.imported ?? 0)} deal${j.imported === 1 ? "" : "s"}.` +
              (left > 0 ? ` ${left} row${left === 1 ? " was" : "s were"} left out.` : "")
            );
          });
        }}
      >
        <label className="pl-field pl-wide">
          <span className="label">Paste the file (CSV)</span>
          <textarea
            rows={4}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={
              "company,contact,email,deal,stage,value\nCafé Nua,Aoife,aoife@cafenua.ie,Spring tableware,proposal sent,4800"
            }
          />
        </label>
        <label className="pl-field pl-wide">
          <span className="label">What the people in it consented to</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="explicit_consent">They gave explicit consent to marketing email</option>
            <option value="implied_consent">Consent is implied (no explicit opt-in)</option>
            <option value="unsure">Unsure</option>
            <option value="no_consent">No consent</option>
          </select>
        </label>
        <label className="pl-field pl-wide">
          <span className="label">How it was obtained, in your words</span>
          <input
            value={statement}
            placeholder="e.g. trade-fair sign-up sheet, March 2026"
            onChange={(e) => setStatement(e.target.value)}
          />
        </label>
        <label className="pl-field">
          <span className="label">Currency of the value column</span>
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </label>
        <label className="pl-field">
          <span className="label">The values are</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="estimated">My estimates</option>
            <option value="quoted">What I quoted them</option>
          </select>
        </label>
        <div className="pl-wide">
          <button className="act" disabled={busy || csv.trim() === "" || statement.trim() === ""}>
            Import under my attestation <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
    </SheetCard>
  );
}

export function PipelineScreen() {
  const [view, setView] = useState<PipelineView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pipeline");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as PipelineView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act: Act = (body, done) => {
    setBusy(true);
    setNote(null);
    void (async () => {
      try {
        const res = await fetch("/api/pipeline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = (await res.json()) as Record<string, unknown>;
        if (!res.ok) setNote(typeof j.error === "string" ? j.error : "That didn't work.");
        else {
          if (done) setNote(done(j));
          await load();
        }
      } catch {
        setNote("Something went wrong on our side. Try again.");
      } finally {
        setBusy(false);
      }
    })();
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="pl-wait">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Your pipeline didn't load.">
        <p className="pl-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading your pipeline…" />;
  if (!view.applies) {
    return (
      <Frame title="A pipeline is for selling to businesses.">
        <p className="pl-wait">
          You told me you sell to consumers, so there are no deals to track here.{" "}
          <Link href="/profile">Fact sheet</Link>
        </p>
      </Frame>
    );
  }

  const counts = view.counts ?? { open: 0, closed_shown: 0, total: 0 };
  const stale = view.stale ?? [];
  const rate = view.win_rate;
  const aside = (
    <>
      Your pipeline · {num(counts.total)} deal{counts.total === 1 ? "" : "s"} · win rate{" "}
      {rate?.basis === "measured" ? "MEASURED" : rate?.basis === "stated" ? "STATED" : "NOT KNOWN"}
    </>
  );

  return (
    <Frame title={pipelineHeadline(counts.open, view.weighted)} aside={aside}>
      {note && (
        <p className="pl-note" role="status">
          {note}
        </p>
      )}
      <SheetCard
        label={`The board · ${num(counts.open)} open`}
        title="Stages as columns, the longest in its stage first"
      >
        {counts.total === 0 ? (
          <p className="pl-copy">No deals yet. Add one below, or import your spreadsheet.</p>
        ) : (
          <Board view={view} busy={busy} act={act} />
        )}
      </SheetCard>

      <div className="pl-grid">
        <SheetCard
          label={`Gone quiet · ${num(stale.length)}`}
          title="No next step, or a next step past its date"
          foot={
            <span className="pl-foot-row">
              <span>
                {view.held ??
                  "I draft a follow-up only for a contact who said yes to email. Nothing sends: you send it yourself."}
              </span>
              <button
                type="button"
                className="act"
                disabled={busy || view.held !== null || stale.length === 0}
                onClick={() =>
                  act({ action: "propose_followups" }, (j) => {
                    const c = Number(j.created ?? 0);
                    const skipped = (j.skipped ?? []) as { reason: string }[];
                    return c === 0
                      ? `Nothing new to propose${skipped[0] ? `: ${skipped[0].reason}` : ""}.`
                      : `${c} follow-up${c === 1 ? "" : "s"} now wait for you in the queue.`;
                  })
                }
              >
                Propose follow-ups <span aria-hidden="true">→</span>
              </button>
            </span>
          }
        >
          {stale.length === 0 ? (
            <p className="pl-copy">Every open deal has a next step that isn&apos;t overdue.</p>
          ) : (
            <ol className="pl-stale">
              {stale.map((s) => (
                <StaleRow key={s.deal.id} s={s} busy={busy} act={act} />
              ))}
            </ol>
          )}
        </SheetCard>
        <Weighing view={view} />
        <DueBy view={view} />
      </div>

      <div className="pl-grid">
        <AddDeal busy={busy} act={act} />
        <ImportDeals busy={busy} act={act} />
      </div>

      <p className="pl-fine">
        Deals belong to your contacts: erasing a contact on Customers erases their deals, their
        history and any drafted follow-up. Dates count in whole days
        {view.today ? ` to ${dayWords(view.today)}` : ""}.
      </p>
    </Frame>
  );
}
