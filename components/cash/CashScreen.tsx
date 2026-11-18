"use client";

// Insights · Cash flow (P5-10), on the sheet system (app/sheet.css). When
// money gets tight over the next 13 weeks, read from the business's own
// numbers.
//
// Laid out again on 2026-11-18 from the mockup the owner picked ("there's
// still a lot of text on some pages like the cash flow ... no one will
// probably sit down and read that much"; docs/DASHBOARD-OVERHAUL.md L6).
// Nothing was taken away, it is said in fewer words at a time: a short
// headline with one line under it; three figures (cash today, the lowest
// point ahead, the end of the 13 weeks); the chart; the four what-ifs as
// cards instead of a table, their sizes changed in a side sheet; three
// weeks of the week-by-week figures with the rest one press away; and the
// sources and what was assumed folded at the foot.
//
// Read-only (rule 26): there is no button that pays, moves, transfers or
// collects anything, and no proposal is made here. The head says "planning
// aid" in every state; the planning-aid note and the sources line are on
// the page in every state too, refusals included, folded under "How this
// works" (decluttered 2026-11-09 on the owner's instruction): reachable on
// every visit, read out on none (rule 25).
//
// L-3b: the screen's fixed words are the "cash" catalogue; figures and
// dates in the reader's locale, in the business's currency. L-4b: what the
// forecast says from data (its headline, sources, reasons, scenarios,
// assumptions) arrives from GET /api/cash in the reader's language, and
// the sentences this screen builds come from "cashWords".

import "../../app/cash.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import type { CashView } from "../../app/api/cash/route";
import type { CashForecast, CashReady } from "../../lib/cash/model";
import { CASH } from "../../lib/cash/model";
import { minorUnitExponent } from "../../lib/core/money";
import { CashChart } from "../charts/CashChart";
import { basisName } from "../report/basis";
import { num } from "../sheet/num";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import { WhySheet } from "../sheet/WhySheet";
import type { WhyContent } from "../sheet/WhySheet";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import type { CashWords, SentenceWords } from "./cash-view";
import {
  cashChartModel,
  cashTiles,
  forecastDay,
  headLede,
  headTitle,
  percentText,
  scenarioColumns,
  sourcesLine,
  weekOptions,
  weekRows,
} from "./cash-view";

/** How many weeks the table shows before "show all". */
const FIRST_WEEKS = 3;

/** The screen's words and the reader's locale. */
function useCashWords(): CashWords {
  return useTr("cash");
}

/** The sentences' words (L-4b): "cashWords", the basis names, and the locale. */
function useSentenceWords(): SentenceWords {
  const { tr, locale } = useTr("cashWords");
  const sheet = useTr("sheet").tr;
  return { tr, sheet, locale };
}

function Frame({
  title,
  lede,
  notes,
  forecast,
  children,
}: {
  title: ReactNode;
  /** One line under the title: the figures the title left out. */
  lede?: ReactNode;
  /** Under the line: a "Why?" fold, a link. */
  notes?: ReactNode;
  forecast: CashForecast | null;
  children?: ReactNode;
}) {
  const { tr } = useCashWords();
  const sentences = useSentenceWords();
  return (
    <main className="screen cf-screen">
      <PageHead
        kicker={tr("kicker")}
        title={title}
        aside={<span className="ph-pill">{tr("aside")}</span>}
      >
        {lede && <p className="ph-lede">{lede}</p>}
        {notes}
      </PageHead>
      {children}
      <Fold summary={tr("how")} className="on-desk cf-how">
        <p className="cf-note">{tr("planningNote")}</p>
        <p className="cf-note">{forecast ? sourcesLine(forecast, sentences) : tr("sourcesNone")}</p>
      </Fold>
    </main>
  );
}

function Refused({ f }: { f: Extract<CashForecast, { status: "refused" }> }) {
  const { tr, locale } = useCashWords();
  return (
    <div className="cf-one">
      <SheetCard
        label={
          f.history ? tr("refused.labelFrom", { source: f.history.source }) : tr("refused.label")
        }
        title={
          f.history
            ? tr("refused.weeks", {
                // More than enough history (the cash figure is what's missing) reads
                // "8 of 8", not "13 of 8".
                complete: num(
                  Math.min(f.history.complete_weeks, f.history.needed_weeks),
                  0,
                  locale,
                ),
                needed: num(f.history.needed_weeks, 0, locale),
              })
            : tr("refused.nothing")
        }
        meta={
          f.ready_on ? tr("refused.readyOn", { day: forecastDay(f.ready_on, locale) }) : undefined
        }
      >
        {f.needs.length > 0 && (
          <ul className="cf-list">
            {f.needs.map((n) => (
              <li key={n.href + n.what}>
                <Link href={n.href}>{n.what}</Link>
              </li>
            ))}
          </ul>
        )}
        <Fold summary={tr("refused.gapLabel")}>
          <p className="cf-sub">{tr("refused.can")}</p>
          <ul className="cf-list">
            {f.can.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <p className="cf-sub">{tr("refused.cannot")}</p>
          <ul className="cf-list">
            {f.cannot.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Fold>
      </SheetCard>
    </div>
  );
}

/** Under the headline: why the week is tight, one press away; and how to set the line. */
function HeadNotes({ view, f }: { view: CashView; f: CashReady }) {
  const { tr } = useCashWords();
  const rich = useTranslations("cash");
  const t = view.tight;
  return (
    <>
      {f.line.kind === "zero" && (
        <p className="cf-ask">
          {rich.rich("warning.askBuffer", {
            link: (c) => <Link href="/intake?ask=5.3f">{c}</Link>,
          })}
        </p>
      )}
      <Fold label={t ? "why" : "how"} className="on-desk">
        {t && (
          <ul className="cf-list cf-reasons">
            {t.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        <p>{f.line.kind === "buffer" ? tr("warning.metaBuffer") : tr("warning.metaZero")}</p>
        <p>{tr("warning.reading")}</p>
      </Fold>
    </>
  );
}

/** Three figures over the chart. Cash today opens where it came from. */
function Tiles({ f, onWhy }: { f: CashReady; onWhy: (c: WhyContent) => void }) {
  const words = useCashWords();
  const { tr, locale } = words;
  const home = useTr("home").tr;
  const chart = useTr("charts.cash").tr;
  const { sheet } = useSentenceWords();
  const tiles = cashTiles(f, words);
  return (
    <div className="cf-tiles">
      <button
        type="button"
        className="cf-tile cf-tile-btn"
        onClick={() =>
          onWhy({
            title: home("readings.cash"),
            value: tiles.today.value,
            rows: [
              { label: home("why.basis"), value: basisName(tiles.today.basis, sheet) },
              { label: home("why.from"), value: tiles.today.source },
              ...(tiles.today.on ? [{ label: home("why.when"), value: tiles.today.on }] : []),
            ],
          })
        }
      >
        <span className="cf-tile-top">
          <span className="cf-tile-lab">{home("readings.cash")}</span>
          <span className="cf-tile-more">{home("why.open")}</span>
        </span>
        <span className="cf-tile-val">{tiles.today.value}</span>
        <span className="cf-tile-note cap1">
          {tiles.today.on ? `${tiles.today.source} · ${tiles.today.on}` : tiles.today.source}
        </span>
      </button>
      <div className="cf-tile">
        <span className="cf-tile-top">
          <span className="cf-tile-lab">{home("readings.lowest")}</span>
          <span className={`flag ${tiles.lowest.under ? "drift" : "ok"}`}>
            {tiles.lowest.under ? home("flag.tight") : home("flag.clear")}
          </span>
        </span>
        <span className="cf-tile-val">{tiles.lowest.value}</span>
        <span className="cf-tile-note">{tiles.lowest.week}</span>
      </div>
      <div className="cf-tile">
        <span className="cf-tile-top">
          <span className="cf-tile-lab">
            {tr("scenarios.after", { weeks: num(CASH.horizon_weeks, 0, locale) })}
          </span>
        </span>
        <span className="cf-tile-val">{tiles.end.value}</span>
        <span className="cf-tile-note cap1">{chart("band")}</span>
      </div>
    </div>
  );
}

function Weeks({ f }: { f: CashReady }) {
  const words = useCashWords();
  const home = useTr("home").tr;
  const { tr } = words;
  const rows = weekRows(f, words);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, FIRST_WEEKS);
  return (
    <SheetCard
      className="cf-weeks-card"
      title={tr("weeks.label")}
      meta={
        rows.length > FIRST_WEEKS ? (
          <button
            type="button"
            className="cf-btn"
            aria-expanded={all}
            aria-controls="cf-weeks"
            onClick={() => setAll((v) => !v)}
          >
            {all ? tr("weeks.showFewer") : tr("weeks.showAll", { count: rows.length })}
          </button>
        ) : undefined
      }
    >
      <div className="cf-wrap">
        <table className="rt rt-stack cf-weeks" id="cf-weeks">
          <caption className="sr-only">{tr("weeks.meta")}</caption>
          <thead>
            <tr>
              <th scope="col">{tr("weeks.week")}</th>
              <th scope="col" className="num">
                {tr("weeks.moneyIn")}
              </th>
              <th scope="col" className="num">
                {tr("weeks.goingOut")}
              </th>
              <th scope="col" className="num">
                {tr("weeks.balanceEnd")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.key}>
                <th scope="row">
                  <span className="cf-week">{r.week}</span>
                  {r.under && <span className="flag drift">{home("flag.tight")}</span>}
                  {r.due !== "-" && (
                    <span className="cf-due">
                      {tr("weeks.due")}: {r.due}
                    </span>
                  )}
                </th>
                <td className="num" data-label={tr("weeks.moneyIn")}>
                  {r.money_in}
                </td>
                <td className="num" data-label={tr("weeks.goingOut")}>
                  {r.going_out}
                </td>
                <td className="num" data-label={tr("weeks.balance")}>
                  {r.balance}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}

/** The four what-ifs, each a card; their sizes are changed in a side sheet. */
function WhatIf({
  view,
  f,
  onRun,
  busy,
}: {
  view: CashView;
  f: CashReady;
  onRun: (q: URLSearchParams) => void;
  busy: boolean;
}) {
  const choice = view.choice!;
  const words = useCashWords();
  const { tr, locale } = words;
  const [sizing, setSizing] = useState(false);
  const cols = scenarioColumns(f, view.tight?.index ?? null, view.scenarios ?? [], words).filter(
    (c) => c.key !== "plain",
  );
  const exp = minorUnitExponent(f.currency);
  const major = (minor: number | null) => (minor === null ? "" : String(minor / 10 ** exp));
  const weeks = weekOptions(f, words);
  const after = tr("scenarios.after", { weeks: num(CASH.horizon_weeks, 0, locale) });
  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(ev.currentTarget).entries()) {
      if (typeof v === "string" && v.trim() !== "") q.set(k, v.trim());
    }
    setSizing(false);
    onRun(q);
  };
  const assumptions = (view.scenarios ?? []).flatMap((c) =>
    c.status === "ready"
      ? c.result.assumptions.map((a) => ({ key: c.result.kind + a, text: a }))
      : [],
  );
  return (
    <section className="cf-what" aria-labelledby="cf-what-title">
      <header className="cf-sec-head">
        <div>
          <h2 className="cf-sec-title" id="cf-what-title">
            {tr("scenarios.title")}
          </h2>
          <p className="cf-sec-note">{tr("scenarios.meta")}</p>
        </div>
        <button type="button" className="cf-btn on-desk" onClick={() => setSizing(true)}>
          <SlidersHorizontal size={15} strokeWidth={1.75} aria-hidden="true" />
          {tr("scenarios.form")}
        </button>
      </header>
      <div className={busy ? "cf-cards is-busy" : "cf-cards"} aria-busy={busy}>
        {cols.map((c) =>
          c.status === "missing" ? (
            <article key={c.key} className="cf-card cf-card-missing">
              <h3 className="cf-card-title">{c.title}</h3>
              <p className="cf-card-change">
                <span className="flag drift">{tr("scenarios.missing")}</span> {c.why}
              </p>
              <p className="cf-card-links">
                <button type="button" className="cf-linkbtn" onClick={() => setSizing(true)}>
                  {tr("scenarios.form")}
                </button>
                {c.needs.map((n) => (
                  <Link key={n.href} href={n.href}>
                    {n.what}
                  </Link>
                ))}
              </p>
            </article>
          ) : (
            <article key={c.key} className="cf-card">
              <h3 className="cf-card-title">{c.title}</h3>
              <p className="cf-card-change">{c.change}</p>
              <p className="cf-card-lab">{tr("scenarios.lowest")}</p>
              <p className="cf-card-fig">
                <span className="fig">{c.lowest}</span>
                {c.lowest_week && <span className="cf-card-week cap1">{c.lowest_week}</span>}
              </p>
              <dl className="cf-card-rows">
                <div>
                  <dt>{after}</dt>
                  <dd className="fig">{c.end}</dd>
                </div>
                <div>
                  <dt>{tr("scenarios.against")}</dt>
                  <dd className="fig">{c.vs_plain}</dd>
                </div>
                <div>
                  <dt>{tr("scenarios.firstTight")}</dt>
                  <dd className="cap1">{c.tight}</dd>
                </div>
              </dl>
            </article>
          ),
        )}
      </div>
      {assumptions.length > 0 && (
        <Fold summary={tr("how")} className="on-desk">
          <ul className="cf-list">
            {assumptions.map((a) => (
              <li key={a.key}>{tr("scenarios.assumed", { text: a.text })}</li>
            ))}
          </ul>
        </Fold>
      )}
      <Sheet
        open={sizing}
        onClose={() => setSizing(false)}
        title={tr("scenarios.form")}
        kicker={tr("scenarios.title")}
        width={460}
        foot={
          <button type="submit" form="cf-sizes" className="act cf-run" disabled={busy}>
            {busy ? tr("scenarios.running") : tr("scenarios.run")}
          </button>
        }
      >
        <form id="cf-sizes" className="cf-form" onSubmit={submit} aria-label={tr("scenarios.form")}>
          <div className="cf-pair">
            <label>
              <span>{tr("scenarios.slow")}</span>
              <input
                name="slow"
                inputMode="numeric"
                defaultValue={Math.round(choice.slow_share * 100)}
                data-autofocus=""
              />
            </label>
            <label>
              <span>{tr("scenarios.from")}</span>
              <select name="slow_week" defaultValue={choice.slow_week}>
                {weeks.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="cf-pair">
            <label>
              <span>{tr("scenarios.order", { currency: f.currency })}</span>
              <input name="order" inputMode="decimal" defaultValue={major(choice.order_minor)} />
            </label>
            <label>
              <span>{tr("scenarios.in")}</span>
              <select name="order_week" defaultValue={choice.order_week}>
                {weeks.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="cf-pair">
            <label>
              <span>{tr("scenarios.hire", { currency: f.currency })}</span>
              <input name="hire" inputMode="decimal" defaultValue={major(choice.hire_minor)} />
            </label>
            <label>
              <span>{tr("scenarios.from")}</span>
              <select name="hire_week" defaultValue={choice.hire_week}>
                {weeks.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {view.price && view.price.items.length > 0 && (
            <div className="cf-pair">
              <label>
                <span>{tr("scenarios.priceOn")}</span>
                <select name="price_item" defaultValue={view.price.item ?? undefined}>
                  {view.price.items.map((i) => (
                    <option key={i.key} value={i.key}>
                      {i.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{tr("scenarios.by")}</span>
                <select name="price_step" defaultValue={view.price.step}>
                  {view.price.steps.map((s) => (
                    <option key={s} value={s}>
                      {s > 0 ? "+" : "−"}
                      {percentText(Math.abs(Math.round(s * 100)), locale)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </form>
      </Sheet>
    </section>
  );
}

function Sources({ f }: { f: CashReady }) {
  const { tr, locale } = useCashWords();
  const { sheet } = useSentenceWords();
  return (
    <SheetCard
      className="cf-sources-card"
      title={tr("sources.title")}
      meta={tr("sources.meta", {
        from: forecastDay(f.pattern.from, locale),
        to: forecastDay(f.pattern.to, locale),
      })}
    >
      <Fold summary={tr("details")}>
        <div className="cf-wrap">
          <table className="rt rt-stack cf-sources">
            <thead>
              <tr>
                <th scope="col">{tr("sources.input")}</th>
                <th scope="col">{tr("sources.value")}</th>
                <th scope="col">{tr("sources.basis")}</th>
                <th scope="col">{tr("sources.cameFrom")}</th>
              </tr>
            </thead>
            <tbody>
              {f.sources.map((s) => (
                <tr key={s.key}>
                  <th scope="row">{s.label}</th>
                  <td data-label={tr("sources.value")}>{s.value}</td>
                  <td data-label={tr("sources.basis")}>
                    {s.basis ? <span className="flag">{basisName(s.basis, sheet)}</span> : "-"}
                  </td>
                  <td data-label={tr("sources.from")}>{s.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="cf-sub">{tr("sources.assumedByName")}</p>
        <ul className="cf-list">
          {f.assumptions.map((a) => (
            <li key={a}>{tr("scenarios.assumed", { text: a })}</li>
          ))}
        </ul>
        {f.left_out.length > 0 && (
          <>
            <p className="cf-sub">{tr("sources.leftOut")}</p>
            <ul className="cf-list">
              {f.left_out.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        )}
        {f.needs.length > 0 && (
          <>
            <p className="cf-sub">{tr("sources.sharpen")}</p>
            <ul className="cf-list">
              {f.needs.map((n) => (
                <li key={n.href + n.what}>
                  <Link href={n.href}>{n.what}</Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="cf-copy cf-quiet">{tr("sources.yours")}</p>
      </Fold>
    </SheetCard>
  );
}

/** The page's shape while the forecast is read: the figures, then the chart. */
function Reading() {
  return (
    <div aria-busy="true">
      <div className="cf-tiles">
        {[0, 1, 2].map((i) => (
          <div key={i} className="cf-tile">
            <Skeleton lines={3} />
          </div>
        ))}
      </div>
      <div className="cs cf-wait">
        <Skeleton lines={6} />
      </div>
    </div>
  );
}

export function CashScreen() {
  const words = useCashWords();
  const sentences = useSentenceWords();
  const { tr } = words;
  const home = useTr("home").tr;
  const rich = useTranslations("cash");
  const [view, setView] = useState<CashView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<WhyContent | null>(null);
  const shut = useCallback(() => setWhy(null), []);
  const load = useCallback(async (q?: URLSearchParams) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cash${q && q.size > 0 ? `?${q.toString()}` : ""}`, {
        cache: "no-store",
      });
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setFailed(null);
      setView((await res.json()) as CashView);
    } catch {
      setFailed("error");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut")} forecast={null}>
        <p className="cf-copy">
          {rich.rich("startInterview", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed && !view) {
    return (
      <Frame title={tr("failedTitle")} forecast={null}>
        <p className="cf-copy">{tr("failedBody")}</p>
        <p className="cf-copy">
          <button type="button" className="cf-btn on-desk" onClick={() => void load()}>
            {home("failed.retry")}
          </button>
        </p>
      </Frame>
    );
  }
  if (!view) {
    return (
      <Frame title={tr("reading")} forecast={null}>
        <Reading />
      </Frame>
    );
  }
  const f = view.forecast;
  if (f.status !== "ready") {
    return (
      <Frame title={headTitle(view, sentences)} forecast={f}>
        <Refused f={f} />
      </Frame>
    );
  }
  return (
    <Frame
      title={headTitle(view, sentences)}
      lede={headLede(view, sentences, words)}
      notes={<HeadNotes view={view} f={f} />}
      forecast={f}
    >
      {failed === "error" && (
        <p className="cf-fail" role="alert">
          {tr("failedTitle")} {tr("failedBody")}
        </p>
      )}
      <Tiles f={f} onWhy={setWhy} />
      <CashChart
        model={cashChartModel(f, view.tight?.index ?? null, words, sentences)}
        tightWord={home("flag.tight")}
      />
      <WhatIf view={view} f={f} onRun={(q) => void load(q)} busy={busy} />
      <Weeks f={f} />
      <Sources f={f} />
      <WhySheet content={why} onClose={shut} />
    </Frame>
  );
}
