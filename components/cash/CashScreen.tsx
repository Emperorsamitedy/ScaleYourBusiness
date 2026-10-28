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

import "../../app/cash.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { CashView } from "../../app/api/cash/route";
import type { CashForecast, CashReady } from "../../lib/cash/model";
import { minorUnitExponent } from "../../lib/core/money";
import { CashChart } from "../charts/CashChart";
import { PageHead, SheetCard } from "../sheet/PageHead";
import {
  PLANNING_NOTE,
  cashChartModel,
  headline,
  scenarioColumns,
  sourcesLine,
  weekOptions,
  weekRows,
} from "./cash-view";

function Frame({
  title,
  forecast,
  children,
}: {
  title: ReactNode;
  forecast: CashForecast | null;
  children?: ReactNode;
}) {
  return (
    <main className="screen cf-screen">
      <PageHead kicker="Insights · Cash flow" title={title} aside="Planning aid · read-only">
        <p className="cf-note">{PLANNING_NOTE}</p>
        <p className="cf-note">
          {forecast
            ? sourcesLine(forecast)
            : "Sources: your stated cash, costs and measured sales."}
        </p>
      </PageHead>
      {children}
    </main>
  );
}

function Refused({ f }: { f: Extract<CashForecast, { status: "refused" }> }) {
  return (
    <div className="cf-grid">
      <SheetCard
        label={f.history ? `How much there is · ${f.history.source}` : "How much there is"}
        title={
          f.history
            ? `${f.history.complete_weeks} of ${f.history.needed_weeks} complete weeks`
            : "Nothing to build a forecast on yet"
        }
        meta={f.ready_on ? `Ready from around ${f.ready_on}, if syncs keep running` : undefined}
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
      <SheetCard label="What I can and can't say yet" title="Honest about the gap">
        <p className="cf-sub">I can</p>
        <ul className="cf-list">
          {f.can.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p className="cf-sub">I can&apos;t yet</p>
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
  return (
    <SheetCard
      label="When money gets tight"
      title={t ? "The first tight week" : "No tight week in the next 13"}
      meta={
        f.line.kind === "buffer"
          ? "Against the least you want in the account"
          : "No buffer stated: against an empty account"
      }
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
        <p className="cf-copy">
          At the cautious end (slow sales, slow payouts) the balance stays above the line every
          week.
        </p>
      )}
      <p className="cf-copy cf-quiet">
        This is a reading of your numbers, written to your Watching log and weekly summary. Nothing
        is proposed or done about it.
        {f.line.kind === "zero" && (
          <>
            {" "}
            <Link href="/intake?ask=5.3f">
              Tell me the least you&apos;d want in the account
            </Link>{" "}
            and I&apos;ll draw that line instead.
          </>
        )}
      </p>
    </SheetCard>
  );
}

function Weeks({ f }: { f: CashReady }) {
  const rows = weekRows(f);
  return (
    <SheetCard
      label="Week by week"
      title="Money in, money out, the balance"
      meta="Cautious – hopeful, whole units"
    >
      <div className="cf-wrap">
        <table className="rt rt-stack cf-weeks">
          <thead>
            <tr>
              <th scope="col">Week</th>
              <th scope="col" className="num">
                Money in
              </th>
              <th scope="col" className="num">
                Going out
              </th>
              <th scope="col">Due that week</th>
              <th scope="col" className="num">
                Balance at the end
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.week}</th>
                <td className="num" data-label="Money in">
                  {r.money_in}
                </td>
                <td className="num" data-label="Going out">
                  {r.going_out}
                </td>
                <td data-label="Due">{r.due}</td>
                <td className="num" data-label="Balance">
                  {r.balance} {r.under && <span className="flag drift">UNDER THE LINE</span>}
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
  const cols = scenarioColumns(f, view.tight?.index ?? null, view.scenarios ?? []);
  const exp = minorUnitExponent(f.currency);
  const major = (minor: number | null) => (minor === null ? "" : String(minor / 10 ** exp));
  const weeks = weekOptions(f);
  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const q = new URLSearchParams();
    for (const [k, v] of new FormData(ev.currentTarget).entries()) {
      if (typeof v === "string" && v.trim() !== "") q.set(k, v.trim());
    }
    onRun(q);
  };
  const rows: { label: string; pick: (c: (typeof cols)[number]) => ReactNode }[] = [
    { label: "What changes", pick: (c) => c.change },
    {
      label: "Lowest balance, cautious end",
      pick: (c) => (
        <>
          <span className="fig">{c.lowest}</span>
          {c.lowest_week && <span className="cf-src">{c.lowest_week}</span>}
        </>
      ),
    },
    { label: "Balance after 13 weeks", pick: (c) => <span className="fig">{c.end}</span> },
    { label: "Against as things are", pick: (c) => <span className="fig">{c.vs_plain}</span> },
    { label: "First tight week", pick: (c) => c.tight },
  ];
  return (
    <SheetCard
      label="Scenarios · side by side"
      title="What if…"
      meta="Each runs the same forecast with one change"
    >
      <form className="cf-form" onSubmit={submit} aria-label="Scenario sizes">
        <label>
          <span>Slow month, % lower</span>
          <input
            name="slow"
            inputMode="numeric"
            defaultValue={Math.round(choice.slow_share * 100)}
          />
        </label>
        <label>
          <span>from</span>
          <select name="slow_week" defaultValue={choice.slow_week}>
            {weeks.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Big order, {f.currency}</span>
          <input name="order" inputMode="decimal" defaultValue={major(choice.order_minor)} />
        </label>
        <label>
          <span>in</span>
          <select name="order_week" defaultValue={choice.order_week}>
            {weeks.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Hire, {f.currency} a month</span>
          <input name="hire" inputMode="decimal" defaultValue={major(choice.hire_minor)} />
        </label>
        <label>
          <span>from</span>
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
              <span>Price change on</span>
              <select name="price_item" defaultValue={view.price.item ?? undefined}>
                {view.price.items.map((i) => (
                  <option key={i.key} value={i.key}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>by</span>
              <select name="price_step" defaultValue={view.price.step}>
                {view.price.steps.map((s) => (
                  <option key={s} value={s}>
                    {s > 0 ? "+" : "−"}
                    {Math.abs(Math.round(s * 100))}%
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <button type="submit" className="act" disabled={busy}>
          {busy ? "Working it out…" : "Work it out"}
        </button>
      </form>
      <div className="cf-wrap">
        <table className="rt cf-scen">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              {cols.map((c) => (
                <th scope="col" key={c.key} className="num">
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {cols.map((c) =>
                  c.status === "missing" ? (
                    row.label === "What changes" ? (
                      <td key={c.key} className="num" rowSpan={rows.length}>
                        <span className="flag drift">MISSING</span>
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
            ? c.result.assumptions.map((a) => <li key={c.result.kind + a}>ASSUMED · {a}</li>)
            : [],
        )}
      </ul>
    </SheetCard>
  );
}

function Sources({ f }: { f: CashReady }) {
  return (
    <SheetCard
      label="What this is built on"
      title="Sources, and what I assumed"
      meta={`History ${f.pattern.from} to ${f.pattern.to}`}
    >
      <table className="rt rt-stack cf-sources">
        <thead>
          <tr>
            <th scope="col">Input</th>
            <th scope="col">Value</th>
            <th scope="col">Basis</th>
            <th scope="col">Where it came from</th>
          </tr>
        </thead>
        <tbody>
          {f.sources.map((s) => (
            <tr key={s.label}>
              <th scope="row">{s.label}</th>
              <td data-label="Value">{s.value}</td>
              <td data-label="Basis">{s.basis ? <span className="flag">{s.basis}</span> : "—"}</td>
              <td data-label="From">{s.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="cf-sub">Assumed, by name</p>
      <ul className="cf-list">
        {f.assumptions.map((a) => (
          <li key={a}>ASSUMED · {a}</li>
        ))}
      </ul>
      {f.left_out.length > 0 && (
        <>
          <p className="cf-sub">Left out</p>
          <ul className="cf-list">
            {f.left_out.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </>
      )}
      {f.needs.length > 0 && (
        <>
          <p className="cf-sub">Would sharpen it</p>
          <ul className="cf-list">
            {f.needs.map((n) => (
              <li key={n.href + n.what}>
                <Link href={n.href}>{n.what}</Link>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="cf-copy cf-quiet">
        Nothing here is an industry average: every figure is yours, measured or stated, or named
        above as assumed.
      </p>
    </SheetCard>
  );
}

export function CashScreen() {
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
      <Frame title="There's no business here yet." forecast={null}>
        <p className="cf-copy">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="The cash forecast didn't load." forecast={null}>
        <p className="cf-copy">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading your numbers…" forecast={null} />;
  const f = view.forecast;
  if (f.status !== "ready") {
    return (
      <Frame title={headline(view)} forecast={f}>
        <Refused f={f} />
      </Frame>
    );
  }
  return (
    <Frame title={headline(view)} forecast={f}>
      <CashChart model={cashChartModel(f, view.tight?.index ?? null)} />
      <div className="cf-grid">
        <Warning view={view} f={f} />
        <Sources f={f} />
      </div>
      <Scenarios view={view} f={f} onRun={(q) => void load(q)} busy={busy} />
      <Weeks f={f} />
    </Frame>
  );
}
