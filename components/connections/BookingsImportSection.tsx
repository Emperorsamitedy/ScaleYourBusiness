"use client";

// Import bookings — specs/bookings.md §5. A gym's or salon's numbers live in
// its booking system; most of those can't be connected, but all of them
// export. This sheet takes the export, says which columns it understood,
// what it counted and what it left out, and shows the 28-day measures with
// their arithmetic, or the plain reason a measure isn't measured.
//
// It sits on /connections because it is a measured source like the ones
// above it; /customers imports contacts under a consent attestation, a
// different act.
//
// L-3d: the sheet's fixed words are the "connections.bookings" catalogue
// (the form's shared words "connections.import"); counts and dates in the
// reader's writing. Each measure's arithmetic and reason are the server's
// sentences, English until L-4.

import { useCallback, useEffect, useState } from "react";
import { moneyText, num } from "../sheet/num";
import type { AppLocale } from "../../lib/i18n/locales";
import { useCn } from "./useCn";
import type { CnTr } from "./words";
import { IMPORT_SAMPLES, calendarDay, dateOrderExample, percent } from "./words";

type MeasureView =
  | {
      status: "measured";
      value: number | { amount_minor: number; currency: string };
      arithmetic: string;
    }
  | { status: "unmeasured"; reason: string };

interface Measures {
  from: string;
  to: string;
  completed: number;
  no_shows: number;
  late_cancellations: number | null;
  cancellations: number;
  due: number;
  no_show_rate: MeasureView;
  late_cancellation_rate: MeasureView;
  rebooking_rate: MeasureView;
  revenue: MeasureView;
  utilisation: MeasureView;
}

interface ImportRow {
  id: string;
  platform_label: string;
  currency: string | null;
  imported_at: string;
  rows_read: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: Record<string, number>;
  columns: Record<string, string>;
}

interface View {
  platforms: { id: string; label: string; verified: boolean }[];
  imports: ImportRow[];
  stored: { source: "import" | "square"; appointments: number }[];
  measures: { source: "import" | "square"; measures: Measures }[];
}

interface Outcome {
  platform_label: string;
  columns: Record<string, string>;
  rows_read: number;
  added: number;
  updated: number;
  unchanged: number;
  skipped: Record<string, number>;
  unknown_statuses: Record<string, number>;
  gaps: Record<string, number>;
  merged_lines: number;
  identity: string | null;
  measured_days: { from: string; to: string } | null;
  booked_future: number;
}

/** The column roles the importer reads (lib/bookings), as "connections.bookings.role" keys them. */
export const ROLES = [
  "ref",
  "start",
  "date",
  "time",
  "status",
  "service",
  "staff",
  "client_id",
  "client_email",
  "client_phone",
  "price",
  "duration",
  "cancelled_at",
] as const;
/** Why a row was left out, as "connections.bookings.skip" keys them. */
export const SKIPS = [
  "no_date",
  "unreadable_date",
  "no_status",
  "unknown_status",
  "not_closed_out",
] as const;
/** Why a value was left out, as "connections.bookings.gap" keys them. */
export const GAPS = [
  "time",
  "price",
  "duration",
  "cancelled_at",
  "client",
  "client_erased",
] as const;

const word = (t: CnTr, key: string, fallback: string) => (t.has(key) ? t(key) : fallback);

function errorText(payload: unknown, fallback: string): string {
  const e = (payload as { error?: unknown } | null)?.error;
  return typeof e === "string" && e !== ""
    ? `${e.charAt(0).toUpperCase()}${e.slice(1)}.`
    : fallback;
}

/** The measures' window (specs/bookings.md §5). */
const WINDOW_DAYS = 28;

function Figure({
  m,
  unit,
  t,
  locale,
}: {
  m: MeasureView;
  unit: "%" | "count" | "money";
  t: CnTr;
  locale: AppLocale;
}) {
  if (m.status === "unmeasured") return <span className="flag low">{t("notMeasured")}</span>;
  if (typeof m.value === "number") {
    return (
      <>
        {unit === "%"
          ? locale === "en"
            ? `${num(m.value, 1)}%`
            : percent(m.value, locale, 1)
          : num(m.value, 0, locale)}
      </>
    );
  }
  return <>{moneyText(m.value.amount_minor, m.value.currency, locale)}</>;
}

function MeasuresTable({ m, source }: { m: Measures; source: "import" | "square" }) {
  const { t, locale } = useCn("connections.bookings");
  const from = calendarDay(m.from, locale);
  const to = calendarDay(m.to, locale);
  const rows: { id: string; m: MeasureView; unit: "%" | "count" | "money" }[] = [
    {
      id: "completed",
      m: {
        status: "measured",
        value: m.completed,
        arithmetic: t("completedHow", { from, to }),
      },
      unit: "count",
    },
    { id: "noShow", m: m.no_show_rate, unit: "%" },
    { id: "lateCancel", m: m.late_cancellation_rate, unit: "%" },
    { id: "rebooked", m: m.rebooking_rate, unit: "%" },
    { id: "revenue", m: m.revenue, unit: "money" },
    { id: "full", m: m.utilisation, unit: "%" },
  ];
  return (
    <div className="cn-table-wrap">
      <table className="rt bk-table">
        <caption className="sr-only">
          {t("caption", { source: t(`source.${source}`), days: WINDOW_DAYS, from, to })}
        </caption>
        <thead>
          <tr>
            <th scope="col">{t("measureHead", { days: WINDOW_DAYS })}</th>
            <th scope="col" className="num">
              {t("value")}
            </th>
            <th scope="col">{t("how")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <th scope="row">{t(`measure.${r.id}`)}</th>
              <td className="num" data-label={t("value")}>
                <Figure m={r.m} unit={r.unit} t={t} locale={locale} />
              </td>
              <td className="bk-how" data-label={t("how")}>
                {r.m.status === "measured" ? r.m.arithmetic : r.m.reason}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Counted({ o }: { o: Outcome }) {
  const { t, locale } = useCn("connections.bookings");
  const n = (x: number) => num(x, 0, locale);
  const skipped = Object.entries(o.skipped).filter(([, n]) => n > 0);
  const gaps = Object.entries(o.gaps).filter(([, n]) => n > 0);
  const unknown = Object.entries(o.unknown_statuses);
  return (
    <div className="bk-result" aria-live="polite">
      <p className="cn-sub">{t("understood")}</p>
      <div className="cn-table-wrap">
        <table className="rt bk-table">
          <caption className="sr-only">{t("columnsCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("iRead")}</th>
              <th scope="col">{t("fromColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(o.columns).map(([role, header]) => (
              <tr key={role}>
                <th scope="row">{word(t, `role.${role}`, role)}</th>
                <td className="bk-mono" data-label={t("fromColumn")}>
                  {header}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {o.identity === null && <p className="cn-note">{t("noIdentity")}</p>}

      <p className="cn-sub">{t("counted")}</p>
      <ul className="cn-list">
        <li>
          {t("countedLine", {
            rows: o.rows_read,
            platform: o.platform_label,
            added: o.added,
            updated: o.updated,
            unchanged: o.unchanged,
          })}
        </li>
        {o.merged_lines > 0 && <li>{t("merged", { count: o.merged_lines })}</li>}
        {o.booked_future > 0 && <li>{t("future", { count: o.booked_future })}</li>}
        {o.measured_days && (
          <li>
            {t("daysMeasured", {
              from: calendarDay(o.measured_days.from, locale),
              to: calendarDay(o.measured_days.to, locale),
            })}
          </li>
        )}
      </ul>

      {(skipped.length > 0 || gaps.length > 0) && (
        <>
          <p className="cn-sub">{t("leftOut")}</p>
          <ul className="cn-list">
            {skipped.map(([reason, count]) => (
              <li key={reason}>
                <span className="flag drift">{t("leftOutFlag")}</span>{" "}
                {t.has(`skip.${reason}`)
                  ? t(`skip.${reason}`, { count })
                  : t("skipOther", { count, reason: reason.replace(/_/g, " ") })}
              </li>
            ))}
            {gaps.map(([gap, count]) => (
              <li key={gap}>
                <span className="flag low">{t("valueLeftOutFlag")}</span>{" "}
                {t("gapLine", { count: n(count), gap: word(t, `gap.${gap}`, gap) })}
              </li>
            ))}
          </ul>
          {unknown.length > 0 && (
            <p className="cn-note">
              {t("unknownStatuses", {
                list: unknown
                  .map(([w, c]) => t("unknownStatus", { word: w, count: n(c) }))
                  .join(t("listSep")),
              })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function BookingsImportSection() {
  const { t, locale } = useCn("connections.bookings");
  const { t: ti } = useCn("connections.import");
  const [view, setView] = useState<View | null>(null);
  const [platform, setPlatform] = useState("fresha");
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [currency, setCurrency] = useState("");
  const [dateOrder, setDateOrder] = useState<"" | "dmy" | "mdy">("");
  const [decimalStyle, setDecimalStyle] = useState<"" | "dot_decimal" | "comma_decimal">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/bookings", { cache: "no-store" });
      if (res.ok) setView((await res.json()) as View);
    } catch {
      // The sheet still offers the import; the measures wait for the next load.
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
      const res = await fetch("/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          csv,
          platform,
          currency: currency.trim(),
          ...(dateOrder !== "" ? { date_order: dateOrder } : {}),
          ...(decimalStyle !== "" ? { decimal_style: decimalStyle } : {}),
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        (Outcome & { view?: Omit<View, "platforms"> }) | null;
      if (!res.ok || payload === null) {
        setError(errorText(payload, t("failed")));
        return;
      }
      setOutcome(payload);
      if (payload.view && view) setView({ ...view, ...payload.view });
      setCsv("");
      setFileName(null);
    } catch {
      setError(ti("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const latest = view?.imports[0] ?? null;

  return (
    <section className="cs bk-card" aria-labelledby="bk-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{t("label")}</p>
          <h2 className="cs-title" id="bk-title">
            {t("title")}
          </h2>
        </div>
        {latest && (
          <p className="cs-meta">
            {t("lastImport", {
              day: calendarDay(latest.imported_at, locale),
              platform: latest.platform_label,
            })}
          </p>
        )}
      </header>
      <div className="cs-body bk-body">
        <p className="cn-copy">{t("lede")}</p>

        {(view?.measures ?? []).map(({ source, measures }) => (
          <div key={source} className="bk-measures">
            <p className="cn-sub">
              {t("measuresSub", {
                source: t(`source.${source}`),
                from: calendarDay(measures.from, locale),
                to: calendarDay(measures.to, locale),
              })}
            </p>
            <MeasuresTable m={measures} source={source} />
          </div>
        ))}

        <form className="cn-form" onSubmit={(e) => void submit(e)}>
          <label className="cn-field">
            <span className="cn-field-label">{t("platform")}</span>
            <select
              className="cn-input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={busy}
            >
              {(view?.platforms ?? [{ id: "fresha", label: "Fresha", verified: false }]).map(
                (p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === "generic" ? t("generic") : p.label}
                  </option>
                ),
              )}
            </select>
          </label>
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
              placeholder={
                "Date,Time,Status,Service,Staff,Client email,Price\n2026-10-01,10:00,Completed,Cut,Kata,anna@example.com,40.00"
              }
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
          <button className="next" type="submit" disabled={busy || csv.trim() === ""}>
            {busy ? ti("reading") : t("submit")}
          </button>
        </form>
        <p className="cn-note">{t("overlap")}</p>

        {outcome !== null && <Counted o={outcome} />}
      </div>
    </section>
  );
}
