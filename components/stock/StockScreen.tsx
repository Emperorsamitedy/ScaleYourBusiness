"use client";

// Insights · Stock — feature 34 and Phase 5 Session A, on the sheet system
// (app/sheet.css). First what runs out, and when (P5-05): every item's days
// of cover against its supplier's delivery time, the warnings, and a
// reorder note per warned item with its arithmetic. Then what isn't
// selling, most cash tied up first, each item's ways to clear it ranked by
// cash likely back per euro given up. Read-only: putting notes or options
// in the queue makes proposals, nothing runs until the owner approves it
// (rule 12), and a reorder note is never an order (rule 27). P6-04 (rule 27
// amended): a reorder suggestion can become a purchase order the owner
// makes here (./PurchaseOrders), emailed to the supplier only once approved,
// through the engine. A business
// without stock never reaches this screen through the menu (STOCK_APPLIES).
//
// L-3b: the screen's fixed words are the "stock" catalogue; figures in the
// reader's locale. L-4b: what the server words from data (warnings, reasons,
// arithmetic, sources, the season line, held lines, option labels and
// efficiencies) comes worded in the reader's language from /api/stock, and
// the headlines built here are the "stockWords" catalogue.

import "../../app/stock.css";
import "../../app/viz.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type {
  CoverBlock,
  CoverItemView,
  StockItemView,
  StockView,
} from "../../app/api/stock/route";
import { dayMonthYear } from "../../lib/i18n/format";
import { intlTag } from "../../lib/i18n/locales";
import { StockHistoryChart } from "../charts/StockHistoryChart";
import { PurchaseOrdersCard } from "./PurchaseOrders";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { StockWords } from "./stock-view";
import {
  cashBars,
  cashText,
  coverBars,
  coverFlagClass,
  coverText,
  flagClass,
  flagLower,
  flagWord,
  leadText,
  moneyLine,
  proposalWord,
  quietText,
  statedVsMeasured,
  statusWord,
  stockHeadline,
  vsPriorText,
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
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useStockWords();
  return (
    <main className="screen st-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
    </main>
  );
}

function SlowTable({ items }: { items: StockItemView[] }) {
  const words = useStockWords();
  const { tr, locale } = words;
  const sold = tr("col.sold", { days: num(90, 0, locale) });
  const bars = cashBars(items);
  const drawn = bars.some((b) => b !== null);
  return (
    <div className="st-table-wrap" tabIndex={0} aria-label={tr("slowTable")}>
      <table className="rt rt-stack st-table">
        <thead>
          <tr>
            <th scope="col">{tr("col.item")}</th>
            <th scope="col" className="num">
              {tr("col.onHand")}
            </th>
            <th scope="col" className="num">
              {sold}
            </th>
            <th scope="col" className="num">
              {tr("col.cover")}
            </th>
            <th scope="col" className="num">
              {tr("col.sinceSale")}
            </th>
            <th scope="col" className="num">
              {tr("col.cashTied")}
            </th>
            {drawn && <th aria-hidden="true" />}
            <th scope="col">{tr("col.flag")}</th>
            <th scope="col">{tr("col.ways")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, k) => {
            const usable = item.options.filter((o) => o.unavailable === null).slice(0, 3);
            const bar = bars[k] ?? null;
            return (
              <tr key={item.key}>
                <th scope="row">
                  {item.name}
                  <span className="st-src">{item.source}</span>
                </th>
                <td className="num" data-label={tr("col.onHand")}>
                  {num(item.on_hand, 0, locale)}
                </td>
                <td className="num" data-label={sold}>
                  {item.sold[90] === null ? "—" : num(item.sold[90], 0, locale)}
                </td>
                <td className="num" data-label={tr("col.cover")}>
                  {coverText(item, words)}
                </td>
                <td className="num" data-label={tr("col.sinceSale")}>
                  {quietText(item, locale)}
                </td>
                <td className="num" data-label={tr("col.cashTied")}>
                  {cashText(item.cash_tied_minor, item.currency, words)}
                  {item.cost_basis === "stated" && <span className="st-src">{tr("yourCost")}</span>}
                </td>
                {drawn && (
                  <td className="st-bar" aria-hidden="true">
                    {bar && (
                      <span className="vz-bar-track">
                        <span
                          className={`vz-bar-fill vz-${bar.tone}`}
                          style={{ left: 0, width: pct(bar.share) }}
                        />
                      </span>
                    )}
                  </td>
                )}
                <td data-label={tr("col.flag")}>
                  <span className={`flag ${flagClass(item.flag)}`}>{flagWord(item.flag, tr)}</span>
                </td>
                <td data-label={tr("col.ways")}>
                  <ol className="st-opts">
                    {usable.map((o) => {
                      const w = proposalWord(o, tr);
                      return (
                        <li key={o.key}>
                          <span>{o.label}</span>
                          {w && <span className={`word ${w.tone}`}>{w.word}</span>}
                        </li>
                      );
                    })}
                    {usable.length === 0 && <li className="st-none">{tr("nothingToPropose")}</li>}
                  </ol>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CoverTable({ cover, today }: { cover: CoverBlock; today: string | undefined }) {
  const words = useStockWords();
  const { tr, locale } = words;
  const n = num(cover.window_days, 0, locale);
  const sold = tr("col.sold", { days: n });
  const vsPrior = tr("col.vsPrior", { days: n });
  const bars = coverBars(cover.items, today);
  const drawn = bars.some((b) => b !== null);
  return (
    <>
      <div className="st-table-wrap" tabIndex={0} aria-label={tr("coverTable")}>
        <table className="rt rt-stack st-table">
          <thead>
            <tr>
              <th scope="col">{tr("col.item")}</th>
              <th scope="col" className="num">
                {tr("col.onHand")}
              </th>
              <th scope="col" className="num">
                {sold}
              </th>
              <th scope="col" className="num">
                {vsPrior}
              </th>
              <th scope="col" className="num">
                {tr("col.cover")}
              </th>
              {drawn && <th aria-hidden="true" />}
              <th scope="col">{tr("col.delivery")}</th>
              <th scope="col">{tr("col.flag")}</th>
            </tr>
          </thead>
          <tbody>
            {cover.items.map((item, k) => {
              const bar = bars[k] ?? null;
              return (
                <tr key={item.key}>
                  <th scope="row">
                    {item.name}
                    <span className="st-src">{item.source}</span>
                  </th>
                  <td className="num" data-label={tr("col.onHand")}>
                    {num(item.on_hand, 0, locale)}
                  </td>
                  <td className="num" data-label={sold}>
                    {item.sold_recent === null ? "—" : num(item.sold_recent, 0, locale)}
                  </td>
                  <td className="num" data-label={vsPrior} title={item.sell_through}>
                    {vsPriorText(item, words)}
                    {item.vs_prior && item.vs_prior.band > 0 && (
                      <span className="st-src">
                        {tr("chance", { band: num(item.vs_prior.band, 0, locale) })}
                      </span>
                    )}
                  </td>
                  <td className="num" data-label={tr("col.cover")} title={item.why ?? item.sources}>
                    {item.cover_text}
                    {item.boosted && <span className="st-src">{tr("boosted")}</span>}
                  </td>
                  {drawn && (
                    <td className="st-bar" aria-hidden="true">
                      {bar && (
                        <span className="vz-bar-track">
                          {bar.high !== null && bar.high > bar.low && (
                            <span
                              className={`vz-bar-rest vz-${bar.tone}`}
                              style={{ left: 0, width: pct(bar.high) }}
                            />
                          )}
                          <span
                            className={`vz-bar-fill vz-${bar.tone}`}
                            style={{ left: 0, width: pct(bar.low) }}
                          />
                          <span className="vz-bar-ref" style={{ left: pct(bar.lead) }} />
                        </span>
                      )}
                    </td>
                  )}
                  <td data-label={tr("col.delivery")} title={item.lead.why}>
                    <span className="st-mono">{leadText(item, words)}</span>
                  </td>
                  <td data-label={tr("col.flag")}>
                    <span className={`flag ${coverFlagClass(item.flag)}`}>
                      {flagWord(item.flag, tr)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {drawn && (
        <p className="vz-ref-note">
          <i aria-hidden="true" />
          {tr("col.delivery")}
        </p>
      )}
    </>
  );
}

function ReorderNote({ item }: { item: CoverItemView }) {
  const words = useStockWords();
  const { tr, locale } = words;
  const r = item.reorder!;
  const w = r.proposal ? statusWord(r.proposal, tr) : null;
  const quantity = num(r.quantity, 0, locale);
  return (
    <SheetCard
      label={tr("reorder.label", { flag: flagLower(item.flag, words) })}
      title={
        item.lead.supplier
          ? tr("reorder.titleFrom", { name: item.name, quantity, supplier: item.lead.supplier })
          : tr("reorder.title", { name: item.name, quantity })
      }
      meta={tr("reorder.meta")}
    >
      <p className="st-copy st-warn">
        {item.warning}
        {w && <span className={`word ${w.tone}`}>{w.word}</span>}
      </p>
      <p className="st-rank-math">{r.arithmetic}</p>
      {r.cost && (
        <p className="st-rank-fig">
          {moneyLine(r.cost, words)}
          {r.cost_arithmetic && <span className="st-src">{r.cost_arithmetic}</span>}
        </p>
      )}
      <p className="st-rank-math">{tr("reorder.sources", { sources: item.sources })}</p>
      {item.assumed.length > 0 && (
        <ul className="st-assumed">
          {item.assumed.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      {r.proposal?.status === "blocked" && r.proposal.blocked_by_limit && (
        <p className="st-rank-math">{tr("ruledOut", { rule: r.proposal.blocked_by_limit })}</p>
      )}
      <p className="st-copy">{tr("reorder.approving")}</p>
    </SheetCard>
  );
}

function CoverCard({
  cover,
  today,
  onReorder,
  busy,
  note,
}: {
  cover: CoverBlock;
  today: string | undefined;
  onReorder: () => void;
  busy: boolean;
  note: string | null;
}) {
  const { tr, locale } = useStockWords();
  const warned = cover.items.filter((i) => i.reorder !== null);
  const waiting = warned.every((i) => i.reorder?.proposal);
  return (
    <SheetCard
      label={tr("cover.label", {
        warned: num(cover.warnings, 0, locale),
        total: num(cover.items.length, 0, locale),
      })}
      title={cover.warnings > 0 ? tr("cover.titleWarned") : tr("cover.titleNone")}
      meta={tr("cover.meta", {
        days: num(cover.window_days, 0, locale),
        lead: num(cover.default_lead_days, 0, locale),
      })}
      foot={
        warned.length > 0 ? (
          <span className="st-foot-row">
            <span>{cover.held ?? tr("cover.held")}</span>
            <button
              type="button"
              className="act"
              disabled={busy || cover.held !== null || waiting}
              onClick={onReorder}
            >
              {busy ? tr("workingItOut") : tr("cover.button")}
            </button>
          </span>
        ) : undefined
      }
    >
      <CoverTable cover={cover} today={today} />
      <p className="st-copy">{cover.season}</p>
      {busy && (
        <p className="st-copy live">
          <span className="live-dot" aria-hidden="true" /> {tr("cover.working")}
        </p>
      )}
      {note && (
        <p className="st-copy">
          {note} <Link href="/proposals">{tr("waitingForYou")}</Link>
        </p>
      )}
    </SheetCard>
  );
}

function Ranking({ item }: { item: StockItemView }) {
  const words = useStockWords();
  const { tr, locale } = words;
  const blocked = item.options.find((o) => o.proposal?.status === "blocked");
  return (
    <SheetCard
      label={tr("ranking.label", { flag: flagLower(item.flag, words), why: item.why })}
      title={tr("ranking.title", { name: item.name })}
      meta={tr("ranking.meta")}
    >
      <ol className="st-rank">
        {item.options.map((o, i) => {
          const w = proposalWord(o, tr);
          return (
            <li key={o.key} className={o.unavailable !== null ? "off" : undefined}>
              <span className="n">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <p className="st-rank-head">
                  <strong>{o.label}</strong>
                  {w && <span className={`word ${w.tone}`}>{w.word}</span>}
                </p>
                <p className="st-rank-fig">
                  {o.unavailable !== null
                    ? tr("ranking.cantPropose", { why: o.unavailable })
                    : o.efficiency}
                </p>
                {o.unavailable === null && <p className="st-rank-math">{o.arithmetic}</p>}
                {o.proposal?.status === "blocked" && o.proposal.blocked_by_limit && (
                  <p className="st-rank-math">
                    {tr("ruledOut", { rule: o.proposal.blocked_by_limit })}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {blocked && (
        <p className="st-copy">
          {tr("ranking.blocked", {
            option: blocked.label_inline ?? blocked.label.toLocaleLowerCase(intlTag(locale)),
          })}
        </p>
      )}
    </SheetCard>
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

  const propose = async () => {
    setProposing(true);
    setProposed(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose" }),
      });
      const body = (await res.json()) as {
        error?: string;
        created?: number;
        blocked?: number;
        skipped?: { reason: string }[];
      };
      if (!res.ok) setProposed(body.error ?? tr("result.didntWork"));
      else {
        setProposed(resultWords(tr, body, "proposals"));
        await load();
      }
    } catch {
      setProposed(tr("result.ourSide"));
    } finally {
      setProposing(false);
    }
  };

  const reorder = async () => {
    setReordering(true);
    setReordered(null);
    try {
      const res = await fetch("/api/stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reorder" }),
      });
      const body = (await res.json()) as {
        error?: string;
        created?: number;
        blocked?: number;
        skipped?: { reason: string }[];
      };
      if (!res.ok) setReordered(body.error ?? tr("result.didntWork"));
      else {
        setReordered(resultWords(tr, body, "notes"));
        await load();
      }
    } catch {
      setReordered(tr("result.ourSide"));
    } finally {
      setReordering(false);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut")}>
        <p className="st-wait">
          {rich.rich("startInterview", { link: (c) => <Link href="/intake">{c}</Link> })}
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
  const aside = (
    <>
      {sources.length === 0
        ? tr("nothingRead")
        : sources
            .map((s) => `${s.label} ${s.as_of ? dayMonthYear(s.as_of, locale) : ""}`.trim())
            .join(" · ")}{" "}
      · {tr("measured")}
    </>
  );
  const th = view.thresholds;
  const svm = statedVsMeasured(view, sentences);
  const stuckDays = num(th?.stuck_no_sale_days ?? 60, 0, locale);
  const slowDays = num(th?.slow_cover_days ?? 180, 0, locale);
  const stuck = flagWord("STUCK", tr);
  const slowWord = flagWord("SLOW", tr);

  return (
    <Frame title={stockHeadline(view, sentences)} aside={aside}>
      {view.cover && view.cover.items.length > 0 && (
        <>
          <CoverCard
            cover={view.cover}
            today={view.today}
            onReorder={() => void reorder()}
            busy={reordering}
            note={reordered}
          />
          {view.cover.items.some((i) => i.reorder !== null) && (
            <div className="st-grid">
              {view.cover.items
                .filter((i) => i.reorder !== null)
                .slice(0, 4)
                .map((i) => (
                  <ReorderNote key={i.key} item={i} />
                ))}
            </div>
          )}
        </>
      )}

      {view.purchase_orders &&
        (view.purchase_orders.drafts.length > 0 ||
          view.purchase_orders.orders.length > 0 ||
          view.purchase_orders.unsupplied.length > 0) && (
          <PurchaseOrdersCard block={view.purchase_orders} onChange={load} />
        )}

      {slow.length > 0 ? (
        <SheetCard
          label={tr("slow.label", {
            slow: num(slow.length, 0, locale),
            counted: num(view.counted ?? 0, 0, locale),
          })}
          title={tr("slow.title")}
          meta={
            th
              ? tr("slow.meta", {
                  stuck,
                  stuckDays: num(th.stuck_no_sale_days, 0, locale),
                  slow: slowWord,
                  slowDays: num(th.slow_cover_days, 0, locale),
                })
              : undefined
          }
          foot={
            <span className="st-foot-row">
              <span>
                {view.held ?? tr("slow.held", { count: num(th?.max_items ?? 3, 0, locale) })}
              </span>
              <button
                type="button"
                className="act"
                disabled={proposing || view.held !== null}
                onClick={propose}
              >
                {proposing ? tr("workingItOut") : tr("slow.button")}
              </button>
            </span>
          }
        >
          <SlowTable items={slow} />
          {proposing && (
            <p className="st-copy live">
              <span className="live-dot" aria-hidden="true" /> {tr("slow.working")}
            </p>
          )}
          {proposed && (
            <p className="st-copy">
              {proposed} <Link href="/proposals">{tr("waitingForYou")}</Link>
            </p>
          )}
        </SheetCard>
      ) : (
        <SheetCard
          label={tr("slow.emptyLabel")}
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

      {view.history && <StockHistoryChart model={view.history} />}

      <div className="st-grid">
        {slow[0] ? (
          <Ranking item={slow[0]} />
        ) : (
          <SheetCard label={tr("judge.label")} title={tr("judge.title")}>
            <p className="st-copy">
              {tr("judge.body", { stuck, stuckDays, slow: slowWord, slowDays })}
            </p>
          </SheetCard>
        )}
        <ImportCard onDone={() => void load()} />
      </div>

      {(svm || slow.length > 1) && (
        <div className="st-grid">
          {slow.slice(1, 3).map((item) => (
            <Ranking key={item.key} item={item} />
          ))}
          {svm && (
            <SheetCard label={tr("svm.label")} title={tr("svm.title")}>
              <p className="st-copy">{svm}</p>
            </SheetCard>
          )}
        </div>
      )}
    </Frame>
  );
}
