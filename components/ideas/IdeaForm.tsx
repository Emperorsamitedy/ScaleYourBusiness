"use client";

// The idea check's questions (TASKS-IDEAS.md I-40/I-41), then its result on
// the same page. The options arrive from the server in the reader's
// language. A recruitment-based model asks nothing more (rule 39); "I
// don't know" is a real answer for the customers (rule 5).

import Link from "next/link";
import { useState } from "react";
import type { IdeaAnswers, IdeaResult } from "../../lib/ideas/check";
import { ShareLink } from "../ladder/ShareLink";
import { useTr } from "../sheet/useTr";
import { KeepIdea } from "./IdeaActions";
import { IdeaResultView } from "./IdeaResultView";

type Option = { value: string; label: string };

export interface IdeaFormProps {
  sectors: Option[];
  countries: Option[];
  currencies: string[];
  currencyByCountry: Record<string, string>;
  /** D98: each country's cities in the local snapshot. */
  citiesByCountry: Record<string, Option[]>;
}

const CUSTOMERS = ["consumer", "business", "both"];
const MODELS = ["one_off", "subscription", "commission", "recruitment"];
const RAMPS = ["1", "3", "6", "12"];

const EMPTY = {
  sector: "",
  country: "",
  city: "",
  town: "",
  customer: "",
  revenue_model: "",
  currency: "EUR",
  price: "",
  variable_cost: "",
  customers_month: "",
  fixed_month: "",
  startup: "",
  capital: "",
  team: "1",
  ramp_months: "",
};
type Key = keyof typeof EMPTY;

/** Gap 8: what the form needs before it can be sent, in the order it asks. */
const NEEDED: readonly Key[] = [
  "sector",
  "country",
  "customer",
  "revenue_model",
  "price",
  "variable_cost",
  "customers_month",
  "fixed_month",
  "startup",
  "capital",
  "team",
  "ramp_months",
];
const NEEDED_RECRUITMENT: readonly Key[] = ["sector", "country", "customer", "revenue_model"];

const whole = (v: string) => Number.parseInt(v, 10);

export function IdeaForm(p: IdeaFormProps) {
  const { tr, locale } = useTr("ideas");
  const [a, setA] = useState(EMPTY);
  const [unknown, setUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    token: string;
    result: IdeaResult;
    answers: IdeaAnswers;
  } | null>(null);
  // I-12: a description read into the form; each answer it filled is marked until touched.
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<string | null>(null);
  const [fromText, setFromText] = useState<ReadonlySet<Key>>(new Set());
  // Gap 8: after a read, what is still missing — asked for in the next round.
  const [missing, setMissing] = useState<readonly Key[]>([]);
  const recruitment = a.revenue_model === "recruitment";
  const model = a.revenue_model && !recruitment ? a.revenue_model : "one_off";

  const set = (k: Key) => (e: { target: { value: string } }) => {
    setFromText((prev) => {
      if (!prev.has(k)) return prev;
      const next = new Set(prev);
      next.delete(k);
      return next;
    });
    setA((prev) => ({
      ...prev,
      [k]: e.target.value,
      ...(k === "country"
        ? { currency: p.currencyByCountry[e.target.value] ?? "EUR", city: "", town: "" }
        : {}),
    }));
  };

  async function readDescription() {
    setReading(true);
    setReadNote(null);
    try {
      const res = await fetch("/api/idea/describe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, ask: missing }),
      });
      if (res.status === 429) return setReadNote(tr("describe.tooMany"));
      if (res.status === 422) return setReadNote(tr("describe.short"));
      if (!res.ok) return setReadNote(tr("failed"));
      const { fields } = (await res.json()) as { fields: Partial<Record<Key, string | number>> };
      // A follow-up round only fills what is still empty: an answer already there stays.
      const keys = (Object.keys(fields) as Key[]).filter(
        (k) => k in EMPTY && (missing.length === 0 || a[k] === "" || missing.includes(k)),
      );
      if (keys.length === 0) return setReadNote(tr("describe.none"));
      const next = { ...a };
      for (const k of keys) next[k] = String(fields[k]);
      if (!keys.includes("currency") && keys.includes("country")) {
        next.currency = p.currencyByCountry[next.country] ?? a.currency;
      }
      if (keys.includes("country") && !keys.includes("city")) next.city = "";
      setA(next);
      if (keys.includes("customers_month")) setUnknown(false);
      setFromText((prev) => new Set([...prev, ...keys]));
      const still = (next.revenue_model === "recruitment" ? NEEDED_RECRUITMENT : NEEDED).filter(
        (k) => next[k] === "" && !(k === "customers_month" && unknown),
      );
      setMissing(still);
      setText("");
      setReadNote(
        `${tr("describe.filled", { count: keys.length })} ${
          still.length > 0
            ? tr("describe.missing", {
                list: new Intl.ListFormat([locale], { type: "conjunction" }).format(
                  still.map((k) => tr(`field.${k}`)),
                ),
              })
            : tr("describe.complete")
        }`,
      );
    } catch {
      setReadNote(tr("failed"));
    } finally {
      setReading(false);
    }
  }
  const mark = (k: Key) =>
    fromText.has(k) ? <span className="idea-from"> {tr("describe.fromText")}</span> : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const answers = recruitment
      ? {
          sector: a.sector,
          country: a.country,
          customer: a.customer,
          revenue_model: a.revenue_model,
          currency: a.currency,
        }
      : {
          ...a,
          city: a.city === "" ? null : a.city,
          town: a.city === "" && a.town.trim() !== "" ? a.town.trim() : null,
          price: whole(a.price),
          variable_cost: whole(a.variable_cost),
          customers_month: unknown ? null : whole(a.customers_month),
          fixed_month: whole(a.fixed_month),
          startup: whole(a.startup),
          capital: whole(a.capital),
          team: whole(a.team),
          ramp_months: a.ramp_months,
        };
    try {
      const res = await fetch("/api/idea", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers, locale }),
      });
      if (res.status === 429) return setError(tr("tooMany"));
      if (!res.ok) return setError(tr("failed"));
      setDone((await res.json()) as { token: string; result: IdeaResult; answers: IdeaAnswers });
    } catch {
      setError(tr("failed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="entry-col">
        <IdeaResultView result={done.result} answers={done.answers} tr={tr} locale={locale} />
        {done.result.status === "worked" && <KeepIdea token={done.token} />}
        <ShareLink path={`/i/${done.token}`} label={tr("share")} done={tr("copied")} />
        <p className="auth-copy">
          {tr("next")} <Link href="/check">→</Link>
        </p>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setDone(null);
            setA(EMPTY);
            setUnknown(false);
          }}
        >
          {tr("again")}
        </button>
      </div>
    );
  }

  const select = (k: Key, label: string, options: Option[]) => (
    <label className="entry-q">
      <span>
        {label}
        {mark(k)}
      </span>
      <select value={a[k]} onChange={set(k)} required>
        {k !== "currency" && <option value="">{tr("pick")}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const amount = (k: Key, label: string, min: number) => (
    <label className="entry-q">
      <span>
        {label} <span className="idea-unit">({a.currency})</span>
        {mark(k)}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        step={1}
        value={a[k]}
        onChange={set(k)}
        required
      />
    </label>
  );

  return (
    <>
      <section className="card entry-col">
        <label className="entry-q">
          <span>{tr("describe.label")}</span>
          <textarea
            rows={4}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={tr(
              missing.length > 0 ? "describe.followPlaceholder" : "describe.placeholder",
            )}
          />
        </label>
        <button
          type="button"
          className="next"
          disabled={reading || text.trim().length < (missing.length > 0 ? 3 : 20)}
          onClick={() => void readDescription()}
        >
          {reading
            ? tr("describe.working")
            : tr(missing.length > 0 ? "describe.followButton" : "describe.button")}
        </button>
        {readNote && (
          <p className="auth-copy idea-note" role="status">
            {readNote}
          </p>
        )}
      </section>
      <form className="card entry-col" onSubmit={submit}>
        {select("sector", tr("q.sector"), p.sectors)}
        {select("country", tr("q.country"), p.countries)}
        {(p.citiesByCountry[a.country]?.length ?? 0) > 0 && (
          <label className="entry-q">
            <span>
              {tr("q.city")}
              {mark("city")}
            </span>
            <select value={a.city} onChange={set("city")}>
              <option value="">{tr("q.cityElsewhere")}</option>
              {p.citiesByCountry[a.country]!.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {a.country !== "" && a.city === "" && (
          <label className="entry-q">
            <span>{tr("q.town")}</span>
            <input
              type="text"
              maxLength={60}
              value={a.town}
              onChange={set("town")}
              placeholder={tr("q.townHint")}
            />
          </label>
        )}
        {select(
          "customer",
          tr("q.customer"),
          CUSTOMERS.map((c) => ({ value: c, label: tr(`customer.${c}`) })),
        )}
        {select(
          "revenue_model",
          tr("q.revenue_model"),
          MODELS.map((m) => ({ value: m, label: tr(`model.${m}`) })),
        )}
        {!recruitment && (
          <>
            {select(
              "currency",
              tr("q.currency"),
              p.currencies.map((c) => ({ value: c, label: c })),
            )}
            {amount("price", tr(`q.price.${model}`), 1)}
            {amount("variable_cost", tr(`q.variable_cost.${model}`), 0)}
            <label className="entry-q">
              <span>
                {tr(`q.customers_month.${model}`)}
                {mark("customers_month")}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={unknown ? "" : a.customers_month}
                onChange={set("customers_month")}
                disabled={unknown}
                required={!unknown}
              />
              <span className="idea-check">
                <input
                  type="checkbox"
                  checked={unknown}
                  onChange={(e) => setUnknown(e.target.checked)}
                  id="idea-unknown"
                />
                <label htmlFor="idea-unknown">{tr("dontKnow")}</label>
              </span>
            </label>
            {amount("fixed_month", tr("q.fixed_month"), 0)}
            {amount("startup", tr("q.startup"), 0)}
            {amount("capital", tr("q.capital"), 0)}
            <label className="entry-q">
              <span>
                {tr("q.team")}
                {mark("team")}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={500}
                step={1}
                value={a.team}
                onChange={set("team")}
                required
              />
            </label>
            {select(
              "ramp_months",
              tr("q.ramp_months"),
              RAMPS.map((r) => ({
                value: r,
                label:
                  r === "1" || r === "12"
                    ? tr(`ramp.${r}`)
                    : tr("ramp.months", { count: Number(r) }),
              })),
            )}
          </>
        )}
        {error && (
          <p className="auth-copy" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="act" disabled={busy}>
          {busy ? tr("working") : tr("submit")}
        </button>
      </form>
    </>
  );
}
