"use client";

// Grow · Campaign simulator (feature 36). Before anything is spent or
// sent, the owner picks two to four campaign options and sees each one's
// likely range side by side, worked out from the business's own numbers:
// a ruled table whose rows are measures and whose columns are options,
// each cell "low – high" with the basis of what it rests on, a whisker per
// option for profit, and under it every option's chain — its inputs with
// their sources, what's missing and what would fill it, the arithmetic,
// the worst case, and what the trust layer can say about similar past
// proposals. "Propose this" makes the normal proposal for its kind; it
// lands in "Waiting for you" and nothing runs until the owner approves it.
//
// The arithmetic is lib/simulate/model.ts, run here on the figures
// /api/simulate reads; the server runs it again before proposing.
//
// L-3b (TASKS-LANGUAGES.md): the screen's fixed words are the "simulate"
// catalogue, every figure in the reader's locale and the business's
// currency. L-4b: what lib/simulate words from the numbers — option titles
// and "what", sources, needs, formulas, worst-case words, the guard — is the
// "simulateWords" catalogue (useSimText); the cross-check and the catalog's
// titles arrive from /api/simulate already in the reader's words.

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import "../../app/simulate.css";
import { minorUnitExponent } from "../../lib/core/money";
import { dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { basisName } from "../report/basis";
import { useAppLocale, useTr } from "../sheet/useTr";
import type { Tr } from "../../lib/i18n/tr";
import type { SimText } from "../../lib/simulate/words";
import { SIM_WORDS } from "../../lib/simulate/words";
import type {
  Catalog,
  Comparison,
  OptionResult,
  SimInputs,
  SimOption,
} from "../../lib/simulate/model";
import { SIM, compareOptions, valueText } from "../../lib/simulate/model";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import {
  DEFAULT_SHARE,
  cellView,
  defaultPicks,
  flagWord,
  headline,
  sharePct,
  shareSteps,
  whiskerChart,
} from "./view";
import type { SimWords, WhiskerSource } from "./view";
import { SimTabs } from "./SimTabs";

/** The simulator's words for a client component: its catalogue, the basis names, the locale. */
export function useSimWords(): SimWords {
  const { tr, locale } = useTr("simulate");
  const { tr: sheet } = useTr("sheet");
  return { tr, sheet, locale };
}

/**
 * L-4b: the sentences lib/simulate builds from the numbers — titles,
 * sources, needs, formulas, the worst case, the guard — in the reader's
 * words ("simulateWords"), held steady across renders so the arithmetic
 * isn't redone for nothing.
 */
export function useSimText(): SimText {
  const t = useTranslations(SIM_WORDS as "simulate") as unknown as Tr;
  const locale = useAppLocale();
  return useMemo(() => ({ tr: (key, values) => t(key, values), locale }), [t, locale]);
}

/** "As of" a day, in the reader's own date ("7 Nov 2026"); anything else as it came. */
export function asOfDay(day: string, locale: AppLocale): string {
  return /^\d{4}-\d{2}-\d{2}/.test(day) ? dayMonthYear(day, locale) : day;
}

interface Payload {
  inputs: SimInputs;
  catalog: Catalog;
}

type Load =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | ({ phase: "ready" } & Payload);

/** A pick as the picker holds it: the share and the new budget are read when it's resolved. */
type PickId = string;

interface Notice {
  ok: boolean;
  text: string;
}

function pickIdOf(o: SimOption): PickId {
  if (o.kind === "email") return `email:${o.segment}`;
  if (o.kind === "content") return "content";
  if (o.change === "new") return "ads:new";
  return `ads:${o.campaign_ref}:${o.change}`;
}

function resolve(
  id: PickId,
  shares: Record<string, number>,
  budgetMinor: number | null,
  adsCurrency: string,
): SimOption | null {
  if (id === "email:lapsed" || id === "email:vip") {
    return { kind: "email", segment: id === "email:lapsed" ? "lapsed" : "vip" };
  }
  if (id === "content") return { kind: "content" };
  if (id === "ads:new") {
    return { kind: "ads", change: "new", daily_budget_minor: budgetMinor, currency: adsCurrency };
  }
  const m = /^ads:(.+):(raise|lower|pause)$/.exec(id);
  if (!m) return null;
  const [, ref, change] = m as unknown as [string, string, "raise" | "lower" | "pause"];
  if (change === "pause") return { kind: "ads", change: "pause", campaign_ref: ref };
  return { kind: "ads", change, campaign_ref: ref, share: shares[ref] ?? DEFAULT_SHARE };
}

/** "12.50" in the currency's major units → integer minor units, or null. */
function budgetToMinor(text: string, currency: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const minor = Math.round(Number(t) * 10 ** minorUnitExponent(currency));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
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
  const { tr } = useTr("simulate");
  return (
    <main className="screen sim-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      <SimTabs current="campaigns" />
      {children}
    </main>
  );
}

function Toggle({
  on,
  disabled,
  onClick,
  children,
  label,
}: {
  on: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`act sim-toggle${on ? " solid" : ""}`}
      aria-pressed={on}
      aria-label={label}
      disabled={disabled && !on}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Picker({
  catalog,
  picks,
  setPicks,
  shares,
  setShares,
  budget,
  setBudget,
  adsCurrency,
}: {
  catalog: Catalog;
  picks: PickId[];
  setPicks: (p: PickId[]) => void;
  shares: Record<string, number>;
  setShares: (s: Record<string, number>) => void;
  budget: string;
  setBudget: (b: string) => void;
  adsCurrency: string;
}) {
  const { tr, locale } = useTr("simulate");
  const full = picks.length >= SIM.max_options;
  const toggle = (id: PickId) =>
    setPicks(picks.includes(id) ? picks.filter((p) => p !== id) : full ? picks : [...picks, id]);
  const t = (id: PickId, text: string, label: string) => (
    <Toggle on={picks.includes(id)} disabled={full} onClick={() => toggle(id)} label={label}>
      {text}
    </Toggle>
  );
  const pickWord = (id: PickId) =>
    picks.includes(id) ? tr("picker.picked") : tr("picker.compare");
  const kindHead = tr("picker.kind");
  const fromHead = tr("picker.fromNumbers");
  return (
    <SheetCard
      label={tr("picker.label", { min: SIM.min_options, max: SIM.max_options })}
      title={tr("picker.title")}
      meta={tr(full ? "picker.metaFull" : "picker.meta", { count: picks.length })}
    >
      <div className="sim-wrap">
        <table className="rt rt-stack sim-pick">
          <thead>
            <tr>
              <th scope="col">{kindHead}</th>
              <th scope="col">{tr("picker.option")}</th>
              <th scope="col">{fromHead}</th>
              <th scope="col">
                <span className="sr-only">{tr("picker.compare")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {catalog.email.map((e) => (
              <tr key={e.key} className={picks.includes(`email:${e.key}`) ? "on" : undefined}>
                <td className="src" data-label={kindHead}>
                  {tr("kind.email")}
                </td>
                <th scope="row">{e.title}</th>
                <td className="src" data-label={fromHead}>
                  {e.emailable > 0
                    ? tr("picker.emailable", { count: num(e.emailable, 0, locale) })
                    : tr("picker.noEmailable")}
                </td>
                <td className="sim-acts-cell">
                  <div className="sim-acts">
                    {t(`email:${e.key}`, pickWord(`email:${e.key}`), e.title)}
                  </div>
                </td>
              </tr>
            ))}
            {catalog.campaigns.map((c) => {
              const share = shares[c.ref] ?? DEFAULT_SHARE;
              const any = ["raise", "lower", "pause"].some((k) =>
                picks.includes(`ads:${c.ref}:${k}`),
              );
              return (
                <tr key={c.ref} className={any ? "on" : undefined}>
                  <td className="src" data-label={kindHead}>
                    {tr("kind.ads")}
                  </td>
                  <th scope="row">{tr("picker.quoted", { name: c.name })}</th>
                  <td className="src" data-label={fromHead}>
                    {c.measured_days > 0
                      ? tr("picker.daily", {
                          amount: moneyText(c.daily_minor, c.currency, locale),
                          days: c.measured_days,
                        })
                      : tr("picker.noSpend")}
                  </td>
                  <td className="sim-acts-cell">
                    <div className="sim-acts">
                      <label className="sim-share">
                        <span className="sr-only">{tr("picker.shareFor", { name: c.name })}</span>
                        <select
                          value={share}
                          onChange={(ev) =>
                            setShares({ ...shares, [c.ref]: Number(ev.target.value) })
                          }
                        >
                          {shareSteps().map((s) => (
                            <option key={s} value={s}>
                              {sharePct(s, locale)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {t(
                        `ads:${c.ref}:raise`,
                        tr("picker.raise"),
                        tr("picker.raiseAria", { name: c.name, share: sharePct(share, locale) }),
                      )}
                      {t(
                        `ads:${c.ref}:lower`,
                        tr("picker.cut"),
                        tr("picker.cutAria", { name: c.name, share: sharePct(share, locale) }),
                      )}
                      {t(
                        `ads:${c.ref}:pause`,
                        tr("picker.pause"),
                        tr("picker.pauseAria", { name: c.name }),
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr className={picks.includes("ads:new") ? "on" : undefined}>
              <td className="src" data-label={kindHead}>
                {tr("kind.ads")}
              </td>
              <th scope="row">{tr("picker.newCampaign")}</th>
              <td className="src" data-label={fromHead}>
                {catalog.campaigns.length > 0
                  ? tr("picker.judged")
                  : catalog.ads_connected
                    ? tr("picker.noneMeasured")
                    : tr("picker.metaOff")}
              </td>
              <td className="sim-acts-cell">
                <div className="sim-acts">
                  <label className="sim-budget">
                    <span>{tr("picker.perDay", { currency: adsCurrency })}</span>
                    <input
                      inputMode="decimal"
                      value={budget}
                      placeholder="0"
                      onChange={(ev) => setBudget(ev.target.value)}
                    />
                  </label>
                  {t("ads:new", pickWord("ads:new"), tr("picker.newCampaign"))}
                </div>
              </td>
            </tr>
            <tr className={picks.includes("content") ? "on" : undefined}>
              <td className="src" data-label={kindHead}>
                {tr("kind.content")}
              </td>
              <th scope="row">
                {tr("picker.contentCalendar", { weeks: num(SIM.horizon_days / 7, 0, locale) })}
              </th>
              <td className="src" data-label={fromHead}>
                {catalog.content.posts > 0
                  ? tr("picker.posts", { count: catalog.content.posts })
                  : tr("picker.noSocial")}
              </td>
              <td className="sim-acts-cell">
                <div className="sim-acts">
                  {t("content", pickWord("content"), tr("picker.contentAria"))}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </SheetCard>
  );
}

function SideBySide({ cmp }: { cmp: Comparison }) {
  const words = useSimWords();
  const { tr, locale } = words;
  return (
    <SheetCard
      label={tr("side.label", { days: num(SIM.horizon_days, 0, locale) })}
      title={tr("side.title")}
      meta={tr("side.meta")}
    >
      <div className="sim-wrap">
        <table className="rt sim-table">
          <thead>
            <tr>
              <th scope="col">{tr("side.measure")}</th>
              {cmp.options.map((o) => (
                <th scope="col" key={o.key} className="num">
                  {o.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cmp.rows.map((row) => (
              <tr key={row.measure}>
                <th scope="row">
                  {tr(`measure.${row.measure}`)}
                  <small>
                    {row.unit === "money" ? `${cmp.options[0]?.currency ?? ""}` : tr("side.count")}
                  </small>
                  {row.note && <small className="flag drift">{row.note}</small>}
                </th>
                {row.cells.map((cell, i) => {
                  const o = cmp.options[i]!;
                  const v = cellView(cell, row.unit, o.currency, words);
                  return (
                    <td key={o.key} className="num" title={v.detail}>
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

export function Whiskers({
  results,
  caption,
}: {
  results: readonly WhiskerSource[];
  caption?: string;
}) {
  const words = useSimWords();
  const chart = whiskerChart(results, words);
  if (!chart) {
    return <p className="sim-note">{words.tr("whisker.currencies")}</p>;
  }
  const figcaption = caption ?? words.tr("whisker.caption");
  const rowH = 36;
  const top = 8;
  const h = top + chart.rows.length * rowH + 22;
  return (
    <figure className="sim-chart">
      <figcaption className="cs-label">{figcaption}</figcaption>
      <div className="sim-chart-grid">
        <ol className="sim-chart-labels" style={{ paddingTop: top }}>
          {chart.rows.map((r) => (
            <li key={r.key} style={{ height: rowH }}>
              {r.label}
            </li>
          ))}
        </ol>
        <svg
          className="sim-svg"
          style={{ height: h }}
          viewBox={`0 0 100 ${h}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={chart.rows.map((r) => `${r.label}: ${r.text}`).join("; ")}
        >
          {chart.ticks.map((t) => (
            <line key={t.at} x1={t.at} x2={t.at} y1={top} y2={h - 22} className="sim-grid" />
          ))}
          <line x1={chart.zero} x2={chart.zero} y1={top - 4} y2={h - 18} className="sim-zero" />
          {chart.rows.map((r, i) => {
            const y = top + i * rowH + rowH / 2;
            if (r.low === null || r.high === null) return null;
            return (
              <g key={r.key}>
                <line x1={r.low} x2={r.high} y1={y} y2={y} className="sim-whisker" />
                <line x1={r.low} x2={r.low} y1={y - 6} y2={y + 6} className="sim-whisker" />
                <line x1={r.high} x2={r.high} y1={y - 6} y2={y + 6} className="sim-whisker" />
                {r.worst !== null && (
                  <line x1={r.worst} x2={r.worst} y1={y - 3.5} y2={y + 3.5} className="sim-worst" />
                )}
              </g>
            );
          })}
        </svg>
        <ol className="sim-chart-values" style={{ paddingTop: top }}>
          {chart.rows.map((r) => (
            <li key={r.key} style={{ height: rowH }} className="fig">
              {r.text}
            </li>
          ))}
        </ol>
      </div>
      <div className="sim-ticks" aria-hidden="true">
        {chart.ticks.map((t) => (
          <span key={t.at} style={{ left: `${t.at}%` }}>
            {t.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

function OptionCard({
  r,
  notice,
  busy,
  onPropose,
}: {
  r: OptionResult;
  notice: Notice | undefined;
  busy: boolean;
  onPropose: () => void;
}) {
  const { tr, sheet, locale } = useSimWords();
  const t = useTranslations("simulate");
  const cur = r.currency;
  const measures = (["cost", "reached", "orders", "revenue", "profit", "worst"] as const).filter(
    (m) => r.measures[m].status === "range",
  );
  const valueHead = tr("option.value");
  const basisHead = tr("option.basis");
  const fromHead = tr("option.from");
  return (
    <SheetCard
      className="sim-card"
      label={tr(`kind.${r.kind}`)}
      title={r.title}
      meta={r.proposable.ok ? tr("option.canPropose") : tr("option.notProposable")}
      foot={
        <div className="sim-foot">
          {r.proposable.ok ? (
            <button type="button" className="act" disabled={busy} onClick={onPropose}>
              {busy ? (
                <>
                  <span className="live-dot" aria-hidden="true" /> {tr("option.proposing")}
                </>
              ) : (
                tr("option.propose")
              )}
            </button>
          ) : (
            <span>{r.proposable.why}</span>
          )}
          {notice && (
            <span role="status" className={notice.ok ? "sim-done" : undefined}>
              {notice.ok
                ? t.rich("notice.proposed", {
                    link: (c) => <Link href="/proposals">{c}</Link>,
                  })
                : notice.text}
            </span>
          )}
        </div>
      }
    >
      <p className="sim-what">{r.what}</p>
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
                  {i.range ? valueText(i.range, i.unit, cur, true, locale) : "—"}
                </td>
                <td data-label={basisHead}>
                  {i.basis ? (
                    <span className="sim-basis">{basisName(i.basis, sheet)}</span>
                  ) : (
                    <span className="flag drift">{tr("option.missing")}</span>
                  )}
                </td>
                <td className="src" data-label={fromHead}>
                  {i.range
                    ? i.source
                    : tr("option.needs", { what: i.needs ?? tr("option.aSource") })}
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
                <dt>{tr(`math.${m}`)}</dt>
                <dd className="fig">{c.formula}</dd>
              </div>
            ) : null;
          })}
        </dl>
      )}
      <p className="sim-worst-words">
        <span className="cs-label">{tr("option.worstCase")}</span> {r.worst_words}
      </p>
      {r.guard && (
        <p className="sim-guard">
          <span className="flag alarm">{tr("option.overLimit")}</span> {r.guard}.
        </p>
      )}
      <p className="sim-check">
        <span className="cs-label">{tr("option.check")}</span> {r.cross_check.line}
      </p>
    </SheetCard>
  );
}

export function SimulateScreen() {
  const { tr, locale } = useTr("simulate");
  const t = useTranslations("simulate");
  const text = useSimText();
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [picks, setPicks] = useState<PickId[]>([]);
  const [shares, setShares] = useState<Record<string, number>>({});
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, Notice>>({});

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/simulate");
        if (res.status === 401) return setLoad({ phase: "signedout" });
        if (!res.ok) return setLoad({ phase: "error" });
        const data = (await res.json()) as Payload;
        setLoad({ phase: "ready", ...data });
        setPicks(defaultPicks(data.catalog, data.inputs).map(pickIdOf));
      } catch {
        setLoad({ phase: "error" });
      }
    })();
  }, []);

  const ready = load.phase === "ready" ? load : null;
  const adsCurrency = ready?.catalog.campaigns[0]?.currency ?? ready?.catalog.currency ?? "EUR";
  const options = useMemo(() => {
    if (!ready) return [];
    const minor = budgetToMinor(budget, adsCurrency);
    return picks
      .map((id) => resolve(id, shares, minor, adsCurrency))
      .filter((o): o is SimOption => o !== null);
  }, [ready, picks, shares, budget, adsCurrency]);
  const cmp = useMemo(() => {
    if (!ready || options.length < SIM.min_options || options.length > SIM.max_options) return null;
    return compareOptions(options, ready.inputs, text);
  }, [ready, options, text]);

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
      <Frame title={tr("failed.title")}>
        <p className="sim-note on-desk">{tr("failed.body")}</p>
      </Frame>
    );
  }
  if (!ready) return <Frame title={tr("loading")} />;

  const propose = async (r: OptionResult) => {
    setBusy(r.key);
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose", option: r.option }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        proposal?: { status: string; blocked_by_limit: string | null } | null;
        skipped?: string | null;
        error?: string;
      };
      const notice: Notice =
        res.status === 401
          ? { ok: false, text: tr("notice.signIn") }
          : !res.ok
            ? { ok: false, text: j.error ?? tr("notice.failed") }
            : j.proposal?.status === "blocked"
              ? {
                  ok: false,
                  text: tr("notice.blocked", {
                    limit: j.proposal.blocked_by_limit ?? tr("notice.aLimit"),
                  }),
                }
              : j.proposal
                ? // Worded where it's shown: the sentence ends in the link to the queue.
                  { ok: true, text: "" }
                : {
                    ok: false,
                    text: tr("notice.notProposed", { why: j.skipped ?? tr("notice.nothing") }),
                  };
      setNotices((n) => ({ ...n, [r.key]: notice }));
    } finally {
      setBusy(null);
    }
  };

  const aside = tr("aside.asOf", {
    date: asOfDay(ready.inputs.as_of, locale),
    currency: ready.inputs.currency,
  });

  return (
    <Frame title={headline(ready.catalog, ready.inputs, tr)} aside={aside}>
      <div className="sim-stack">
        <Picker
          catalog={ready.catalog}
          picks={picks}
          setPicks={setPicks}
          shares={shares}
          setShares={setShares}
          budget={budget}
          setBudget={setBudget}
          adsCurrency={adsCurrency}
        />
        {cmp ? (
          <>
            <SideBySide cmp={cmp} />
            <SheetCard label={tr("profitCard.label")} title={tr("profitCard.title")}>
              <Whiskers results={cmp.options} />
            </SheetCard>
            <div className="sim-cards">
              {cmp.options.map((r) => (
                <OptionCard
                  key={r.key}
                  r={r}
                  notice={notices[r.key]}
                  busy={busy === r.key}
                  onPropose={() => void propose(r)}
                />
              ))}
            </div>
          </>
        ) : (
          <p className="sim-note on-desk">
            {picks.length === 0 ? tr("pickN", { count: SIM.min_options }) : tr("pickOne")}
          </p>
        )}
      </div>
    </Frame>
  );
}
