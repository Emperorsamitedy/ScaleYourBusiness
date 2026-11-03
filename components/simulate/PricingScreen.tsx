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
//
// L-3b (TASKS-LANGUAGES.md): the screen's fixed words are
// "simulate.pricing", figures in the reader's locale and the item's own
// currency. The headline, change titles, break-even words and formulas,
// inputs' labels and sources, and refusal reasons that lib/simulate/pricing
// words from the numbers stay English until L-4.

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
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
  PRICE_MEASURE_UNIT,
  PRICING,
  changeError,
  changeKey,
  comparePrices,
  pricingHeadline,
} from "../../lib/simulate/pricing";
import { RESPONSE_BANDS } from "../../lib/simulate/pricing-bands";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { minorUnitExponent } from "../../lib/core/money";
import { basisName } from "../report/basis";
import { moneyFig, moneyText, num } from "../sheet/num";
import { SimTabs } from "./SimTabs";
import { Whiskers, asOfDay, useSimWords } from "./SimulateScreen";
import {
  breakEvenView,
  defaultChanges,
  defaultItem,
  exactToMinor,
  itemLine,
  perOrderLine,
  periodText,
  stepLabel,
  toggleChange,
} from "./pricing-view";
import { cellView, flagWord } from "./view";

type Load =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; inputs: PricingInputs };

/** A percent figure (the response band is in percent points: 0.5 → "0.5%"); in another language, its own. */
function bandPct(points: number, locale: AppLocale): string {
  if (locale === "en") return `${num(points, 1)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(points / 100);
}

/** "1%": the step the response band is stated per. */
function onePct(locale: AppLocale): string {
  if (locale === "en") return "1%";
  return new Intl.NumberFormat(intlTag(locale), { style: "percent" }).format(0.01);
}

function Frame({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useSimWords();
  return (
    <main className="screen sim-screen">
      <PageHead kicker={tr("pricing.kicker")} title={title} aside={aside} />
      <SimTabs current="pricing" />
      {children}
    </main>
  );
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
  const words = useSimWords();
  const { tr } = words;
  const services = items.filter((i) => i.kind === "service").length;
  const offers = items.length - services;
  const meta = [
    ...(services > 0 ? [tr("pricing.fromBookings", { count: services })] : []),
    ...(offers > 0 ? [tr("pricing.fromProfile", { count: offers })] : []),
  ].join(" · ");
  const fromHead = tr("picker.fromNumbers");
  return (
    <SheetCard label={tr("pricing.items.label")} title={tr("pricing.items.title")} meta={meta}>
      <div className="sim-wrap">
        <table className="rt rt-stack sim-pick">
          <thead>
            <tr>
              <th scope="col">
                {items.some((i) => i.kind === "service")
                  ? tr("pricing.items.service")
                  : tr("pricing.items.product")}
              </th>
              <th scope="col">{fromHead}</th>
              <th scope="col">
                <span className="sr-only">{tr("pricing.items.pick")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => {
              const on = i.key === current;
              return (
                <tr key={i.key} className={on ? "on" : undefined}>
                  <th scope="row">{i.name}</th>
                  <td className="src" data-label={fromHead}>
                    {itemLine(i, words)}
                  </td>
                  <td className="sim-acts-cell">
                    <div className="sim-acts">
                      {i.price ? (
                        <button
                          type="button"
                          className={`act sim-toggle${on ? " solid" : ""}`}
                          aria-pressed={on}
                          aria-label={tr("pricing.items.repriceAria", { name: i.name })}
                          onClick={() => onPick(i.key)}
                        >
                          {on ? tr("picker.picked") : tr("pricing.items.reprice")}
                        </button>
                      ) : (
                        <Link className="act sim-toggle" href={i.asks.price}>
                          {tr("pricing.items.addPrice")}
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
  const { tr, locale } = useSimWords();
  const full = picks.length >= PRICING.max_changes;
  return (
    <SheetCard
      label={tr("pricing.changes.label", { max: PRICING.max_changes })}
      title={tr("pricing.changes.title", { name: item.name })}
      meta={tr(full ? "picker.metaFull" : "picker.meta", { count: picks.length })}
    >
      <div className="sim-steps" role="group" aria-label={tr("pricing.changes.aria")}>
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
              {stepLabel(share, locale)}
            </button>
          );
        })}
        <label className="sim-budget">
          <span>{tr("pricing.changes.exactly", { currency: item.currency })}</span>
          <input
            inputMode="decimal"
            aria-label={tr("pricing.changes.exactAria", { currency: item.currency })}
            value={exact}
            placeholder={
              item.price
                ? moneyFig(
                    item.price.amount_minor,
                    item.currency,
                    minorUnitExponent(item.currency),
                    locale,
                  )
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
  const words = useSimWords();
  const { tr } = words;
  const item = cmp.item;
  const kind = item.kind;
  const period = periodText(item, tr);
  return (
    <SheetCard
      label={tr("pricing.side.label", { period })}
      title={tr("pricing.side.title", { name: item.name })}
      meta={tr("pricing.side.meta")}
    >
      <div className="sim-wrap">
        <table className="rt sim-table">
          <thead>
            <tr>
              <th scope="col">{tr("side.measure")}</th>
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
                {tr("pricing.side.breakEven")}
                <small>{tr("pricing.side.breakEvenSub", { kind })}</small>
              </th>
              {cmp.results.map((r) => {
                const v = breakEvenView(r.breakeven, item, words);
                return (
                  <td
                    key={r.key}
                    className="num"
                    title={"formula" in r.breakeven ? r.breakeven.formula : v.sub}
                  >
                    <span className="fig">{v.figure}</span>
                    {v.flag ? (
                      <span className={`flag ${v.flag === "MISSING" ? "drift" : "alarm"}`}>
                        {v.flag === "MISSING" ? tr("cell.missing") : tr("pricing.never")}
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
                    ? tr("pricing.side.volume", { kind })
                    : tr(`pricing.measure.${m}`)}
                  <small>
                    {PRICE_MEASURE_UNIT[m] === "money"
                      ? tr("pricing.side.unitMoney", { currency: item.currency, period })
                      : tr("pricing.side.unitCount", { kind, period })}
                  </small>
                </th>
                {cmp.results.map((r) => {
                  const v = cellView(r.measures[m], PRICE_MEASURE_UNIT[m], r.currency, words);
                  return (
                    <td key={r.key} className="num" title={v.detail}>
                      <span className="fig">{v.figure}</span>
                      {v.flag ? (
                        <span className={`flag ${v.flag === "MISSING" ? "drift" : "low"}`}>
                          {flagWord(v.flag, tr)}
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
  const { tr, sheet, locale } = useSimWords();
  const t = useTranslations("simulate");
  const be = r.breakeven;
  const measures = PRICE_MEASURES.filter((m) => r.measures[m].status === "range");
  const valueHead = tr("option.value");
  const basisHead = tr("option.basis");
  const fromHead = tr("option.from");
  return (
    <SheetCard
      className="sim-card"
      label={tr("pricing.card.label")}
      title={`${item.name}: ${moneyText(r.old_price_minor, r.currency, locale)} → ${moneyText(r.new_price_minor, r.currency, locale)}`}
      meta={tr("pricing.card.meta")}
    >
      <p className="sim-what sim-be">
        <span className="cs-label">{tr("pricing.card.breakEven")}</span> {be.words}
      </p>
      {"formula" in be && <p className="sim-be-math fig">{be.formula}</p>}
      {be.status === "lose" && be.floor && (
        <p className="sim-needs">
          <span>{tr("pricing.card.cautious")}</span>
          <Link href={item.asks.unit_cost}>{tr("pricing.card.addCost")}</Link>
        </p>
      )}
      {be.status === "missing" && (
        <p className="sim-needs">
          {be.needs.map((n) => (
            <Link key={n.href + n.what} href={n.href}>
              {tr("pricing.card.addNeed", { what: n.what })}
            </Link>
          ))}
        </p>
      )}
      <div className="sim-wrap">
        <table className="rt rt-stack sim-inputs">
          <thead>
            <tr>
              <th scope="col">{tr("option.restsOn")}</th>
              <th scope="col" className="num">
                {valueHead}
              </th>
              <th scope="col">{basisHead}</th>
              <th scope="col">{fromHead}</th>
            </tr>
          </thead>
          <tbody>
            {r.inputs.map((i) => (
              <tr key={i.key}>
                <th scope="row">{i.label}</th>
                <td className="num" data-label={valueHead}>
                  {i.value}
                </td>
                <td data-label={basisHead}>
                  {i.basis ? (
                    <span className="sim-basis">{basisName(i.basis, sheet)}</span>
                  ) : (
                    <span className="flag drift">{tr("option.missing")}</span>
                  )}
                </td>
                <td className="src" data-label={fromHead}>
                  {i.needs && i.basis === null
                    ? t.rich("pricing.card.needs", {
                        what: i.needs.what,
                        link: (c) => <Link href={i.needs!.href}>{c}</Link>,
                      })
                    : i.source}
                </td>
              </tr>
            ))}
            {r.assumptions.map((a) => (
              <tr key={a.statement}>
                <th scope="row">{a.statement}</th>
                <td className="num" data-label={valueHead}>
                  —
                </td>
                <td data-label={basisHead}>
                  <span className="sim-basis">{basisName("ASSUMED", sheet)}</span>
                </td>
                <td className="src" data-label={fromHead}>
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
                <dt>{tr(`pricing.math.${m}`, { kind: item.kind })}</dt>
                <dd className="fig">{c.formula}</dd>
              </div>
            ) : null;
          })}
        </dl>
      )}
      <p className="sim-worst-words">
        <span className="cs-label">{tr("option.worstCase")}</span> {r.worst_words}
      </p>
    </SheetCard>
  );
}

export function PricingScreen() {
  const words = useSimWords();
  const { tr, locale } = words;
  const t = useTranslations("simulate");
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

  // The note is held as what to say, and worded where it's shown.
  type ExactNote = { kind: "unreadable" } | { kind: "refused"; why: string | null };
  const exactChange = useMemo((): { change: PriceChange | null; note: ExactNote | null } => {
    if (!item || exact.trim() === "") return { change: null, note: null };
    const minor = exactToMinor(exact, item.currency);
    if (minor === null) return { change: null, note: { kind: "unreadable" } };
    const c: PriceChange = { kind: "exact", price_minor: minor };
    if (!item.price) return { change: null, note: { kind: "refused", why: null } };
    const err = changeError(item.price.amount_minor, c);
    return err ? { change: null, note: { kind: "refused", why: err } } : { change: c, note: null };
  }, [item, exact]);
  const exactNote =
    exactChange.note === null
      ? null
      : exactChange.note.kind === "unreadable"
        ? tr("pricing.unreadable")
        : tr("pricing.refused", { why: exactChange.note.why ?? tr("pricing.noPriceYet") });

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
      <Frame title={tr("signedOut.title")}>
        <p className="sim-note on-desk">
          {t.rich("signedOut.body", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (load.phase === "error") {
    return (
      <Frame title={tr("pricing.failed")}>
        <p className="sim-note on-desk">{tr("failed.body")}</p>
      </Frame>
    );
  }
  if (!ready) return <Frame title={tr("pricing.loading")} />;

  const x = ready.inputs;
  const band = RESPONSE_BANDS[x.archetype];
  const aside = (
    <>
      {tr("pricing.aside")}
      <br />
      {tr("aside.asOf", { date: asOfDay(x.as_of, locale), currency: x.currency })}
    </>
  );

  if (x.items.length === 0) {
    return (
      <Frame title={tr("pricing.empty.title")} aside={aside}>
        <p className="sim-note on-desk">
          {t.rich("pricing.empty.body", {
            ask: (c) => <Link href="/intake?ask=3.1">{c}</Link>,
            conn: (c) => <Link href="/connections">{c}</Link>,
          })}
        </p>
      </Frame>
    );
  }

  const title = cmp
    ? pricingHeadline(cmp)
    : item
      ? tr("pricing.noPrice", { name: item.name })
      : tr("pricing.pickItem");
  const perOrder = perOrderLine(x, item, words);

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
            exactNote={exactNote}
          />
        )}
        {cmp && cmp.results.length > 0 ? (
          <>
            <SideBySide cmp={cmp} />
            <p className="sim-note on-desk">
              {tr("pricing.assumption", {
                one: onePct(locale),
                low: bandPct(band.low, locale),
                high: bandPct(band.high, locale),
                kind: cmp.item.kind,
              })}
              {perOrder ? ` ${perOrder}` : ""}
            </p>
            {cmp.results.some((r) => r.measures.profit.status === "range") ? (
              <SheetCard label={tr("profitCard.label")} title={tr("pricing.profitTitle")}>
                <Whiskers
                  results={cmp.results}
                  caption={tr("pricing.caption", { period: periodText(cmp.item, tr) })}
                />
              </SheetCard>
            ) : (
              <p className="sim-note on-desk">
                {t.rich("pricing.cantDraw", {
                  kind: cmp.item.kind,
                  link: (c) => <Link href={cmp.item.asks.unit_cost}>{c}</Link>,
                })}
              </p>
            )}
            <div className="sim-cards">
              {cmp.results.map((r) => (
                <ChangeCard key={r.key} r={r} item={cmp.item} />
              ))}
            </div>
          </>
        ) : (
          item && item.price && <p className="sim-note on-desk">{tr("pricing.pickChange")}</p>
        )}
        {cmp && cmp.refused.length > 0 && (
          <p className="sim-note on-desk">
            {cmp.refused.map((f) => tr("pricing.refused", { why: f.why })).join(" ")}
          </p>
        )}
      </div>
    </Frame>
  );
}
