"use client";

// Grow · What-if pricing (idea 43), the simulator's second half. The owner
// picks one product or service and up to four price changes, and sees side
// by side what each does to its monthly profit: the headline is the
// break-even — how many sales a rise can lose, or a cut must win, before
// it stops paying — which rests only on their own price, cost and volume.
// Under it, sales, revenue and profit as ranges under a stated band of
// customer response (ASSUMED, never a measurement), a whisker per change,
// and each change's chain: its inputs with their sources, what's missing
// with a link to where it's asked, the arithmetic and the worst case.
//
// Read-only: nothing here changes a price or makes a proposal. The
// arithmetic is lib/simulate/pricing.ts, run here on the figures
// /api/simulate/pricing reads.

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import "../../app/simulate.css";
import type {
  PriceChange,
  PriceComparison,
  PriceItemRaw,
  PriceResult,
  PricingInputs,
} from "../../lib/simulate/pricing";
import {
  PRICE_MEASURES,
  PRICE_MEASURE_LABEL,
  PRICE_MEASURE_UNIT,
  PRICING,
  changeError,
  changeKey,
  comparePrices,
  periodWords,
  pricingHeadline,
  unitNoun,
} from "../../lib/simulate/pricing";
import { RESPONSE_BANDS } from "../../lib/simulate/pricing-bands";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { minorUnitExponent } from "../../lib/core/money";
import { moneyFig, moneyText, num } from "../sheet/num";
import { SimTabs } from "./SimTabs";
import { Whiskers } from "./SimulateScreen";
import {
  breakEvenView,
  defaultChanges,
  defaultItem,
  exactToMinor,
  itemLine,
  perOrderLine,
  stepLabel,
  toggleChange,
} from "./pricing-view";
import { cellView } from "./view";

type Load =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; inputs: PricingInputs };

function Frame({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="screen sim-screen">
      <PageHead kicker="Grow · What-if pricing" title={title} aside={aside} />
      <SimTabs current="pricing" />
      {children}
    </main>
  );
}

function itemsMeta(items: readonly PriceItemRaw[]): string {
  const services = items.filter((i) => i.kind === "service").length;
  const offers = items.length - services;
  const parts = [
    ...(services > 0 ? [`${services} from your bookings`] : []),
    ...(offers > 0 ? [`${offers} from your profile`] : []),
  ];
  return parts.join(" · ");
}

function ItemPicker({
  items,
  current,
  onPick,
}: {
  items: PriceItemRaw[];
  current: string | null;
  onPick: (key: string) => void;
}) {
  return (
    <SheetCard label="Pick one" title="What to reprice" meta={itemsMeta(items)}>
      <div className="sim-wrap">
        <table className="rt rt-stack sim-pick">
          <thead>
            <tr>
              <th scope="col">{items.some((i) => i.kind === "service") ? "Service" : "Product"}</th>
              <th scope="col">From your numbers</th>
              <th scope="col">
                <span className="sr-only">Pick</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const on = i.key === current;
              return (
                <tr key={i.key} className={on ? "on" : undefined}>
                  <th scope="row">{i.name}</th>
                  <td className="src" data-label="From your numbers">
                    {itemLine(i)}
                  </td>
                  <td className="sim-acts-cell">
                    <div className="sim-acts">
                      {i.price ? (
                        <button
                          type="button"
                          className={`act sim-toggle${on ? " solid" : ""}`}
                          aria-pressed={on}
                          aria-label={`Reprice ${i.name}`}
                          onClick={() => onPick(i.key)}
                        >
                          {on ? "Picked" : "Reprice"}
                        </button>
                      ) : (
                        <Link className="act sim-toggle" href={i.asks.price}>
                          Add its price
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}

function ChangePicker({
  item,
  picks,
  setPicks,
  exact,
  setExact,
  exactNote,
}: {
  item: PriceItemRaw;
  picks: PriceChange[];
  setPicks: (p: PriceChange[]) => void;
  exact: string;
  setExact: (s: string) => void;
  exactNote: string | null;
}) {
  const full = picks.length >= PRICING.max_changes;
  return (
    <SheetCard
      label={`Up to ${PRICING.max_changes}`}
      title={`Price changes on ${item.name}`}
      meta={`${picks.length} picked${full ? " · that's the most I compare at once" : ""}`}
    >
      <div className="sim-steps" role="group" aria-label="Price changes">
        {PRICING.steps.map((share) => {
          const c: PriceChange = { kind: "share", share };
          const on = picks.some((p) => changeKey(p) === changeKey(c));
          return (
            <button
              key={share}
              type="button"
              className={`act sim-toggle${on ? " solid" : ""}`}
              aria-pressed={on}
              disabled={full && !on}
              onClick={() => setPicks(toggleChange(picks, c))}
            >
              {stepLabel(share)}
            </button>
          );
        })}
        <label className="sim-budget">
          <span>or exactly, {item.currency}</span>
          <input
            inputMode="decimal"
            aria-label={`An exact new price, in ${item.currency}`}
            value={exact}
            placeholder={
              item.price
                ? moneyFig(item.price.amount_minor, item.currency, minorUnitExponent(item.currency))
                : "0"
            }
            onChange={(ev) => setExact(ev.target.value)}
          />
        </label>
      </div>
      {exactNote && <p className="sim-note sim-exact-note">{exactNote}</p>}
    </SheetCard>
  );
}

function SideBySide({ cmp }: { cmp: PriceComparison }) {
  const item = cmp.item;
  const noun = unitNoun(item);
  return (
    <SheetCard
      label={`Side by side · ${periodWords(item)}`}
      title={`What each price does to ${item.name}`}
      meta="The break-even rests on your numbers alone; the ranges add an assumed customer response"
    >
      <div className="sim-wrap">
        <table className="rt sim-table">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              {cmp.results.map((r) => (
                <th scope="col" key={r.key} className="num">
                  {r.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">
                Break-even
                <small>{`${noun} it can lose, or must win`}</small>
              </th>
              {cmp.results.map((r) => {
                const v = breakEvenView(r.breakeven, item);
                return (
                  <td
                    key={r.key}
                    className="num"
                    title={"formula" in r.breakeven ? r.breakeven.formula : v.sub}
                  >
                    <span className="fig">{v.figure}</span>
                    {v.flag ? (
                      <span className={`flag ${v.flag === "MISSING" ? "drift" : "alarm"}`}>
                        {v.flag}
                      </span>
                    ) : (
                      <span className="sim-basis">{v.sub}</span>
                    )}
                  </td>
                );
              })}
            </tr>
            {PRICE_MEASURES.map((m) => (
              <tr key={m}>
                <th scope="row">
                  {m === "volume"
                    ? `${noun === "bookings" ? "Bookings" : "Sales"} after`
                    : PRICE_MEASURE_LABEL[m]}
                  <small>
                    {PRICE_MEASURE_UNIT[m] === "money"
                      ? `${item.currency} ${periodWords(item)}`
                      : `${noun} ${periodWords(item)}`}
                  </small>
                </th>
                {cmp.results.map((r) => {
                  const v = cellView(r.measures[m], PRICE_MEASURE_UNIT[m], r.currency);
                  return (
                    <td key={r.key} className="num" title={v.detail}>
                      <span className="fig">{v.figure}</span>
                      {v.flag ? (
                        <span className={`flag ${v.flag === "MISSING" ? "drift" : "low"}`}>
                          {v.flag}
                        </span>
                      ) : (
                        v.basis && <span className="sim-basis">{v.basis}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}

function ChangeCard({ r, item }: { r: PriceResult; item: PriceItemRaw }) {
  const be = r.breakeven;
  const measures = PRICE_MEASURES.filter((m) => r.measures[m].status === "range");
  return (
    <SheetCard
      className="sim-card"
      label="Price change"
      title={`${item.name}: ${moneyText(r.old_price_minor, r.currency)} → ${moneyText(r.new_price_minor, r.currency)}`}
      meta="Nothing here changes your price"
    >
      <p className="sim-what sim-be">
        <span className="cs-label">Break-even</span> {be.words}
      </p>
      {"formula" in be && <p className="sim-be-math fig">{be.formula}</p>}
      {be.status === "lose" && be.floor && (
        <p className="sim-needs">
          <span>
            That&rsquo;s the cautious end: with what one costs you to deliver, I could say how many
            more you could lose.
          </span>
          <Link href={item.asks.unit_cost}>Add the cost →</Link>
        </p>
      )}
      {be.status === "missing" && (
        <p className="sim-needs">
          {be.needs.map((n) => (
            <Link key={n.href + n.what} href={n.href}>
              Add {n.what} →
            </Link>
          ))}
        </p>
      )}
      <div className="sim-wrap">
        <table className="rt rt-stack sim-inputs">
          <thead>
            <tr>
              <th scope="col">What it rests on</th>
              <th scope="col" className="num">
                Value
              </th>
              <th scope="col">Basis</th>
              <th scope="col">Where it came from</th>
            </tr>
          </thead>
          <tbody>
            {r.inputs.map((i) => (
              <tr key={i.key}>
                <th scope="row">{i.label}</th>
                <td className="num" data-label="Value">
                  {i.value}
                </td>
                <td data-label="Basis">
                  {i.basis ? (
                    <span className="sim-basis">{i.basis}</span>
                  ) : (
                    <span className="flag drift">Missing</span>
                  )}
                </td>
                <td className="src" data-label="Where it came from">
                  {i.needs && i.basis === null ? (
                    <>
                      needs {i.needs.what} — <Link href={i.needs.href}>add it</Link>
                    </>
                  ) : (
                    i.source
                  )}
                </td>
              </tr>
            ))}
            {r.assumptions.map((a) => (
              <tr key={a.statement}>
                <th scope="row">{a.statement}</th>
                <td className="num" data-label="Value">
                  —
                </td>
                <td data-label="Basis">
                  <span className="sim-basis">ASSUMED</span>
                </td>
                <td className="src" data-label="Where it came from">
                  {a.source}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {measures.length > 0 && (
        <dl className="sim-math">
          {measures.map((m) => {
            const c = r.measures[m];
            return c.status === "range" ? (
              <div key={m}>
                <dt>{m === "volume" ? unitNoun(item) : m === "worst" ? "Worst case" : m}</dt>
                <dd className="fig">{c.formula}</dd>
              </div>
            ) : null;
          })}
        </dl>
      )}
      <p className="sim-worst-words">
        <span className="cs-label">Worst case</span> {r.worst_words}
      </p>
    </SheetCard>
  );
}

export function PricingScreen() {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [itemKey, setItemKey] = useState<string | null>(null);
  const [picks, setPicks] = useState<PriceChange[]>(defaultChanges());
  const [exact, setExact] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/simulate/pricing");
        if (res.status === 401) return setLoad({ phase: "signedout" });
        if (!res.ok) return setLoad({ phase: "error" });
        const data = (await res.json()) as { inputs: PricingInputs };
        setLoad({ phase: "ready", inputs: data.inputs });
        setItemKey(defaultItem(data.inputs)?.key ?? null);
      } catch {
        setLoad({ phase: "error" });
      }
    })();
  }, []);

  const ready = load.phase === "ready" ? load : null;
  const item = ready?.inputs.items.find((i) => i.key === itemKey) ?? null;

  const exactChange = useMemo((): { change: PriceChange | null; note: string | null } => {
    if (!item || exact.trim() === "") return { change: null, note: null };
    const minor = exactToMinor(exact, item.currency);
    if (minor === null) return { change: null, note: "That isn't a price I can read." };
    const c: PriceChange = { kind: "exact", price_minor: minor };
    const err = item.price ? changeError(item.price.amount_minor, c) : "it has no price yet";
    return err ? { change: null, note: `Not simulated: ${err}.` } : { change: c, note: null };
  }, [item, exact]);

  const cmp = useMemo(() => {
    if (!ready || !item || !item.price) return null;
    const changes = [...picks];
    if (exactChange.change) {
      if (changes.length >= PRICING.max_changes) changes.pop();
      changes.push(exactChange.change);
    }
    return comparePrices(item, changes, ready.inputs.archetype);
  }, [ready, item, picks, exactChange]);

  if (load.phase === "signedout") {
    return (
      <Frame title="There's no business here yet.">
        <p className="sim-note on-desk">
          <Link href="/intake">Start with the interview</Link>, and your own numbers fill this in.
        </p>
      </Frame>
    );
  }
  if (load.phase === "error") {
    return (
      <Frame title="What-if pricing didn't load.">
        <p className="sim-note on-desk">Something went wrong on my side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!ready) return <Frame title="Reading your prices…" />;

  const x = ready.inputs;
  const band = RESPONSE_BANDS[x.archetype];
  const aside = (
    <>
      Nothing here changes a price
      <br />
      As of {x.as_of} · {x.currency}
    </>
  );

  if (x.items.length === 0) {
    return (
      <Frame title="There's nothing priced on your profile yet." aside={aside}>
        <p className="sim-note on-desk">
          <Link href="/intake?ask=3.1">List what you sell, with its price</Link>, or import your
          bookings on <Link href="/connections">Connections</Link>, and this fills in.
        </p>
      </Frame>
    );
  }

  const title = cmp
    ? pricingHeadline(cmp)
    : item
      ? `${item.name} has no price on your profile yet.`
      : "Pick a product or service to reprice.";
  const perOrder = perOrderLine(x, item);

  return (
    <Frame title={title} aside={aside}>
      <div className="sim-stack">
        <ItemPicker items={x.items} current={itemKey} onPick={setItemKey} />
        {item && item.price && (
          <ChangePicker
            item={item}
            picks={picks}
            setPicks={setPicks}
            exact={exact}
            setExact={setExact}
            exactNote={exactChange.note}
          />
        )}
        {cmp && cmp.results.length > 0 ? (
          <>
            <SideBySide cmp={cmp} />
            <p className="sim-note on-desk">
              The ranges assume that for each 1% on the price, {num(band.low, 1)}% to{" "}
              {num(band.high, 1)}% of {unitNoun(cmp.item)} move the other way — a planning
              assumption for your kind of business, not a measurement. The break-even assumes
              nothing.
              {perOrder ? ` ${perOrder}` : ""}
            </p>
            {cmp.results.some((r) => r.measures.profit.status === "range") ? (
              <SheetCard label="Profit, side by side" title="The spread of each price">
                <Whiskers
                  results={cmp.results}
                  caption={`Profit change ${periodWords(cmp.item)}, low to high · the square is the worst case`}
                />
              </SheetCard>
            ) : (
              <p className="sim-note on-desk">
                Profit can&rsquo;t be drawn yet: it needs what one {unitNoun(cmp.item, false)} costs
                you to deliver. <Link href={cmp.item.asks.unit_cost}>Add it</Link>.
              </p>
            )}
            <div className="sim-cards">
              {cmp.results.map((r) => (
                <ChangeCard key={r.key} r={r} item={cmp.item} />
              ))}
            </div>
          </>
        ) : (
          item &&
          item.price && <p className="sim-note on-desk">Pick a price change to see what it does.</p>
        )}
        {cmp && cmp.refused.length > 0 && (
          <p className="sim-note on-desk">
            {cmp.refused.map((f) => `Not simulated: ${f.why}.`).join(" ")}
          </p>
        )}
      </div>
    </Frame>
  );
}
