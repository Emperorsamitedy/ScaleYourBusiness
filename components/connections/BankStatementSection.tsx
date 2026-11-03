"use client";

// Import a bank statement — I-54a. The owner exports a statement from their
// bank as CSV and gives SYB the file: only each row's date and the running
// balance are read, and each day's closing balance becomes the cash in the
// bank, measured. The cash forecast starts from it when it is no more than
// a week old, and SYB's track record grades the forecast's weekly closing
// balances by later statements. No bank is connected and nothing is moved.
//
// L-3d: the sheet's words are the "connections.bank" catalogue (the form's
// shared words "connections.import"); money and dates in the reader's
// writing, in the statement's own currency. The server's refusals stay
// English until L-4.

import { useCallback, useEffect, useState } from "react";
import type { BankStatementView } from "../../app/api/bank-statement/route";
import { moneyText } from "../sheet/num";
import { englishTr } from "../../lib/i18n/tr";
import type { Tr } from "../../lib/i18n/tr";
import type { AppLocale } from "../../lib/i18n/locales";
import { useCn } from "./useCn";
import { IMPORT_SAMPLES, calendarDay, dateOrderExample, joinSentences } from "./words";

interface Outcome {
  from: string;
  through: string;
  days: number;
  rows_read: number;
  skipped: { date_unreadable: number; balance_unreadable: number; day_unclear: number };
  latest: { day: string; amount_minor: number; currency: string };
}

function errorText(payload: unknown, fallback: string): string {
  const e = (payload as { error?: unknown } | null)?.error;
  return typeof e === "string" && e !== ""
    ? `${e.charAt(0).toUpperCase()}${e.slice(1)}.`
    : fallback;
}

/** Pure: what was left out of an import, in words; null when nothing was. */
export function skippedWords(
  s: Outcome["skipped"],
  tr: Tr = englishTr("connections.bank"),
): string | null {
  const parts = [
    s.date_unreadable > 0 ? tr("skipped.date", { count: s.date_unreadable }) : null,
    s.balance_unreadable > 0 ? tr("skipped.balance", { count: s.balance_unreadable }) : null,
    s.day_unclear > 0 ? tr("skipped.day", { count: s.day_unclear }) : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return tr("skipped.line", { parts: parts.join(tr("skipped.sep")) });
}

/** Pure: the outcome's line, in the reader's words and writing. */
export function outcomeWords(o: Outcome, tr: Tr, locale: AppLocale): string {
  return tr("outcome", {
    rows: o.rows_read,
    days: o.days,
    from: calendarDay(o.from, locale),
    through: calendarDay(o.through, locale),
    amount: moneyText(o.latest.amount_minor, o.latest.currency, locale),
  });
}

export function BankStatementSection() {
  const { t, locale } = useCn("connections.bank");
  const { t: ti } = useCn("connections.import");
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
        setError(errorText(payload, t("failed")));
        return;
      }
      setOutcome(payload);
      setCsv("");
      setFileName(null);
      void load();
    } catch {
      setError(ti("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const latest = view?.latest ?? null;
  const left = outcome ? skippedWords(outcome.skipped, t) : null;

  return (
    <section className="cs bk-card" aria-labelledby="bs-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{t("label")}</p>
          <h2 className="cs-title" id="bs-title">
            {t("title")}
          </h2>
        </div>
        {latest && (
          <p className="cs-meta">
            {t("latest", {
              amount: moneyText(latest.amount_minor, latest.currency, locale),
              day: calendarDay(latest.day, locale),
            })}
          </p>
        )}
      </header>
      <div className="cs-body bk-body">
        <p className="cn-copy">{t("lede")}</p>

        <form className="cn-form" onSubmit={(e) => void submit(e)}>
          <label className="cn-field">
            <span className="cn-field-label">{t("file")}</span>
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
              {fileName ? ti("readFrom", { file: fileName }) : ti("orPaste")}
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
            <span className="cn-field-label">{t("currency")}</span>
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
            <span className="cn-field-label">{t("through")}</span>
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
              {ti("datesLabel", { sample: IMPORT_SAMPLES.slashDate })}
            </span>
            <select
              className="cn-input"
              value={dateOrder}
              onChange={(e) => setDateOrder(e.target.value as "" | "dmy" | "mdy")}
              disabled={busy}
            >
              <option value="">{ti("workItOut")}</option>
              <option value="dmy">
                {ti("dayFirst", { example: dateOrderExample("dmy", locale) })}
              </option>
              <option value="mdy">
                {ti("monthFirst", { example: dateOrderExample("mdy", locale) })}
              </option>
            </select>
          </label>
          <label className="cn-field">
            <span className="cn-field-label">
              {ti("amountsLabel", { sample: IMPORT_SAMPLES.ambiguousAmount })}
            </span>
            <select
              className="cn-input"
              value={decimalStyle}
              onChange={(e) =>
                setDecimalStyle(e.target.value as "" | "dot_decimal" | "comma_decimal")
              }
              disabled={busy}
            >
              <option value="">{ti("workItOut")}</option>
              <option value="dot_decimal">
                {ti("dotDecimal", { sample: IMPORT_SAMPLES.dotDecimal })}
              </option>
              <option value="comma_decimal">
                {ti("commaDecimal", { sample: IMPORT_SAMPLES.commaDecimal })}
              </option>
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
            {busy ? ti("reading") : t("submit")}
          </button>
        </form>
        <p className="cn-note">{t("overlap")}</p>

        {outcome !== null && (
          <p className="cn-note" role="status">
            {joinSentences([outcomeWords(outcome, t, locale), left ?? ""], locale)}
          </p>
        )}
      </div>
    </section>
  );
}
