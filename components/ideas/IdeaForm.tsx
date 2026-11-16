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
}

const CUSTOMERS = ["consumer", "business", "both"];
const MODELS = ["one_off", "subscription", "commission", "recruitment"];
const RAMPS = ["1", "3", "6", "12"];

const EMPTY = {
  sector: "",
  country: "",
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
  const recruitment = a.revenue_model === "recruitment";
  const model = a.revenue_model && !recruitment ? a.revenue_model : "one_off";

  const set = (k: Key) => (e: { target: { value: string } }) =>
    setA((prev) => ({
      ...prev,
      [k]: e.target.value,
      ...(k === "country" ? { currency: p.currencyByCountry[e.target.value] ?? "EUR" } : {}),
    }));

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
      <span>{label}</span>
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
    <form className="card entry-col" onSubmit={submit}>
      {select("sector", tr("q.sector"), p.sectors)}
      {select("country", tr("q.country"), p.countries)}
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
            <span>{tr(`q.customers_month.${model}`)}</span>
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
            <span>{tr("q.team")}</span>
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
                r === "1" || r === "12" ? tr(`ramp.${r}`) : tr("ramp.months", { count: Number(r) }),
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
  );
}
