"use client";

// Insights · Stock — feature 34 and Phase 5 Session A, on the sheet system
// (app/sheet.css). First what runs out, and when (P5-05): every item's days
// of cover against its supplier's delivery time, the warnings, and a
// reorder note per warned item with its arithmetic. Then what isn't
// selling, most cash tied up first, each item's ways to clear it ranked by
// cash likely back per euro given up. Read-only: putting notes or options
// in the queue makes proposals, nothing runs until the owner approves it
// (rule 12), and a reorder note is never an order (rule 27). A business
// without stock never reaches this screen through the menu (STOCK_APPLIES).

import "../../app/stock.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import type {
  CoverBlock,
  CoverItemView,
  StockItemView,
  StockView,
} from "../../app/api/stock/route";
import { StockHistoryChart } from "../charts/StockHistoryChart";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import {
  cashText,
  coverFlagClass,
  coverText,
  flagClass,
  leadText,
  moneyLine,
  proposalWord,
  quietText,
  statedVsMeasured,
  statusWord,
  stockHeadline,
  vsPriorText,
} from "./stock-view";

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="screen st-screen">
      <PageHead kicker="Insights · Stock" title={title} aside={aside} />
      {children}
    </main>
  );
}

function SlowTable({ items }: { items: StockItemView[] }) {
  return (
    <div className="st-table-wrap" tabIndex={0} aria-label="Stock that isn't selling">
      <table className="rt rt-stack st-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="num">
              On hand
            </th>
            <th scope="col" className="num">
              Sold 90 d
            </th>
            <th scope="col" className="num">
              Days of cover
            </th>
            <th scope="col" className="num">
              Days since sale
            </th>
            <th scope="col" className="num">
              Cash tied up
            </th>
            <th scope="col">Flag</th>
            <th scope="col">Cheapest ways to clear it</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const usable = item.options.filter((o) => o.unavailable === null).slice(0, 3);
            return (
              <tr key={item.key}>
                <th scope="row">
                  {item.name}
                  <span className="st-src">{item.source}</span>
                </th>
                <td className="num" data-label="On hand">
                  {num(item.on_hand)}
                </td>
                <td className="num" data-label="Sold 90 d">
                  {item.sold[90] === null ? "—" : num(item.sold[90])}
                </td>
                <td className="num" data-label="Days of cover">
                  {coverText(item)}
                </td>
                <td className="num" data-label="Days since sale">
                  {quietText(item)}
                </td>
                <td className="num" data-label="Cash tied up">
                  {cashText(item.cash_tied_minor, item.currency)}
                  {item.cost_basis === "stated" && <span className="st-src">your cost</span>}
                </td>
                <td data-label="Flag">
                  <span className={`flag ${flagClass(item.flag)}`}>{item.flag}</span>
                </td>
                <td data-label="Cheapest ways to clear it">
                  <ol className="st-opts">
                    {usable.map((o) => {
                      const w = proposalWord(o);
                      return (
                        <li key={o.key}>
                          <span>{o.label}</span>
                          {w && <span className={`word ${w.tone}`}>{w.word}</span>}
                        </li>
                      );
                    })}
                    {usable.length === 0 && <li className="st-none">nothing I can propose</li>}
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

function CoverTable({ cover }: { cover: CoverBlock }) {
  const n = cover.window_days;
  return (
    <div className="st-table-wrap" tabIndex={0} aria-label="Days of cover, item by item">
      <table className="rt rt-stack st-table">
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col" className="num">
              On hand
            </th>
            <th scope="col" className="num">
              Sold {n} d
            </th>
            <th scope="col" className="num">
              vs prior {n} d
            </th>
            <th scope="col" className="num">
              Days of cover
            </th>
            <th scope="col">Delivery time</th>
            <th scope="col">Flag</th>
          </tr>
        </thead>
        <tbody>
          {cover.items.map((item) => (
            <tr key={item.key}>
              <th scope="row">
                {item.name}
                <span className="st-src">{item.source}</span>
              </th>
              <td className="num" data-label="On hand">
                {num(item.on_hand)}
              </td>
              <td className="num" data-label={`Sold ${n} d`}>
                {item.sold_recent === null ? "—" : num(item.sold_recent)}
              </td>
              <td className="num" data-label={`vs prior ${n} d`} title={item.sell_through}>
                {vsPriorText(item)}
                {item.vs_prior && item.vs_prior.band > 0 && (
                  <span className="st-src">chance ±{num(item.vs_prior.band)}</span>
                )}
              </td>
              <td className="num" data-label="Days of cover" title={item.why ?? item.sources}>
                {item.cover_text}
                {item.boosted && <span className="st-src">busy stretch counted</span>}
              </td>
              <td data-label="Delivery time" title={item.lead.why}>
                <span className="st-mono">{leadText(item)}</span>
              </td>
              <td data-label="Flag">
                <span className={`flag ${coverFlagClass(item.flag)}`}>{item.flag}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReorderNote({ item }: { item: CoverItemView }) {
  const r = item.reorder!;
  const w = r.proposal ? statusWord(r.proposal) : null;
  return (
    <SheetCard
      label={`Reorder note · ${item.flag.toLowerCase()}`}
      title={`${item.name}: reorder ${num(r.quantity)}${item.lead.supplier ? ` from ${item.lead.supplier}` : ""}`}
      meta="A note for you, not an order"
    >
      <p className="st-copy st-warn">
        {item.warning}
        {w && <span className={`word ${w.tone}`}>{w.word}</span>}
      </p>
      <p className="st-rank-math">{r.arithmetic}</p>
      {r.cost && (
        <p className="st-rank-fig">
          {moneyLine(r.cost)}
          {r.cost_arithmetic && <span className="st-src">{r.cost_arithmetic}</span>}
        </p>
      )}
      <p className="st-rank-math">Sources: {item.sources}.</p>
      {item.assumed.length > 0 && (
        <ul className="st-assumed">
          {item.assumed.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      )}
      {r.proposal?.status === "blocked" && r.proposal.blocked_by_limit && (
        <p className="st-rank-math">
          I didn&apos;t put this in your queue: your rule ({r.proposal.blocked_by_limit}) rules it
          out.
        </p>
      )}
      <p className="st-copy">
        Approving it records that you mean to reorder, and nothing else. I never contact your
        supplier, and I never place, change or cancel an order.
      </p>
    </SheetCard>
  );
}

function CoverCard({
  cover,
  onReorder,
  busy,
  note,
}: {
  cover: CoverBlock;
  onReorder: () => void;
  busy: boolean;
  note: string | null;
}) {
  const warned = cover.items.filter((i) => i.reorder !== null);
  const waiting = warned.every((i) => i.reorder?.proposal);
  return (
    <SheetCard
      label={`What runs out, and when · ${num(cover.warnings)} of ${num(cover.items.length)} items below their delivery time`}
      title={cover.warnings > 0 ? "Soonest out first" : "Nothing runs out before a delivery"}
      meta={`Cover: on hand ÷ your last ${cover.window_days} days' rate, low–high, against each supplier's delivery time (else ${cover.default_lead_days} days, ASSUMED)`}
      foot={
        warned.length > 0 ? (
          <span className="st-foot-row">
            <span>
              {cover.held ??
                "A reorder note per item running low. Nothing runs until you approve it, and approving orders nothing."}
            </span>
            <button
              type="button"
              className="act"
              disabled={busy || cover.held !== null || waiting}
              onClick={onReorder}
            >
              {busy ? "Working it out…" : "Put the reorder notes in my queue →"}
            </button>
          </span>
        ) : undefined
      }
    >
      <CoverTable cover={cover} />
      <p className="st-copy">{cover.season}</p>
      {busy && (
        <p className="st-copy live">
          <span className="live-dot" aria-hidden="true" /> Working out the notes
        </p>
      )}
      {note && (
        <p className="st-copy">
          {note} <Link href="/proposals">Waiting for you</Link>
        </p>
      )}
    </SheetCard>
  );
}

function Ranking({ item }: { item: StockItemView }) {
  const blocked = item.options.find((o) => o.proposal?.status === "blocked");
  return (
    <SheetCard
      label={`How I'd clear it · ${item.flag.toLowerCase()} · ${item.why}`}
      title={`${item.name}: cash likely back, per euro given up`}
      meta="Most cash back first, after what each gives up"
    >
      <ol className="st-rank">
        {item.options.map((o, i) => {
          const w = proposalWord(o);
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
                    ? `I can't propose this: ${o.unavailable}.`
                    : o.efficiency}
                </p>
                {o.unavailable === null && <p className="st-rank-math">{o.arithmetic}</p>}
                {o.proposal?.status === "blocked" && o.proposal.blocked_by_limit && (
                  <p className="st-rank-math">
                    I didn&apos;t put this in your queue: your rule ({o.proposal.blocked_by_limit})
                    rules it out.
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {blocked && (
        <p className="st-copy">
          A rule of yours blocked {blocked.label.toLowerCase()}, so it sits blocked in your queue,
          where you can see what I chose not to propose.
        </p>
      )}
    </SheetCard>
  );
}

function ImportCard({ onDone }: { onDone: () => void }) {
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
        setNote(body.error ?? "That didn't import.");
        return;
      }
      const left = Object.values(body.skipped ?? {}).reduce((s, n) => s + n, 0);
      const blank = Object.values(body.unreadable ?? {}).reduce((s, n) => s + n, 0);
      setNote(
        `I read ${body.imported} item${body.imported === 1 ? "" : "s"}.` +
          (left > 0
            ? ` ${left} row${left === 1 ? "" : "s"} had no item or no readable stock and were left out.`
            : "") +
          (blank > 0
            ? ` ${blank} value${blank === 1 ? "" : "s"} couldn't be read and were left blank, not guessed.`
            : ""),
      );
      setCsv("");
      onDone();
    } catch {
      setNote("Something went wrong on our side. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SheetCard
      label="No shop connected? A stock count works too"
      title="Import a stock file"
      foot="Columns I read: item or SKU, on hand, unit cost, price, last sold date, units sold."
    >
      <div className="st-form">
        <label className="st-field st-wide">
          <span className="label">Paste the file (CSV)</span>
          <textarea
            rows={4}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={
              "item,on hand,unit cost,price,last sold\nArgan oil 100 ml,14,9.50,24.00,2026-07-02"
            }
          />
        </label>
        <label className="st-field">
          <span className="label">Currency</span>
          <input
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
          />
        </label>
        <label className="st-field">
          <span className="label">Units sold cover (days)</span>
          <input
            inputMode="numeric"
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
          />
        </label>
        <label className="st-field">
          <span className="label">Counted on</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label className="st-field">
          <span className="label">How amounts are written, if they look like 1.200</span>
          <select
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
        <button type="button" className="act" disabled={busy || csv.trim() === ""} onClick={submit}>
          {busy ? "Reading…" : "Import stock →"}
        </button>
      </div>
      {busy && (
        <p className="st-copy live">
          <span className="live-dot" aria-hidden="true" /> Reading your file
        </p>
      )}
      {note && <p className="st-copy">{note}</p>}
    </SheetCard>
  );
}

export function StockScreen() {
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
      if (!res.ok) setProposed(body.error ?? "That didn't work.");
      else {
        const c = body.created ?? 0;
        const b = body.blocked ?? 0;
        setProposed(
          c + b === 0
            ? `Nothing new to propose${body.skipped?.[0] ? `: ${body.skipped[0].reason}` : ""}.`
            : `${c} proposal${c === 1 ? "" : "s"} now wait for you${b > 0 ? `, and ${b} ${b === 1 ? "was" : "were"} blocked by your own rules` : ""}.`,
        );
        await load();
      }
    } catch {
      setProposed("Something went wrong on our side.");
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
      if (!res.ok) setReordered(body.error ?? "That didn't work.");
      else {
        const c = body.created ?? 0;
        const b = body.blocked ?? 0;
        setReordered(
          c + b === 0
            ? `Nothing new to propose${body.skipped?.[0] ? `: ${body.skipped[0].reason}` : ""}.`
            : `${c} reorder note${c === 1 ? "" : "s"} now wait${c === 1 ? "s" : ""} for you${b > 0 ? `, and ${b} ${b === 1 ? "was" : "were"} blocked by your own rules` : ""}.`,
        );
        await load();
      }
    } catch {
      setReordered("Something went wrong on our side.");
    } finally {
      setReordering(false);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="st-wait">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Stock didn't load.">
        <p className="st-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading your stock…" />;
  if (!view.applies) {
    return (
      <Frame title="Your business doesn't hold stock.">
        <p className="st-wait">
          You told me you don&apos;t keep stock, so there&apos;s nothing here to run out or clear.{" "}
          <Link href="/profile">Fact sheet</Link>
        </p>
      </Frame>
    );
  }

  const slow = view.slow ?? [];
  const sources = (view.sources ?? []).filter((s) => s.as_of !== null);
  const aside = (
    <>
      {sources.length === 0
        ? "Nothing read yet"
        : sources.map((s) => `${s.label} ${s.as_of}`).join(" · ")}{" "}
      · MEASURED
    </>
  );
  const th = view.thresholds;
  const svm = statedVsMeasured(view);

  return (
    <Frame title={stockHeadline(view)} aside={aside}>
      {view.cover && view.cover.items.length > 0 && (
        <>
          <CoverCard
            cover={view.cover}
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

      {slow.length > 0 ? (
        <SheetCard
          label={`What isn't selling · ${num(slow.length)} of ${num(view.counted ?? 0)} items`}
          title="Most cash tied up first"
          meta={
            th
              ? `STUCK: no sale in ${th.stuck_no_sale_days} days · SLOW: over ${th.slow_cover_days} days of cover`
              : undefined
          }
          foot={
            <span className="st-foot-row">
              <span>
                {view.held ??
                  `I propose ways to clear the top ${th?.max_items ?? 3}. Nothing runs until you approve it.`}
              </span>
              <button
                type="button"
                className="act"
                disabled={proposing || view.held !== null}
                onClick={propose}
              >
                {proposing ? "Working it out…" : "Put these in my queue →"}
              </button>
            </span>
          }
        >
          <SlowTable items={slow} />
          {proposing && (
            <p className="st-copy live">
              <span className="live-dot" aria-hidden="true" /> Working out the options
            </p>
          )}
          {proposed && (
            <p className="st-copy">
              {proposed} <Link href="/proposals">Waiting for you</Link>
            </p>
          )}
        </SheetCard>
      ) : (
        <SheetCard
          label="What isn't selling"
          title={sources.length === 0 ? "Nothing read yet" : "Nothing slow"}
        >
          <p className="st-copy">
            {sources.length === 0
              ? "Connect your shop on Connections and I read its stock with every sync, or import a stock file below."
              : `Every item I read sold within ${th?.stuck_no_sale_days ?? 60} days and has under ${th?.slow_cover_days ?? 180} days of cover.`}{" "}
            {sources.length === 0 && <Link href="/connections">Connections</Link>}
          </p>
        </SheetCard>
      )}

      {view.history && <StockHistoryChart model={view.history} />}

      <div className="st-grid">
        {slow[0] ? (
          <Ranking item={slow[0]} />
        ) : (
          <SheetCard label="How I judge stock" title="Two thresholds, nothing guessed">
            <p className="st-copy">
              STUCK means stock on hand and no sale in the last {th?.stuck_no_sale_days ?? 60} days.
              SLOW means over {th?.slow_cover_days ?? 180} days of cover at the item&apos;s own rate
              of sale.
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
            <SheetCard label="What you told me, against what I measured" title="Dead stock">
              <p className="st-copy">{svm}</p>
            </SheetCard>
          )}
        </div>
      )}
    </Frame>
  );
}
