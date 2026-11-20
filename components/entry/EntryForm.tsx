"use client";

// The free entry's six questions (v1 spec §8.2), then its result on the
// same page — no signup wall before it. The options arrive from the server
// in the reader's language; the sixth question is the sector's own. Drawn
// with the sign-up page's pieces (app/auth-v2.css) since 2026-11-17.

import Link from "next/link";
import { useState } from "react";
import type { EntryResult } from "../../lib/entry/one-number";
import { ShareLink } from "../ladder/ShareLink";
import { useTr } from "../sheet/useTr";
import { EntryResultView } from "./EntryResultView";

type Option = { value: string; label: string };

export interface EntryFormProps {
  sectors: Option[];
  countries: Option[];
  bands: Option[];
  channels: string[];
  /** Per business type: its operations question and options. */
  operations: Record<string, { question: string; options: string[] }>;
  /** The share token this visit came from (?ref=), for the referral chain. */
  referredBy: string | null;
}

const EMPTY = {
  sector: "",
  country: "",
  revenue_band: "",
  employees: "",
  channel: "",
  operations: "",
};

export function EntryForm(p: EntryFormProps) {
  const { tr, locale } = useTr("entry");
  const [a, setA] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ token: string; result: EntryResult } | null>(null);
  const ops = a.sector ? p.operations[a.sector] : undefined;
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setA((prev) => ({
      ...prev,
      [k]: e.target.value,
      ...(k === "sector" ? { operations: "" } : {}),
    }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: { ...a, employees: Number.parseInt(a.employees, 10) },
          locale,
          ref: p.referredBy,
        }),
      });
      if (res.status === 429) return setError(tr("tooMany"));
      if (!res.ok) return setError(tr("failed"));
      setDone((await res.json()) as { token: string; result: EntryResult });
    } catch {
      setError(tr("failed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="ax-form ax-check-result">
        <EntryResultView result={done.result} tr={tr} locale={locale} />
        <ShareLink path={`/e/${done.token}`} label={tr("share")} done={tr("copied")} />
        <p className="ax-copy">
          {tr("next")} <Link href="/intake">{tr("nextLink")}</Link>
        </p>
        <button
          type="button"
          className="ax-btn ax-door"
          onClick={() => {
            setDone(null);
            setA(EMPTY);
          }}
        >
          {tr("again")}
        </button>
      </div>
    );
  }

  const select = (k: keyof typeof EMPTY, label: string, options: Option[]) => (
    <label className="ax-field">
      <span className="ax-label">{label}</span>
      <select className="ax-input" value={a[k]} onChange={set(k)} required>
        <option value="">{tr("pick")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <form className="ax-form" onSubmit={submit}>
      {select("sector", tr("q.sector"), p.sectors)}
      {select("country", tr("q.country"), p.countries)}
      {select("revenue_band", tr("q.revenue_band"), p.bands)}
      <label className="ax-field">
        <span className="ax-label">{tr("q.employees")}</span>
        <input
          className="ax-input"
          type="number"
          min={1}
          max={500}
          step={1}
          value={a.employees}
          onChange={set("employees")}
          required
        />
      </label>
      {select(
        "channel",
        tr("q.channel"),
        p.channels.map((c) => ({ value: c, label: tr(`channel.${c}`) })),
      )}
      {ops &&
        select(
          "operations",
          tr(`ops.${ops.question}.question`),
          ops.options.map((o) => ({ value: o, label: tr(`ops.${ops.question}.${o}`) })),
        )}
      {error && (
        <p className="ax-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="ax-btn ax-primary" disabled={busy || !ops}>
        {busy ? tr("working") : tr("submit")}
      </button>
    </form>
  );
}
