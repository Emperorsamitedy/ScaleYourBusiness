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
// attestation (P4-03). Nothing on this screen sends anything. The window,
// sources, ASSUMED lines and consent notes sit folded under "How this works"
// (decluttered 2026-11-09 on the owner's instruction), reachable, not read out.
//
// L-3b (TASKS-LANGUAGES.md): the screen's fixed words are the "pipeline"
// catalogue; every figure and date is in the reader's locale, each amount
// in its own currency. The reasons, sources and assumptions the API words
// (lib/pipeline) are shown as they come: L-4b words them in the reader's
// language on the server ("pipelineWords").

import { listSep } from "../../lib/i18n/punctuation";
import "../../app/pipeline.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { DealCardView, PipelineView, StaleView } from "../../app/api/pipeline/route";
import type { DealStage } from "../../lib/pipeline/stages";
import { DEAL_STAGES } from "../../lib/pipeline/stages";
import { minorUnitExponent } from "../../lib/core/money";
import { monthYear } from "../../lib/i18n/format";
import { rangeOf } from "../../lib/i18n/range";
import type { Tr } from "../../lib/i18n/tr";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { PipelineWords } from "./pipeline-view";
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
  statedPct,
} from "./pipeline-view";

type Act = (body: Record<string, unknown>, done?: (j: Record<string, unknown>) => string) => void;

/** The columns the import reads: the CSV's own header names, which stay as the file writes them. */
const IMPORT_COLUMNS =
  "company, contact, email, phone, deal, stage, value, expected close, next step, next step due, last contact";

/** How far back the won and lost columns reach (lib/pipeline's closed window). */
const CLOSED_DAYS = 90;
/** The window the "likely won by" forecast covers (I-54b). */
const DUE_DAYS = 30;

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useTr("pipeline");
  return (
    <main className="screen pl-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
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

function StageOptions({ tr }: { tr: Tr }) {
  return (
    <>
      {DEAL_STAGES.map((s) => (
        <option key={s} value={s}>
          {tr(`stage.${s}`)}
        </option>
      ))}
    </>
  );
}

function DealCard({ d, busy, act }: { d: DealCardView; busy: boolean; act: Act }) {
  const { tr, locale } = useTr("pipeline");
  const [step, setStep] = useState(d.next_step ?? "");
  const [due, setDue] = useState(d.next_step_due ?? "");
  return (
    <li className={`pl-deal${d.stale ? " stale" : ""}`}>
      <p className="pl-who">{d.who}</p>
      <p className="pl-title">{d.title}</p>
      <p className="pl-fig">
        {d.value ? money(d.value, locale) : tr("card.noValue")}
        {d.value_basis === "estimated" && <span className="pl-src"> {tr("card.estimate")}</span>}
      </p>
      <p className="pl-age">
        {tr("card.inStage", { days: num(d.age.days_in_stage, 0, locale) })}
        {d.stale && <span className="flag drift"> {tr("card.stale")}</span>}
      </p>
      <details className="pl-edit">
        <summary>{tr("card.change")}</summary>
        <label className="pl-field">
          <span className="label">{tr("card.stage")}</span>
          <select
            value={d.stage}
            disabled={busy}
            onChange={(e) =>
              act({ action: "update", deal_id: d.id, change: { stage: e.target.value } })
            }
          >
            <StageOptions tr={tr} />
          </select>
        </label>
        <label className="pl-field">
          <span className="label">{tr("card.nextStep")}</span>
          <input value={step} onChange={(e) => setStep(e.target.value)} />
        </label>
        <label className="pl-field">
          <span className="label">{tr("card.by")}</span>
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
            {tr("card.save")}
          </button>
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() => act({ action: "update", deal_id: d.id, change: { contacted: {} } })}
          >
            {tr("card.spoke")}
          </button>
        </div>
      </details>
    </li>
  );
}

function Board({ view, busy, act }: { view: PipelineView; busy: boolean; act: Act }) {
  const { tr, locale } = useTr("pipeline");
  const ageing = new Map((view.ageing ?? []).map((a) => [a.stage, a]));
  return (
    <div className="pl-board" tabIndex={0} aria-label={tr("board.aria")}>
      {(view.columns ?? []).map((col) => {
        const a = ageing.get(col.stage);
        const label = tr(`stage.${col.stage}`);
        const total = col.deals.reduce<Record<string, number>>((acc, d) => {
          if (d.value) acc[d.value.currency] = (acc[d.value.currency] ?? 0) + d.value.amount_minor;
          return acc;
        }, {});
        return (
          <section key={col.stage} className="pl-col" aria-label={label}>
            <header className="pl-col-head">
              <h3>{label}</h3>
              <p className="pl-col-meta">
                {num(col.deals.length, 0, locale)}
                {Object.entries(total).map(([c, v]) => (
                  <span key={c}> · {money({ amount_minor: v, currency: c }, locale)}</span>
                ))}
              </p>
              {a && a.median_days !== null && (
                <p className="pl-col-meta">
                  {tr("board.median", {
                    median: num(a.median_days, 0, locale),
                    oldest: num(a.oldest_days ?? 0, 0, locale),
                  })}
                </p>
              )}
              {(col.stage === "won" || col.stage === "lost") && (
                <p className="pl-col-meta">{tr("board.closedRecent", { days: CLOSED_DAYS })}</p>
              )}
            </header>
            <ol className="pl-deals">
              {col.deals.map((d) => (
                <DealCard key={d.id} d={d} busy={busy} act={act} />
              ))}
              {col.deals.length === 0 && <li className="pl-none">{tr("board.none")}</li>}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

function StaleRow({ s, busy, act }: { s: StaleView; busy: boolean; act: Act }) {
  const { tr, locale } = useTr("pipeline");
  const t = useTranslations("pipeline");
  const words: PipelineWords = { tr, locale };
  const f = s.followup;
  const w = f ? followUpWord(f, tr) : null;
  const [copied, setCopied] = useState(false);
  return (
    <li className="pl-stale-row">
      <div>
        <p className="pl-stale-head">
          <strong>{quietSentence(s.deal.who, s.deal.age, words)}</strong>
          {w && <span className={`word ${w.tone}`}>{w.word}</span>}
        </p>
        <p className="pl-stale-why">
          {s.deal.title} · {tr(`stageInline.${s.deal.stage}`)} ·{" "}
          {s.deal.stale ? staleWhy(s.deal.stale, words) : ""}
        </p>
        {f?.status === "blocked" && f.blocked_by_limit && (
          <p className="pl-stale-why">{tr("stale.blocked", { rule: f.blocked_by_limit })}</p>
        )}
        {f?.status === "pending" && (
          <p className="pl-stale-why">
            {t.rich("stale.pending", { link: (c) => <Link href="/proposals">{c}</Link> })}
          </p>
        )}
        {f?.status === "approved" && !f.draft && (
          <button
            type="button"
            className="act"
            disabled={busy}
            onClick={() =>
              act({ action: "draft_followup", proposal_id: f.proposal_id }, () =>
                tr("stale.drafted"),
              )
            }
          >
            {tr("stale.draft")} <span aria-hidden="true">→</span>
          </button>
        )}
        {f?.filled && (
          <div className="pl-draft">
            <pre>{f.filled}</pre>
            <p className="pl-stale-why">
              {tr("stale.dontSend")}{" "}
              <button
                type="button"
                className="pl-link"
                onClick={() => {
                  void navigator.clipboard?.writeText(f.filled ?? "").then(() => setCopied(true));
                }}
              >
                {copied ? tr("stale.copied") : tr("stale.copy")}
              </button>
            </p>
          </div>
        )}
      </div>
    </li>
  );
}

const basisWord = (tr: Tr, basis: string | undefined) =>
  tr(
    basis === "measured"
      ? "rateBasis.measured"
      : basis === "stated"
        ? "rateBasis.stated"
        : "rateBasis.none",
  );

/**
 * I-54b: of the deals the owner expects to close in the next 30 days, how
 * much is likely won, by their own win rate. This one has a date, so it
 * goes on SYB's track record and is checked against the deals marked won.
 */
function DueBy({ view }: { view: PipelineView }) {
  const { tr, locale } = useTr("pipeline");
  const d = view.due;
  if (!d) return null;
  if (!d.ok) {
    return (
      <SheetCard
        label={tr("due.label", { date: dateWords(d.by, locale) })}
        title={tr("due.notForecast")}
      >
        <p className="pl-copy">{d.reason}</p>
        {d.undated > 0 && <p className="pl-fine">{tr("due.undated", { count: d.undated })}</p>}
      </SheetCard>
    );
  }
  const gaps = [
    ...(d.unvalued > 0 ? [tr("due.unvalued", { count: d.unvalued })] : []),
    ...(d.undated > 0 ? [tr("due.undatedOut", { count: d.undated })] : []),
  ];
  return (
    <SheetCard
      label={tr("due.labelRate", {
        date: dateWords(d.by, locale),
        basis: basisWord(tr, d.basis),
      })}
      title={tr("due.title", { days: DUE_DAYS })}
    >
      <ul className="pl-list">
        {d.lines.map((l) => (
          <li key={l.currency}>
            {tr("due.line", {
              count: l.deals.length,
              total: money(l.total, locale),
              low: roughMoney(l.low, locale),
              high: roughMoney(l.high, locale),
            })}
          </li>
        ))}
      </ul>
      {gaps.length > 0 && <p className="pl-copy">{gaps.join(" ")}</p>}
      <Fold summary={tr("how")}>
        <p className="pl-fine">{tr("due.meta")}</p>
        <p className="cs-label pl-gap">{tr("due.assumed")}</p>
        <ul className="pl-list">
          {d.assumed.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="pl-fine">{tr("due.sources", { list: d.sources.join(listSep(locale)) })}</p>
      </Fold>
    </SheetCard>
  );
}

function Weighing({ view }: { view: PipelineView }) {
  const { tr, locale } = useTr("pipeline");
  const w = view.weighted;
  const rate = view.win_rate;
  if (!w || !rate) return null;
  if (!w.ok) {
    return (
      <SheetCard label={tr("weigh.label")} title={tr("weigh.notWeighed")}>
        <p className="pl-copy">{w.reason}</p>
        <Fold summary={tr("why")}>
          <div className="pl-cols2">
            <div>
              <p className="cs-label">{tr("weigh.can")}</p>
              <ul className="pl-list">
                {w.can.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="cs-label">{tr("weigh.cant")}</p>
              <ul className="pl-list">
                {w.cant.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
        </Fold>
        <p className="pl-copy">
          {tr("weigh.ready", { when: w.ready_when })}{" "}
          <Link href={`/intake?ask=${encodeURIComponent(view.win_rate_question ?? "6.1f")}`}>
            {tr("weigh.stateRate")}
          </Link>
        </p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label={tr("weigh.labelRate", { basis: basisWord(tr, rate.basis) })}
      meta={rateWords(rate, { tr, locale })}
    >
      <table className="rt pl-weigh">
        <thead>
          <tr>
            <th scope="col">{tr("weigh.currency")}</th>
            <th scope="col" className="num">
              {tr("weigh.deals")}
            </th>
            <th scope="col" className="num">
              {tr("weigh.open")}
            </th>
            <th scope="col" className="num">
              {tr("weigh.likely")}
            </th>
          </tr>
        </thead>
        <tbody>
          {w.lines.map((l) => (
            <tr key={l.currency}>
              <th scope="row">{l.currency}</th>
              <td className="num">{num(l.deals, 0, locale)}</td>
              <td className="num">{money(l.open_total, locale)}</td>
              <td className="num">
                {rangeOf(roughMoney(l.low, locale), roughMoney(l.high, locale), locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {w.unvalued > 0 && <p className="pl-copy">{tr("weigh.unvalued", { count: w.unvalued })}</p>}
      <Fold summary={tr("how")}>
        <p className="cs-label pl-gap">{tr("weigh.assumed")}</p>
        <ul className="pl-list">
          {w.assumed.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        <p className="pl-fine">
          {tr("weigh.window", {
            from: dateWords(w.window.from, locale),
            to: dateWords(w.window.to, locale),
            list: w.sources.join(listSep(locale)),
          })}
          {rate.basis === "measured" && rate.stated !== null && (
            <> {tr("weigh.statedNote", { stated: statedPct(rate.stated, locale) })}</>
          )}
          {rate.basis === "stated" && <> {tr("weigh.measureAfter", { count: rate.needed })}</>}
        </p>
      </Fold>
    </SheetCard>
  );
}

function AddDeal({ busy, act }: { busy: boolean; act: Act }) {
  const { tr } = useTr("pipeline");
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
      title={tr("add.label")}
      foot={
        <Fold summary={tr("how")}>
          <p>{tr("add.foot")}</p>
        </Fold>
      }
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
              return tr("add.added");
            },
          );
        }}
      >
        {field("company", tr("add.company"))}
        {field("contact_name", tr("add.contact"))}
        {field("email", tr("add.email"), { type: "email" })}
        <label className="pl-field pl-wide">
          <span className="label">{tr("add.deal")}</span>
          <input
            value={f.title}
            placeholder={tr("add.dealPlaceholder")}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </label>
        <label className="pl-field">
          <span className="label">{tr("add.stage")}</span>
          <select
            value={f.stage}
            onChange={(e) => setF({ ...f, stage: e.target.value as DealStage })}
          >
            <StageOptions tr={tr} />
          </select>
        </label>
        {/* The example stays ungrouped: the box reads digits and one decimal point in every language. */}
        {field("value", tr("add.value"), { inputMode: "decimal", placeholder: "4800" })}
        {field("currency", tr("add.currency"), { maxLength: 3 })}
        <label className="pl-field">
          <span className="label">{tr("add.valueIs")}</span>
          <select value={f.basis} onChange={(e) => setF({ ...f, basis: e.target.value })}>
            <option value="quoted">{tr("add.quoted")}</option>
            <option value="estimated">{tr("add.estimate")}</option>
          </select>
        </label>
        {field("next_step", tr("add.nextStep"))}
        {field("next_step_due", tr("add.by"), { type: "date" })}
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
            {tr("add.submit")} <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
    </SheetCard>
  );
}

function ImportDeals({ busy, act }: { busy: boolean; act: Act }) {
  const { tr, locale } = useTr("pipeline");
  const [csv, setCsv] = useState("");
  const [status, setStatus] = useState("unsure");
  const [statement, setStatement] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [basis, setBasis] = useState("estimated");
  const month = locale === "en" ? "March 2026" : monthYear("2026-03-01", locale);
  return (
    <SheetCard
      title={tr("import.label")}
      foot={
        <Fold summary={tr("how")}>
          <p>{tr("import.lede")}</p>
          <p>{tr("import.foot", { columns: IMPORT_COLUMNS })}</p>
        </Fold>
      }
    >
      <form
        className="pl-form"
        onSubmit={(e) => {
          e.preventDefault();
          act({ action: "import", csv, status, statement, currency, value_basis: basis }, (j) => {
            setCsv("");
            const sk = (j.skipped ?? {}) as Record<string, number>;
            const left = (sk.suppressed ?? 0) + (sk.already_exists ?? 0) + (sk.invalid ?? 0);
            const done = tr("import.done", { count: Number(j.imported ?? 0) });
            return left > 0 ? `${done} ${tr("import.left", { count: left })}` : done;
          });
        }}
      >
        <label className="pl-field pl-wide">
          <span className="label">{tr("import.paste")}</span>
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
          <span className="label">{tr("import.consented")}</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="explicit_consent">{tr("import.explicit")}</option>
            <option value="implied_consent">{tr("import.implied")}</option>
            <option value="unsure">{tr("import.unsure")}</option>
            <option value="no_consent">{tr("import.none")}</option>
          </select>
        </label>
        <label className="pl-field pl-wide">
          <span className="label">{tr("import.how")}</span>
          <input
            value={statement}
            placeholder={tr("import.howPlaceholder", { month })}
            onChange={(e) => setStatement(e.target.value)}
          />
        </label>
        <label className="pl-field">
          <span className="label">{tr("import.currency")}</span>
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
        </label>
        <label className="pl-field">
          <span className="label">{tr("import.valuesAre")}</span>
          <select value={basis} onChange={(e) => setBasis(e.target.value)}>
            <option value="estimated">{tr("import.estimates")}</option>
            <option value="quoted">{tr("import.quoted")}</option>
          </select>
        </label>
        <div className="pl-wide">
          <button className="act" disabled={busy || csv.trim() === "" || statement.trim() === ""}>
            {tr("import.submit")} <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>
    </SheetCard>
  );
}

export function PipelineScreen() {
  const { tr, locale } = useTr("pipeline");
  const t = useTranslations("pipeline");
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
        if (!res.ok) setNote(typeof j.error === "string" ? j.error : tr("error.generic"));
        else {
          if (done) setNote(done(j));
          await load();
        }
      } catch {
        setNote(tr("error.ourSide"));
      } finally {
        setBusy(false);
      }
    })();
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut.title")}>
        <p className="pl-wait">
          {t.rich("signedOut.start", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("failed.title")}>
        <p className="pl-wait">{tr("failed.body")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("loading")} />;
  if (!view.applies) {
    return (
      <Frame title={tr("consumer.title")}>
        <p className="pl-wait">
          {tr("consumer.body")} <Link href="/profile">{tr("consumer.factSheet")}</Link>
        </p>
      </Frame>
    );
  }

  const counts = view.counts ?? { open: 0, closed_shown: 0, total: 0 };
  const stale = view.stale ?? [];
  const rate = view.win_rate;
  const aside = <>{tr("aside", { count: counts.total, basis: basisWord(tr, rate?.basis) })}</>;

  return (
    <Frame title={pipelineHeadline(counts.open, view.weighted, { tr, locale })} aside={aside}>
      {note && (
        <p className="pl-note" role="status">
          {note}
        </p>
      )}
      <SheetCard label={tr("board.label", { count: num(counts.open, 0, locale) })}>
        {counts.total === 0 ? (
          <p className="pl-copy">{tr("board.empty")}</p>
        ) : (
          <Board view={view} busy={busy} act={act} />
        )}
      </SheetCard>

      <div className="pl-grid">
        <SheetCard
          label={tr("quiet.label", { count: num(stale.length, 0, locale) })}
          foot={
            <span className="pl-foot-row">
              {view.held ? (
                <span>{view.held}</span>
              ) : (
                <Fold summary={tr("how")}>
                  <p>{tr("quiet.held")}</p>
                </Fold>
              )}
              <button
                type="button"
                className="act"
                disabled={busy || view.held !== null || stale.length === 0}
                onClick={() =>
                  act({ action: "propose_followups" }, (j) => {
                    const c = Number(j.created ?? 0);
                    const skipped = (j.skipped ?? []) as { reason: string }[];
                    return c === 0
                      ? skipped[0]
                        ? tr("quiet.nothingWhy", { reason: skipped[0].reason })
                        : tr("quiet.nothing")
                      : tr("quiet.created", { count: c });
                  })
                }
              >
                {tr("quiet.propose")} <span aria-hidden="true">→</span>
              </button>
            </span>
          }
        >
          {stale.length === 0 ? (
            <p className="pl-copy">{tr("quiet.allGood")}</p>
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

      <Fold summary={tr("how")}>
        <p className="pl-fine">
          {view.today ? tr("fineTo", { day: dayWords(view.today, locale) }) : tr("fine")}
        </p>
      </Fold>
    </Frame>
  );
}
