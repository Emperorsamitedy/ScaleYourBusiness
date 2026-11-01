"use client";

// Import a bank statement — I-54a. The owner exports a statement from their
// bank as CSV and gives SYB the file: only each row's date and the running
// balance are read, and each day's closing balance becomes the cash in the
// bank, measured. The cash forecast starts from it when it is no more than
// a week old, and SYB's track record grades the forecast's weekly closing
// balances by later statements. No bank is connected and nothing is moved.

import { useCallback, useEffect, useState } from "react";
import type { BankStatementView } from "../../app/api/bank-statement/route";
import { moneyText } from "../sheet/num";

interface Outcome {
  from: string;
  through: string;
  days: number;
  rows_read: number;
  skipped: { date_unreadable: number; balance_unreadable: number; day_unclear: number };
  latest: { day: string; amount_minor: number; currency: string };
}

function day(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function errorText(payload: unknown, fallback: string): string {
  const e = (payload as { error?: unknown } | null)?.error;
  return typeof e === "string" && e !== ""
    ? `${e.charAt(0).toUpperCase()}${e.slice(1)}.`
    : fallback;
}

/** Pure: what was left out of an import, in words; null when nothing was. */
export function skippedWords(s: Outcome["skipped"]): string | null {
  const parts = [
    s.date_unreadable > 0 ? `${s.date_unreadable} with a date I couldn't read` : null,
    s.balance_unreadable > 0 ? `${s.balance_unreadable} with a balance I couldn't read` : null,
    s.day_unclear > 0 ? `${s.day_unclear} from a day whose rows disagree` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return `Left out, never guessed: ${parts.join(", ")}.`;
}

export function BankStatementSection() {
  const [view, setView] = useState<BankStatementView | null>(null);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [currency, setCurrency] = useState("");
  const [through, setThrough] = useState("");
  const [dateOrder, setDateOrder] = useState<"" | "dmy" | "mdy">("");
  const [decimalStyle, setDecimalStyle] = useState<"" | "dot_decimal" | "comma_decimal">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bank-statement", { cache: "no-store" });
      if (res.ok) setView((await res.json()) as BankStatementView);
    } catch {
      // The form still works; the last balance shows on the next load.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bank-statement", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csv,
          currency: currency.trim(),
          ...(through !== "" ? { through } : {}),
          ...(dateOrder !== "" ? { date_order: dateOrder } : {}),
          ...(decimalStyle !== "" ? { decimal_style: decimalStyle } : {}),
        }),
      });
      const payload = (await res.json().catch(() => null)) as Outcome | null;
      if (!res.ok || payload === null) {
        setError(errorText(payload, "That statement didn't import."));
        return;
      }
      setOutcome(payload);
      setCsv("");
      setFileName(null);
      void load();
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const latest = view?.latest ?? null;
  const left = outcome ? skippedWords(outcome.skipped) : null;

  return (
    <section className="cs bk-card" aria-labelledby="bs-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">Bank statement · read once, nothing moved</p>
          <h2 className="cs-title" id="bs-title">
            The cash in your bank, from a statement
          </h2>
        </div>
        {latest && (
          <p className="cs-meta">
            {moneyText(latest.amount_minor, latest.currency)} on {day(latest.day)}
          </p>
        )}
      </header>
      <div className="cs-body bk-body">
        <p className="cn-copy">
          Export a statement from your bank as CSV and give me the file. I read only each
          row&rsquo;s date and the balance after it, nothing about who paid or what for, and keep
          the closing balance of each day. Your cash forecast starts from it while it is a week old
          or less, and I check my forecast&rsquo;s weekly balances against the statements you give
          me later. No bank is connected, and nothing can be moved.
        </p>

        <form className="cn-form" onSubmit={(e) => void submit(e)}>
          <label className="cn-field">
            <span className="cn-field-label">The statement (CSV)</span>
            <input
              className="cn-input"
              type="file"
              accept=".csv,text/csv,text/plain"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setFileName(file.name);
                void file.text().then(setCsv);
              }}
            />
          </label>
          <label className="cn-field">
            <span className="cn-field-label">
              {fileName ? `Read from ${fileName}. You can check it here` : "Or paste it here"}
            </span>
            <textarea
              className="cn-input cn-textarea"
              rows={6}
              spellCheck={false}
              placeholder={"Date,Description,Amount,Balance\n2026-10-30,Card sale,120.00,8420.55"}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="cn-field">
            <span className="cn-field-label">Currency of the account</span>
            <input
              className="cn-input"
              placeholder="EUR, HUF, GBP…"
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              disabled={busy}
            />
          </label>
          <label className="cn-field">
            <span className="cn-field-label">
              The last day the statement covers, if after its last row (optional)
            </span>
            <input
              className="cn-input"
              type="date"
              value={through}
              onChange={(e) => setThrough(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="cn-field">
            <span className="cn-field-label">
              How dates are written, if they look like 03/04/2026
            </span>
            <select
              className="cn-input"
              value={dateOrder}
              onChange={(e) => setDateOrder(e.target.value as "" | "dmy" | "mdy")}
              disabled={busy}
            >
              <option value="">Work it out from the file</option>
              <option value="dmy">Day first (3 April)</option>
              <option value="mdy">Month first (March 4)</option>
            </select>
          </label>
          <label className="cn-field">
            <span className="cn-field-label">How amounts are written, if they look like 1.200</span>
            <select
              className="cn-input"
              value={decimalStyle}
              onChange={(e) =>
                setDecimalStyle(e.target.value as "" | "dot_decimal" | "comma_decimal")
              }
              disabled={busy}
            >
              <option value="">Work it out from the file</option>
              <option value="dot_decimal">1,234.56 (the comma separates thousands)</option>
              <option value="comma_decimal">1.234,56 (the dot separates thousands)</option>
            </select>
          </label>
          {error !== null && (
            <p className="cn-error" role="alert">
              {error}
            </p>
          )}
          <button
            className="next"
            type="submit"
            disabled={busy || csv.trim() === "" || currency.trim().length !== 3}
          >
            {busy ? "Reading…" : "Import this statement"}
          </button>
        </form>
        <p className="cn-note">
          Importing an overlapping statement again is safe: the days it covers are replaced, not
          counted twice. The statement needs a balance column; a list of amounts alone can&rsquo;t
          say what was in the account.
        </p>

        {outcome !== null && (
          <p className="cn-note" role="status">
            Read {outcome.rows_read} {outcome.rows_read === 1 ? "row" : "rows"}: a closing balance
            for each of {outcome.days} {outcome.days === 1 ? "day" : "days"}, {day(outcome.from)} to{" "}
            {day(outcome.through)}, ending at{" "}
            {moneyText(outcome.latest.amount_minor, outcome.latest.currency)}.
            {left ? ` ${left}` : ""}
          </p>
        )}
      </div>
    </section>
  );
}
