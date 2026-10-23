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

import { useCallback, useEffect, useState } from "react";
import { moneyText, num } from "../sheet/num";

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

const ROLE_WORDS: Record<string, string> = {
  ref: "Booking reference",
  start: "Date and time",
  date: "Date",
  time: "Time",
  status: "What happened",
  service: "Service",
  staff: "Staff",
  client_id: "Client id, hashed and not kept",
  client_email: "Client email, hashed and not kept",
  client_phone: "Client phone, hashed and not kept",
  price: "Price",
  duration: "Duration",
  cancelled_at: "When it was cancelled",
};

const SKIP_WORDS: Record<string, string> = {
  no_date: "with no date",
  unreadable_date: "with a date I couldn't read",
  no_status: "with no status",
  unknown_status: "with a status I don't know",
  not_closed_out: "still marked booked after their day had passed, so I can't tell what happened",
};

const GAP_WORDS: Record<string, string> = {
  time: "a time I couldn't read (the day was kept)",
  price: "a price I couldn't read (left out)",
  duration: "a duration I couldn't read (left out)",
  cancelled_at:
    "a cancellation time I couldn't compare with the start, so it counts as an ordinary cancellation",
  client: "client details I couldn't use, so that visit isn't followed",
};

const SOURCE_WORDS = { import: "Your bookings export", square: "Square" } as const;

function errorText(payload: unknown, fallback: string): string {
  const e = (payload as { error?: unknown } | null)?.error;
  return typeof e === "string" && e !== ""
    ? `${e.charAt(0).toUpperCase()}${e.slice(1)}.`
    : fallback;
}

function day(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function Figure({ m, unit }: { m: MeasureView; unit: "%" | "count" | "money" }) {
  if (m.status === "unmeasured") return <span className="flag low">Not measured</span>;
  if (typeof m.value === "number")
    return <>{unit === "%" ? `${num(m.value, 1)}%` : num(m.value)}</>;
  return <>{moneyText(m.value.amount_minor, m.value.currency)}</>;
}

function MeasuresTable({ m, source }: { m: Measures; source: "import" | "square" }) {
  const rows: { name: string; m: MeasureView; unit: "%" | "count" | "money" }[] = [
    {
      name: "Appointments completed",
      m: {
        status: "measured",
        value: m.completed,
        arithmetic: `completed appointments, ${day(m.from)} to ${day(m.to)}`,
      },
      unit: "count",
    },
    { name: "No-show rate", m: m.no_show_rate, unit: "%" },
    { name: "Late-cancellation rate", m: m.late_cancellation_rate, unit: "%" },
    { name: "Clients who booked again", m: m.rebooking_rate, unit: "%" },
    { name: "Revenue from bookings", m: m.revenue, unit: "money" },
    { name: "How full you are", m: m.utilisation, unit: "%" },
  ];
  return (
    <div className="cn-table-wrap">
      <table className="rt bk-table">
        <caption className="sr-only">
          {SOURCE_WORDS[source]}: the 28 days from {day(m.from)} to {day(m.to)}
        </caption>
        <thead>
          <tr>
            <th scope="col">Measure · 28 days</th>
            <th scope="col" className="num">
              Value
            </th>
            <th scope="col">How I got it</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <th scope="row">{r.name}</th>
              <td className="num" data-label="Value">
                <Figure m={r.m} unit={r.unit} />
              </td>
              <td className="bk-how" data-label="How I got it">
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
  const skipped = Object.entries(o.skipped).filter(([, n]) => n > 0);
  const gaps = Object.entries(o.gaps).filter(([, n]) => n > 0);
  const unknown = Object.entries(o.unknown_statuses);
  return (
    <div className="bk-result" aria-live="polite">
      <p className="cn-sub">What I understood</p>
      <div className="cn-table-wrap">
        <table className="rt bk-table">
          <caption className="sr-only">The columns I read from your file</caption>
          <thead>
            <tr>
              <th scope="col">I read</th>
              <th scope="col">From your column</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(o.columns).map(([role, header]) => (
              <tr key={role}>
                <th scope="row">{ROLE_WORDS[role] ?? role}</th>
                <td className="bk-mono" data-label="From your column">
                  {header}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {o.identity === null && (
        <p className="cn-note">
          The file has no client id, email or phone I can follow, so I can&rsquo;t see who came
          back. Names alone aren&rsquo;t enough: two clients called Anna would become one.
        </p>
      )}

      <p className="cn-sub">What I counted</p>
      <ul className="cn-list">
        <li>
          {num(o.rows_read)} rows read from your {o.platform_label} export. {num(o.added)} new
          appointments, {num(o.updated)} changed since the last import, {num(o.unchanged)} already
          here and unchanged.
        </li>
        {o.merged_lines > 0 && (
          <li>
            {num(o.merged_lines)} extra lines shared a booking reference with another, so I counted
            each booking once.
          </li>
        )}
        {o.booked_future > 0 && (
          <li>
            {num(o.booked_future)} still to come. They count once they&rsquo;ve happened and you
            import again.
          </li>
        )}
        {o.measured_days && (
          <li>
            Days measured: {day(o.measured_days.from)} to {day(o.measured_days.to)}.
          </li>
        )}
      </ul>

      {(skipped.length > 0 || gaps.length > 0) && (
        <>
          <p className="cn-sub">What I left out</p>
          <ul className="cn-list">
            {skipped.map(([reason, n]) => (
              <li key={reason}>
                <span className="flag drift">Left out</span> {num(n)} row{n === 1 ? "" : "s"}{" "}
                {SKIP_WORDS[reason] ?? reason.replace(/_/g, " ")}.
              </li>
            ))}
            {gaps.map(([gap, n]) => (
              <li key={gap}>
                <span className="flag low">Value left out</span> {num(n)} with{" "}
                {GAP_WORDS[gap] ?? gap}.
              </li>
            ))}
          </ul>
          {unknown.length > 0 && (
            <p className="cn-note">
              Statuses I didn&rsquo;t know:{" "}
              {unknown.map(([word, n]) => `“${word}” (${num(n)})`).join(", ")}. I don&rsquo;t guess
              what they mean.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export function BookingsImportSection() {
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
        setError(errorText(payload, "That file didn't import."));
        return;
      }
      setOutcome(payload);
      if (payload.view && view) setView({ ...view, ...payload.view });
      setCsv("");
      setFileName(null);
    } catch {
      setError("I couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const latest = view?.imports[0] ?? null;

  return (
    <section className="cs bk-card" aria-labelledby="bk-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">Import bookings · read once, nothing written back</p>
          <h2 className="cs-title" id="bk-title">
            Your appointments, from any booking system
          </h2>
        </div>
        {latest && (
          <p className="cs-meta">
            Last import {day(latest.imported_at)} · {latest.platform_label}
          </p>
        )}
      </header>
      <div className="cs-body bk-body">
        <p className="cn-copy">
          Fresha, Mindbody, Booksy, SimplyBook.me, Timely and most others can&rsquo;t be connected,
          but they all export your appointments. Export them as CSV and give me the file. I read the
          date, what happened, the service, the staff member and the price. I keep a one-way code
          for each client so I can tell who came back. I never keep their names, emails or phone
          numbers. If you use Square Appointments, connect Square above with its two appointment
          permissions instead.
        </p>

        {(view?.measures ?? []).map(({ source, measures }) => (
          <div key={source} className="bk-measures">
            <p className="cn-sub">
              {SOURCE_WORDS[source]} · {day(measures.from)} to {day(measures.to)}
            </p>
            <MeasuresTable m={measures} source={source} />
          </div>
        ))}

        <form className="cn-form" onSubmit={(e) => void submit(e)}>
          <label className="cn-field">
            <span className="cn-field-label">Where the export came from</span>
            <select
              className="cn-input"
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              disabled={busy}
            >
              {(view?.platforms ?? [{ id: "fresha", label: "Fresha", verified: false }]).map(
                (p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === "generic" ? "Another booking system, or a spreadsheet" : p.label}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="cn-field">
            <span className="cn-field-label">The export file (CSV)</span>
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
              placeholder={
                "Date,Time,Status,Service,Staff,Client email,Price\n2026-10-01,10:00,Completed,Cut,Kata,anna@example.com,40.00"
              }
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              disabled={busy}
            />
          </label>
          <label className="cn-field">
            <span className="cn-field-label">Currency of the price column</span>
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
          <button className="next" type="submit" disabled={busy || csv.trim() === ""}>
            {busy ? "Reading…" : "Import these bookings"}
          </button>
        </form>
        <p className="cn-note">
          Importing an overlapping export again is safe: appointments I already have are updated,
          not counted twice. Rows I can&rsquo;t read are counted and left out, never guessed.
        </p>

        {outcome !== null && <Counted o={outcome} />}
      </div>
    </section>
  );
}
