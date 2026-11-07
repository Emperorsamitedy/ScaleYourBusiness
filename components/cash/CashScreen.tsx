"use client";

// Insights · Cash flow (P5-10), on the sheet system (app/sheet.css). When
// money gets tight over the next 13 weeks, read from the business's own
// numbers: the chart with its range band and the buffer line, the first
// tight week with its reason, the week-by-week figures, four scenarios side
// by side, and every source and assumption by name.
//
// Read-only (rule 26): there is no button that pays, moves, transfers or
// collects anything, and no proposal is made here. The planning-aid note
// and the sources line are on the page in every state, refusals included.
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
import { useTranslations } from "next-intl";
import type { CashView } from "../../app/api/cash/route";
import type { CashForecast, CashReady } from "../../lib/cash/model";
import { CASH } from "../../lib/cash/model";
import { minorUnitExponent } from "../../lib/core/money";
import { CashChart } from "../charts/CashChart";
import { basisName } from "../report/basis";
import { num } from "../sheet/num";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { CashWords, SentenceWords } from "./cash-view";
import {
  cashChartModel,
  forecastDay,
  headline,
  percentText,
  scenarioColumns,
  sourcesLine,
  weekOptions,
  weekRows,
} from "./cash-view";

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
  forecast,
  children,
}: {
  title: ReactNode;
  forecast: CashForecast | null;
  children?: ReactNode;
}) {
  const { tr } = useCashWords();
  const sentences = useSentenceWords();
  return (
    <main className="screen cf-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={tr("aside")}>
        <p className="cf-note">{tr("planningNote")}</p>
        <p className="cf-note">{forecast ? sourcesLine(forecast, sentences) : tr("sourcesNone")}</p>
      </PageHead>
      {children}
    </main>
  );
}

function Refused({ f }: { f: Extract<CashForecast, { status: "refused" }> }) {
  const { tr, locale } = useCashWords();
  return (
    <div className="cf-grid">
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
        <p className="cf-copy">{f.headline}</p>
        {f.needs.length > 0 && (
          <ul className="cf-list">
            {f.needs.map((n) => (
              <li key={n.href + n.what}>
                <Link href={n.href}>{n.what}</Link>
              </li>
            ))}
          </ul>
        )}
      </SheetCard>
      <SheetCard label={tr("refused.gapLabel")} title={tr("refused.gapTitle")}>
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
      </SheetCard>
    </div>
  );
}

function Warning({ view, f }: { view: CashView; f: CashReady }) {
  const t = view.tight;
  const { tr, locale } = useCashWords();
  const rich = useTranslations("cash");
  return (
    <SheetCard
      label={tr("warning.label")}
      title={
        t
          ? tr("warning.titleTight")
          : tr("warning.titleNone", { weeks: num(CASH.horizon_weeks, 0, locale) })
      }
      meta={f.line.kind === "buffer" ? tr("warning.metaBuffer") : tr("warning.metaZero")}
    >
      {t ? (
        <>
          <p className="cf-copy cf-strong">{t.sentence}</p>
          <ul className="cf-list">
            {t.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="cf-copy">{tr("warning.none")}</p>
      )}
      <p className="cf-copy cf-quiet">
        {tr("warning.reading")}
        {f.line.kind === "zero" && (
          <>
            {" "}
            {rich.rich("warning.askBuffer", {
              link: (c) => <Link href="/intake?ask=5.3f">{c}</Link>,
            })}
          </>
        )}
      </p>
    </SheetCard>
  );
}

function Weeks({ f }: { f: CashReady }) {
  const words = useCashWords();
  const { tr } = words;
  const rows = weekRows(f, words);
  return (
    <SheetCard label={tr("weeks.label")} title={tr("weeks.title")} meta={tr("weeks.meta")}>
      <div className="cf-wrap">
        <table className="rt rt-stack cf-weeks">
          <thead>
            <tr>
              <th scope="col">{tr("weeks.week")}</th>
              <th scope="col" className="num">
                {tr("weeks.moneyIn")}
              </th>
              <th scope="col" className="num">
                {tr("weeks.goingOut")}
              </th>
              <th scope="col">{tr("weeks.dueThatWeek")}</th>
              <th scope="col" className="num">
                {tr("weeks.balanceEnd")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.week}</th>
                <td className="num" data-label={tr("weeks.moneyIn")}>
                  {r.money_in}
                </td>
                <td className="num" data-label={tr("weeks.goingOut")}>
                  {r.going_out}
                </td>
                <td data-label={tr("weeks.due")}>{r.due}</td>
                <td className="num" data-label={tr("weeks.balance")}>
                  {r.balance} {r.under && <span className="flag drift">{tr("weeks.under")}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}

function Scenarios({
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
  const cols = scenarioColumns(f, view.tight?.index ?? null, view.scenarios ?? [], words);
  const exp = minorUnitExponent(f.currency);
  const major = (minor: number | null) => (minor === null ? "" : String(minor / 10 ** exp));
  const weeks = weekOptions(f, words);
  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(ev.currentTarget).entries()) {
      if (typeof v === "string" && v.trim() !== "") q.set(k, v.trim());
    }
    onRun(q);
  };
  const rows: { key: string; label: string; pick: (c: (typeof cols)[number]) => ReactNode }[] = [
    { key: "change", label: tr("scenarios.whatChanges"), pick: (c) => c.change },
    {
      key: "lowest",
      label: tr("scenarios.lowest"),
      pick: (c) => (
        <>
          <span className="fig">{c.lowest}</span>
          {c.lowest_week && <span className="cf-src">{c.lowest_week}</span>}
        </>
      ),
    },
    {
      key: "end",
      label: tr("scenarios.after", { weeks: num(CASH.horizon_weeks, 0, locale) }),
      pick: (c) => <span className="fig">{c.end}</span>,
    },
    {
      key: "against",
      label: tr("scenarios.against"),
      pick: (c) => <span className="fig">{c.vs_plain}</span>,
    },
    { key: "tight", label: tr("scenarios.firstTight"), pick: (c) => c.tight },
  ];
  return (
    <SheetCard
      label={tr("scenarios.label")}
      title={tr("scenarios.title")}
      meta={tr("scenarios.meta")}
    >
      <form className="cf-form" onSubmit={submit} aria-label={tr("scenarios.form")}>
        <label>
          <span>{tr("scenarios.slow")}</span>
          <input
            name="slow"
            inputMode="numeric"
            defaultValue={Math.round(choice.slow_share * 100)}
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
        {view.price && view.price.items.length > 0 && (
          <>
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
          </>
        )}
        <button type="submit" className="act" disabled={busy}>
          {busy ? tr("scenarios.running") : tr("scenarios.run")}
        </button>
      </form>
      <div className="cf-wrap">
        <table className="rt cf-scen">
          <thead>
            <tr>
              <th scope="col">{tr("scenarios.measure")}</th>
              {cols.map((c) => (
                <th scope="col" key={c.key} className="num">
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                {cols.map((c) =>
                  c.status === "missing" ? (
                    row.key === "change" ? (
                      <td key={c.key} className="num" rowSpan={rows.length}>
                        <span className="flag drift">{tr("scenarios.missing")}</span>
                        <span className="cf-src">{c.why}</span>
                        {c.needs.map((n) => (
                          <Link key={n.href} className="cf-src" href={n.href}>
                            {n.what}
                          </Link>
                        ))}
                      </td>
                    ) : null
                  ) : (
                    <td key={c.key} className="num">
                      {row.pick(c)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="cf-list cf-quiet">
        {(view.scenarios ?? []).flatMap((c) =>
          c.status === "ready"
            ? c.result.assumptions.map((a) => (
                <li key={c.result.kind + a}>{tr("scenarios.assumed", { text: a })}</li>
              ))
            : [],
        )}
      </ul>
    </SheetCard>
  );
}

function Sources({ f }: { f: CashReady }) {
  const { tr, locale } = useCashWords();
  const { sheet } = useSentenceWords();
  return (
    <SheetCard
      label={tr("sources.label")}
      title={tr("sources.title")}
      meta={tr("sources.meta", {
        from: forecastDay(f.pattern.from, locale),
        to: forecastDay(f.pattern.to, locale),
      })}
    >
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
                {s.basis ? <span className="flag">{basisName(s.basis, sheet)}</span> : "—"}
              </td>
              <td data-label={tr("sources.from")}>{s.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
    </SheetCard>
  );
}

export function CashScreen() {
  const words = useCashWords();
  const sentences = useSentenceWords();
  const { tr } = words;
  const rich = useTranslations("cash");
  const [view, setView] = useState<CashView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (q?: URLSearchParams) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/cash${q && q.size > 0 ? `?${q.toString()}` : ""}`, {
        cache: "no-store",
      });
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
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
  if (failed) {
    return (
      <Frame title={tr("failedTitle")} forecast={null}>
        <p className="cf-copy">{tr("failedBody")}</p>
      </Frame>
    );
  }
  if (!view) return <Frame title={tr("reading")} forecast={null} />;
  const f = view.forecast;
  if (f.status !== "ready") {
    return (
      <Frame title={headline(view, sentences)} forecast={f}>
        <Refused f={f} />
      </Frame>
    );
  }
  return (
    <Frame title={headline(view, sentences)} forecast={f}>
      <CashChart model={cashChartModel(f, view.tight?.index ?? null, words, sentences)} />
      <div className="cf-grid">
        <Warning view={view} f={f} />
        <Sources f={f} />
      </div>
      <Scenarios view={view} f={f} onRun={(q) => void load(q)} busy={busy} />
      <Weeks f={f} />
    </Frame>
  );
}
