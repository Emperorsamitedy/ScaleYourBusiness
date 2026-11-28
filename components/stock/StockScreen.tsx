"use client";

// Insights · Stock — feature 34 and Phase 5 Session A, on the sheet system
// (app/sheet.css). What runs out, and when (P5-05): every item's days of
// cover against its supplier's delivery time, and an order for what runs
// low. Then what isn't selling, most cash tied up first, with the ways to
// free it ranked by what the owner keeps. Read-only: putting an order or
// the options in the queue makes proposals, nothing runs until the owner
// approves it (rule 12), and a reorder reminder is never an order
// (rule 27). P6-04 (rule 27 amended): an order is emailed to the supplier
// only once approved, through the engine. A business without stock never
// reaches this screen through the menu (STOCK_APPLIES).
//
// Said plainly on 2026-11-28 (the canvas design the owner approved): the
// title names the soonest stock-out; one "Order now" card holds each item
// running low beside its order (the reorder note and the purchase order
// were two cards for one thing); "How long each item lasts" is one bar per
// item with a tick at its delivery time and a status word coloured by
// meaning; "Not selling" says what is tied up and ranks the ways to free
// it as likely back, given up and what you keep. The chance bands, the
// working, the cash-by-count chart and the import form fold away. The
// figures and rules are unchanged.
//
// L-3b: the screen's fixed words are the "stock" catalogue; figures in the
// reader's locale. L-4b: what the server words from data (warnings, reasons,
// arithmetic, sources, the season line, held lines, option labels) comes
// worded in the reader's language from /api/stock.

import "../../app/stock.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  CoverBlock,
  CoverItemView,
  PoBlock,
  StockItemView,
  StockView,
} from "../../app/api/stock/route";
import { dayMonth, dayMonthYear, presentMoney } from "../../lib/i18n/format";
import { holidaysInStretch } from "../../lib/signals/view";
import { holidaySource, leadHolidayLine } from "../signals/holiday-words";
import { StockHistoryChart } from "../charts/StockHistoryChart";
import { DraftForm, Orders } from "./PurchaseOrders";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { StockWords } from "./stock-view";
import {
  coverBars,
  itemStatus,
  lastsDays,
  lastsWords,
  leadText,
  plainTitle,
  plainWhy,
  proposalWord,
  statedVsMeasured,
  statusTone,
  statusWord,
} from "./stock-view";

/** The columns the stock-file importer reads (lib/stock/import.ts): its own English header words. */
const IMPORT_COLUMNS = "item or SKU, on hand, unit cost, price, last sold date, units sold";
/** A file the importer reads, as the paste box's example: English headers, as the importer reads them. */
const IMPORT_EXAMPLE =
  "item,on hand,unit cost,price,last sold\nArgan oil 100 ml,14,9.50,24.00,2026-07-02";

function useStockWords(): StockWords {
  return useTr("stock");
}

const pct = (share: number) => `${(share * 100).toFixed(2)}%`;

function Frame({
  title,
  lede,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useStockWords();
  return (
    <main className="screen st-screen">
      <PageHead kicker={tr("kicker")} title={title}>
        {lede && <p className="st-lede">{lede}</p>}
      </PageHead>
      {children}
    </main>
  );
}

/** The line under the title: why order now, what is already out, what is tied up. */
function ledeOf(view: StockView, { tr, locale }: StockWords): string {
  const items = view.cover?.items ?? [];
  const first = items.find((i) => i.warning !== null);
  const lines: string[] = [];
  if (first) {
    lines.push(
      first.lead.supplier
        ? tr("plain.ledeOrder", { supplier: first.lead.supplier, days: first.lead.days })
        : tr("plain.ledeOrderAny", { days: first.lead.days }),
    );
  }
  const out = items.filter((i) => i.flag === "SOLD OUT").map((i) => i.name);
  if (out.length > 0) {
    lines.push(tr("plain.ledeSoldOut", { count: out.length, names: out.join(", ") }));
  }
  const slow = view.slow ?? [];
  const tied = (view.totals ?? []).filter((t) => t.cash_tied_minor > 0);
  if (slow.length > 0 && tied.length > 0) {
    lines.push(
      tr("plain.ledeTied", {
        amount: tied.map((t) => moneyText(t.cash_tied_minor, t.currency, locale)).join(" + "),
        count: slow.length,
      }),
    );
  }
  return lines.join(" ");
}

/* ── Order now ── */

function OrderItem({
  item,
  view,
  windowDays,
}: {
  item: CoverItemView;
  view: StockView;
  windowDays: number;
}) {
  const words = useStockWords();
  const { tr, locale } = words;
  const signals = useTr("signals");
  const d = lastsDays(item, view.today);
  const today = d === null || (d.low === 0 && (d.high ?? 0) === 0);
  const late = d === null || item.lead.days > d.low;
  const holidays = view.today
    ? leadHolidayLine(
        holidaysInStretch(view.cover?.outside ?? null, view.today, item.lead.days),
        signals.tr,
        signals.locale,
      )
    : null;
  const note = item.reorder?.proposal ? statusWord(item.reorder.proposal, tr) : null;
  return (
    <div className="st-oi">
      <p className="st-oi-name">
        {item.name}
        {note && <span className={`word ${note.tone}`}>{note.word}</span>}
      </p>
      {item.sold_recent !== null && item.per_day !== null && (
        <p>
          {tr("order.pace", {
            onHand: item.on_hand,
            day: dayMonth(item.as_of, locale),
            perDay: num(Math.round(item.per_day), 0, locale),
            sold: item.sold_recent,
            window: windowDays,
          })}{" "}
          {today
            ? tr("order.runsToday")
            : d && d.high !== null && d.high !== d.low
              ? tr("order.runsRange", {
                  low: num(d.low, 0, locale),
                  high: num(d.high, 0, locale),
                })
              : tr("order.runsIn", { count: d?.low ?? 0 })}
        </p>
      )}
      <p>
        {item.lead.supplier
          ? tr(late ? "order.late" : "order.inTime", {
              supplier: item.lead.supplier,
              days: item.lead.days,
            })
          : tr(late ? "order.lateAny" : "order.inTimeAny", { days: item.lead.days })}
        {item.boosted && <> {tr("order.boosted")}</>}
      </p>
      {holidays !== null && <p className="st-why">{holidays}</p>}
    </div>
  );
}

function OrderCard({
  view,
  cover,
  po,
  onChange,
  onReorder,
  reordering,
  reordered,
}: {
  view: StockView;
  cover: CoverBlock;
  po: PoBlock | null;
  onChange: () => Promise<void>;
  onReorder: () => void;
  reordering: boolean;
  reordered: string | null;
}) {
  const words = useStockWords();
  const { tr, locale } = words;
  const warned = cover.items.filter((i) => i.reorder !== null);
  const soldOut = cover.items.filter((i) => i.flag === "SOLD OUT" && i.reorder === null);
  const drafted = new Set((po?.drafts ?? []).flatMap((d) => d.lines.map((l) => l.key)));
  const reminders = warned.filter((i) => !drafted.has(i.key));
  const whys = new Map(
    warned.flatMap((i) => {
      const why = plainWhy(i, words);
      return why ? [[i.key, why] as const] : [];
    }),
  );
  const sources = (view.sources ?? []).filter((s) => s.as_of !== null);
  if (warned.length === 0 && soldOut.length === 0 && (po?.orders.length ?? 0) === 0) return null;
  return (
    <SheetCard className="st-card" title={tr("order.title")}>
      {sources.length > 0 && (
        <p className="st-src-line">
          {tr("order.src", {
            source: sources.map((s) => s.label).join(", "),
            day: dayMonth(sources[0]!.as_of!, locale),
          })}
        </p>
      )}
      {po?.held && <p className="st-copy">{po.held}</p>}
      {warned.length > 0 && (
        <div className={(po?.drafts.length ?? 0) > 0 ? "st-order" : undefined}>
          <div>
            {warned.map((i) => (
              <OrderItem key={i.key} item={i} view={view} windowDays={cover.window_days} />
            ))}
            {soldOut.map((i) => (
              <p key={i.key} className="st-also">
                {tr("order.soldOut", {
                  name: i.name,
                  sold: i.sold_recent ?? 0,
                  window: cover.window_days,
                })}
              </p>
            ))}
          </div>
          {po && po.drafts.length > 0 && (
            <div className="st-po-col">
              {po.drafts.map((d) => (
                <DraftForm
                  key={d.supplier.id}
                  draft={d}
                  held={po.held}
                  sending={po.sending}
                  whys={whys}
                  onMade={onChange}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {warned.length === 0 &&
        soldOut.map((i) => (
          <p key={i.key} className="st-copy">
            {tr("order.soldOut", {
              name: i.name,
              sold: i.sold_recent ?? 0,
              window: cover.window_days,
            })}
          </p>
        ))}
      {reminders.length > 0 && (
        <div className="st-remind">
          <p className="st-copy">
            {tr("order.noSupplier", { items: reminders.map((i) => i.name).join(", ") })}{" "}
            <Link href="/profile">{tr("factSheet")}</Link>
          </p>
          <button
            type="button"
            className="act"
            disabled={
              reordering || cover.held !== null || reminders.every((i) => i.reorder?.proposal)
            }
            onClick={onReorder}
          >
            {reordering ? tr("workingItOut") : tr("order.remind")}
          </button>
          <p className="st-why">{cover.held ?? tr("order.remindAfter")}</p>
          {reordered && (
            <p className="st-copy">
              {reordered} <Link href="/proposals">{tr("waitingForYou")}</Link>
            </p>
          )}
        </div>
      )}
      {po && po.orders.length > 0 && (
        <div className="st-made">
          <h3 className="st-h3">{tr("order.made")}</h3>
          <Orders block={po} onChange={onChange} />
        </div>
      )}
    </SheetCard>
  );
}

/* ── How long each item lasts ── */

function LastsCard({ view, cover }: { view: StockView; cover: CoverBlock }) {
  const words = useStockWords();
  const { tr, locale } = words;
  const bars = coverBars(cover.items, view.today);
  const slowKeys = new Set((view.slow ?? []).filter((s) => s.flag === "SLOW").map((s) => s.key));
  const leads = [...new Set(cover.items.map((i) => i.lead.days))];
  return (
    <SheetCard className="st-card" title={tr("lasts.title")}>
      <p className="st-src-line">{tr("lasts.src")}</p>
      <table className="st-lasts">
        <thead>
          <tr>
            <th scope="col">{tr("col.item")}</th>
            <th scope="col" className="num">
              {tr("lasts.colStock")}
            </th>
            <th scope="col" className="num">
              {tr("lasts.colSold", { days: cover.window_days })}
            </th>
            <th scope="col" className="st-barc">
              {tr("lasts.colLasts")}
            </th>
            <th scope="col">
              <span className="sr-only">{tr("lasts.colDays")}</span>
            </th>
            <th scope="col">
              <span className="sr-only">{tr("lasts.colStatus")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {cover.items.map((item, k) => {
            const bar = bars[k] ?? null;
            const status = itemStatus(item, slowKeys);
            return (
              <tr key={item.key}>
                <th scope="row">{item.name}</th>
                <td className="num" data-label={tr("lasts.colStock")}>
                  {num(item.on_hand, 0, locale)}
                </td>
                <td className="num" data-label={tr("lasts.colSold", { days: cover.window_days })}>
                  {item.sold_recent === null ? "-" : num(item.sold_recent, 0, locale)}
                </td>
                <td className="st-barc" aria-hidden="true">
                  <span className="st-track">
                    {bar && (
                      <>
                        {bar.high !== null && bar.high > bar.low && (
                          <span
                            className={`st-fill st-rest st-${statusTone(status)}`}
                            style={{ width: pct(bar.high) }}
                          />
                        )}
                        <span
                          className={`st-fill st-${statusTone(status)}`}
                          style={{ width: pct(Math.max(bar.low, 0.012)) }}
                        />
                        <span className="st-tick" style={{ left: pct(bar.lead) }} />
                      </>
                    )}
                  </span>
                </td>
                <td className="st-lw" data-label={tr("lasts.colLasts")}>
                  {lastsWords(item, view.today, words)}
                </td>
                <td className={`st-status st-${statusTone(status)}-word`}>
                  {tr(`status.${status}`)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="st-key">
        <i aria-hidden="true" />
        {leads.length === 1 ? tr("lasts.keyOne", { days: leads[0]! }) : tr("lasts.key")}{" "}
        {tr("lasts.keyPale")}
      </p>
    </SheetCard>
  );
}

/* ── Not selling ── */

/** Money in whole units: the ways are estimates, and cents would claim a precision they lack. */
function money(minor: number, currency: string | null, locale: StockWords["locale"]): string {
  return currency === null
    ? "-"
    : presentMoney({ amount_minor: minor, currency }, locale, { whole: true });
}

function SlowCard({
  view,
  onPropose,
  proposing,
  proposed,
}: {
  view: StockView;
  onPropose: () => void;
  proposing: boolean;
  proposed: string | null;
}) {
  const words = useStockWords();
  const { tr, locale } = words;
  const slow = view.slow ?? [];
  const tied = (view.totals ?? []).filter((t) => t.cash_tied_minor > 0);
  const lead = slow[0];
  if (!lead) return null;
  const blocked = lead.options.find((o) => o.proposal?.status === "blocked");
  const line = (s: StockItemView) =>
    s.days_of_cover !== null && s.sold[90] !== null
      ? tr("slow.lineSlow", {
          onHand: s.on_hand,
          sold: s.sold[90],
          months: Math.max(1, Math.round(s.days_of_cover / 30)),
        })
      : tr("slow.lineStuck", {
          onHand: s.on_hand,
          days: s.no_sale_for_at_least ?? s.days_since_sale ?? 0,
        });
  return (
    <SheetCard
      className="st-card"
      title={tr("slow.plainTitle", {
        amount: tied.map((t) => moneyText(t.cash_tied_minor, t.currency, locale)).join(" + "),
      })}
    >
      <p className="st-src-line">{tr("slow.plainSrc")}</p>
      <div className="st-tiles">
        {slow.map((s) => (
          <div key={s.key} className="st-tile">
            <p className="st-tile-name">{s.name}</p>
            <p>{line(s)}</p>
            <p className="st-tile-fig">
              {s.cash_tied_minor === null
                ? tr("view.unknown")
                : money(s.cash_tied_minor, s.currency, locale)}
              {s.cost_basis === "stated" && <span className="st-src">{tr("yourCost")}</span>}
            </p>
          </div>
        ))}
      </div>
      <h3 className="st-h3">{tr("ways.title", { name: lead.name })}</h3>
      <table className="st-ways">
        <thead>
          <tr>
            <th scope="col">{tr("ways.colWay")}</th>
            <th scope="col" className="num">
              {tr("ways.colBack")}
            </th>
            <th scope="col" className="num">
              {tr("ways.colGiven")}
            </th>
            <th scope="col" className="num">
              {tr("ways.colKeep")}
            </th>
          </tr>
        </thead>
        <tbody>
          {lead.options.map((o) => {
            const w = proposalWord(o, tr);
            const net = o.recovered.expected - o.given_up.expected;
            if (o.unavailable !== null) {
              return (
                <tr key={o.key} className="st-off">
                  <th scope="row">{o.label}</th>
                  <td colSpan={3}>{tr("ranking.cantPropose", { why: o.unavailable })}</td>
                </tr>
              );
            }
            return (
              <tr key={o.key} className={net < 0 ? "st-neg" : undefined}>
                <th scope="row">
                  {o.label}
                  {w && <span className={`word ${w.tone}`}>{w.word}</span>}
                </th>
                <td className="num" data-label={tr("ways.colBack")}>
                  {money(o.recovered.expected, lead.currency, locale)}
                </td>
                <td className="num" data-label={tr("ways.colGiven")}>
                  {o.given_up.expected === 0
                    ? tr("ways.nothing")
                    : money(o.given_up.expected, lead.currency, locale)}
                </td>
                <td className="num st-keep" data-label={tr("ways.colKeep")}>
                  {net < 0
                    ? tr("ways.loses", { amount: money(-net, lead.currency, locale) })
                    : money(net, lead.currency, locale)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {slow.slice(1).map((s) => {
        const best = Math.max(
          0,
          ...s.options
            .filter((o) => o.unavailable === null)
            .map((o) => o.recovered.expected - o.given_up.expected),
        );
        return best > 0 ? (
          <p key={s.key} className="st-why">
            {tr("ways.others", { amount: money(best, s.currency, locale), name: s.name })}
          </p>
        ) : null;
      })}
      <p className="st-why">{tr("ways.yourself")}</p>
      {blocked && (
        <p className="st-copy">
          {tr("ranking.blocked", {
            option: blocked.label_inline ?? blocked.label.toLocaleLowerCase(),
          })}
        </p>
      )}
      <div className="st-act-row">
        <button
          type="button"
          className="act"
          disabled={proposing || view.held !== null}
          onClick={onPropose}
        >
          {proposing ? tr("workingItOut") : tr("slow.plainButton")}
        </button>
        <span className="st-why">
          {view.held ??
            tr("slow.plainAfter", {
              count: Math.min(slow.length, view.thresholds?.max_items ?? 3),
            })}
        </span>
      </div>
      {proposed && (
        <p className="st-copy">
          {proposed} <Link href="/proposals">{tr("waitingForYou")}</Link>
        </p>
      )}
    </SheetCard>
  );
}

/* ── the method, folded ── */

function HowFold({ view }: { view: StockView }) {
  const words = useStockWords();
  const sentences = useTr("stockWords");
  const signals = useTr("signals");
  const { tr, locale } = words;
  const cover = view.cover;
  const th = view.thresholds;
  const svm = statedVsMeasured(view, sentences);
  const outside = cover?.outside ?? null;
  const anyHoliday =
    !!view.today &&
    (cover?.items ?? []).some(
      (i) => holidaysInStretch(outside, view.today!, i.lead.days).length > 0,
    );
  return (
    <Fold className="st-how" summary={tr("plain.how")}>
      <ul className="st-list">
        {cover && (
          <>
            <li>
              {tr("cover.meta", {
                days: num(cover.window_days, 0, locale),
                lead: num(cover.default_lead_days, 0, locale),
              })}
            </li>
            <li>{cover.season}</li>
            {anyHoliday && <li>{holidaySource(outside, signals.tr, signals.locale)}</li>}
            {cover.items.map((i) => (
              <li key={i.key}>
                <b>{i.name}</b> {i.sell_through} {leadText(i, words)}.{i.why && <> {i.why}</>}
                {i.reorder && (
                  <>
                    {" "}
                    {i.reorder.arithmetic} {i.reorder.cost_arithmetic}
                  </>
                )}
                {i.assumed.length > 0 && <> {i.assumed.join("; ")}.</>}
              </li>
            ))}
          </>
        )}
        {th && (view.slow ?? []).length > 0 && (
          <li>
            {tr("slow.meta", {
              stuck: tr("flag.stuck"),
              stuckDays: num(th.stuck_no_sale_days, 0, locale),
              slow: tr("flag.slow"),
              slowDays: num(th.slow_cover_days, 0, locale),
            })}
          </li>
        )}
        {(view.slow ?? []).map((s) => (
          <li key={s.key}>
            <b>{s.name}</b> {s.why}.{" "}
            {s.options
              .filter((o) => o.unavailable === null)
              .map((o) => `${o.label}: ${o.arithmetic}`)
              .join(" ")}
          </li>
        ))}
        {svm && <li>{svm}</li>}
      </ul>
      {view.history && <StockHistoryChart model={view.history} />}
    </Fold>
  );
}

function ImportCard({ onDone }: { onDone: () => void }) {
  const { tr } = useStockWords();
  const [csv, setCsv] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [windowDays, setWindowDays] = useState("90");
  const [asOf, setAsOf] = useState("");
  const [decimalStyle, setDecimalStyle] = useState<"" | "dot_decimal" | "comma_decimal">("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "import",
          csv,
          currency,
          window_days: windowDays,
          as_of: asOf,
          ...(decimalStyle !== "" ? { decimal_style: decimalStyle } : {}),
        }),
      });
      const body = (await res.json()) as {
        error?: string;
        imported?: number;
        skipped?: Record<string, number>;
        unreadable?: Record<string, number>;
      };
      if (!res.ok) {
        setNote(body.error ?? tr("import.failed"));
        return;
      }
      const left = Object.values(body.skipped ?? {}).reduce((s, n) => s + n, 0);
      const blank = Object.values(body.unreadable ?? {}).reduce((s, n) => s + n, 0);
      setNote(
        [
          tr("import.imported", { count: body.imported ?? 0 }),
          ...(left > 0 ? [tr("import.leftOut", { count: left })] : []),
          ...(blank > 0 ? [tr("import.blank", { count: blank })] : []),
        ].join(" "),
      );
      setCsv("");
      onDone();
    } catch {
      setNote(tr("import.ourSide"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetCard
      label={tr("import.label")}
      title={tr("import.title")}
      foot={tr("import.foot", { columns: IMPORT_COLUMNS })}
    >
      <div className="st-form">
        <label className="st-field st-wide">
          <span className="label">{tr("import.paste")}</span>
          <textarea
            rows={4}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={IMPORT_EXAMPLE}
          />
        </label>
        <label className="st-field">
          <span className="label">{tr("import.currency")}</span>
          <input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </label>
        <label className="st-field">
          <span className="label">{tr("import.window")}</span>
          <input
            inputMode="numeric"
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
          />
        </label>
        <label className="st-field">
          <span className="label">{tr("import.countedOn")}</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label className="st-field">
          <span className="label">{tr("import.decimalStyle", { example: "1.200" })}</span>
          <select
            value={decimalStyle}
            onChange={(e) =>
              setDecimalStyle(e.target.value as "" | "dot_decimal" | "comma_decimal")
            }
            disabled={busy}
          >
            <option value="">{tr("import.decimalAuto")}</option>
            <option value="dot_decimal">{tr("import.dotDecimal", { example: "1,234.56" })}</option>
            <option value="comma_decimal">
              {tr("import.commaDecimal", { example: "1.234,56" })}
            </option>
          </select>
        </label>
        <button type="button" className="act" disabled={busy || csv.trim() === ""} onClick={submit}>
          {busy ? tr("import.importing") : tr("import.button")}
        </button>
      </div>
      {busy && (
        <p className="st-copy live">
          <span className="live-dot" aria-hidden="true" /> {tr("import.readingFile")}
        </p>
      )}
      {note && <p className="st-copy">{note}</p>}
    </SheetCard>
  );
}

/** What the queue said back, in words: how many now wait, and how many a rule blocked. */
function resultWords(
  tr: StockWords["tr"],
  body: { created?: number; blocked?: number; skipped?: { reason: string }[] },
  kind: "proposals" | "notes",
): string {
  const c = body.created ?? 0;
  const b = body.blocked ?? 0;
  if (c + b === 0) {
    const why = body.skipped?.[0]?.reason;
    return why ? tr("result.nothingNewWhy", { reason: why }) : tr("result.nothingNew");
  }
  return b > 0
    ? tr(`result.${kind}Blocked`, { count: c, blocked: b })
    : tr(`result.${kind}`, { count: c });
}

export function StockScreen() {
  const words = useStockWords();
  const sentences = useTr("stockWords");
  const { tr, locale } = words;
  const rich = useTranslations("stock");
  const [view, setView] = useState<StockView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposed, setProposed] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  const [reordered, setReordered] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/stock");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as StockView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const post = async (
    action: "propose" | "reorder",
    kind: "proposals" | "notes",
    setBusy: (b: boolean) => void,
    setSaid: (s: string | null) => void,
  ) => {
    setBusy(true);
    setSaid(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json()) as {
        error?: string;
        created?: number;
        blocked?: number;
        skipped?: { reason: string }[];
      };
      if (!res.ok) setSaid(body.error ?? tr("result.didntWork"));
      else {
        setSaid(resultWords(tr, body, kind));
        await load();
      }
    } catch {
      setSaid(tr("result.ourSide"));
    } finally {
      setBusy(false);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut")}>
        <p className="st-wait">
          {rich.rich("startInterview", { link: (c) => <Link href="/start">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("failedTitle")}>
        <p className="st-wait">{tr("failedBody")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("reading")} />;
  if (!view.applies) {
    return (
      <Frame title={tr("noStockTitle")}>
        <p className="st-wait">
          {tr("noStockBody")} <Link href="/profile">{tr("factSheet")}</Link>
        </p>
      </Frame>
    );
  }

  const slow = view.slow ?? [];
  const sources = (view.sources ?? []).filter((s) => s.as_of !== null);
  const th = view.thresholds;
  const stuckDays = num(th?.stuck_no_sale_days ?? 60, 0, locale);
  const slowDays = num(th?.slow_cover_days ?? 180, 0, locale);
  const cover = view.cover && view.cover.items.length > 0 ? view.cover : null;

  return (
    <Frame title={plainTitle(view, words, sentences)} lede={ledeOf(view, words) || undefined}>
      {cover && (
        <OrderCard
          view={view}
          cover={cover}
          po={view.purchase_orders ?? null}
          onChange={load}
          onReorder={() => void post("reorder", "notes", setReordering, setReordered)}
          reordering={reordering}
          reordered={reordered}
        />
      )}
      {cover && <LastsCard view={view} cover={cover} />}
      {slow.length > 0 ? (
        <SlowCard
          view={view}
          onPropose={() => void post("propose", "proposals", setProposing, setProposed)}
          proposing={proposing}
          proposed={proposed}
        />
      ) : (
        <SheetCard
          className="st-card"
          title={sources.length === 0 ? tr("nothingRead") : tr("slow.nothingSlow")}
        >
          <p className="st-copy">
            {sources.length === 0
              ? tr("slow.connect")
              : tr("slow.allSelling", { stuckDays, slowDays })}{" "}
            {sources.length === 0 && <Link href="/connections">{tr("slow.connections")}</Link>}
          </p>
        </SheetCard>
      )}
      {sources.length > 0 && (
        <p className="st-read">
          {tr("plain.read", {
            sources: sources
              .map((s) => `${s.label} ${s.as_of ? dayMonthYear(s.as_of, locale) : ""}`.trim())
              .join(", "),
          })}
        </p>
      )}
      <HowFold view={view} />
      <Fold className="st-how" summary={tr("plain.importFold")}>
        <ImportCard onDone={() => void load()} />
      </Fold>
    </Frame>
  );
}
