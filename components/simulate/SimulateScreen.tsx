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

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import "../../app/simulate.css";
import { minorUnitExponent } from "../../lib/core/money";
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
  KIND_LABEL,
  cellView,
  defaultPicks,
  headline,
  shareSteps,
  whiskerChart,
} from "./view";
import type { WhiskerSource } from "./view";
import { SimTabs } from "./SimTabs";

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
  return (
    <main className="screen sim-screen">
      <PageHead kicker="Grow · Campaign simulator" title={title} aside={aside} />
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
  const full = picks.length >= SIM.max_options;
  const toggle = (id: PickId) =>
    setPicks(picks.includes(id) ? picks.filter((p) => p !== id) : full ? picks : [...picks, id]);
  const t = (id: PickId, text: string, label: string) => (
    <Toggle on={picks.includes(id)} disabled={full} onClick={() => toggle(id)} label={label}>
      {text}
    </Toggle>
  );
  return (
    <SheetCard
      label={`Pick ${SIM.min_options} to ${SIM.max_options}`}
      title="Campaign options"
      meta={`${picks.length} picked${full ? " · that's the most I compare at once" : ""}`}
    >
      <div className="sim-wrap">
        <table className="rt rt-stack sim-pick">
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Option</th>
              <th scope="col">From your numbers</th>
              <th scope="col">
                <span className="sr-only">Compare</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {catalog.email.map((e) => (
              <tr key={e.key} className={picks.includes(`email:${e.key}`) ? "on" : undefined}>
                <td className="src" data-label="Kind">
                  Email
                </td>
                <th scope="row">{e.title}</th>
                <td className="src" data-label="From your numbers">
                  {e.emailable > 0
                    ? `${num(e.emailable)} said yes to email`
                    : "nobody here said yes to email"}
                </td>
                <td className="sim-acts-cell">
                  <div className="sim-acts">
                    {t(
                      `email:${e.key}`,
                      picks.includes(`email:${e.key}`) ? "Picked" : "Compare",
                      e.title,
                    )}
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
                  <td className="src" data-label="Kind">
                    Meta ads
                  </td>
                  <th scope="row">&ldquo;{c.name}&rdquo;</th>
                  <td className="src" data-label="From your numbers">
                    {c.measured_days > 0
                      ? `${moneyText(c.daily_minor, c.currency)} a day · ${c.measured_days} measured days`
                      : "no measured spend lately"}
                  </td>
                  <td className="sim-acts-cell">
                    <div className="sim-acts">
                      <label className="sim-share">
                        <span className="sr-only">Budget change for {c.name}</span>
                        <select
                          value={share}
                          onChange={(ev) =>
                            setShares({ ...shares, [c.ref]: Number(ev.target.value) })
                          }
                        >
                          {shareSteps().map((s) => (
                            <option key={s} value={s}>
                              {Math.round(s * 100)}%
                            </option>
                          ))}
                        </select>
                      </label>
                      {t(
                        `ads:${c.ref}:raise`,
                        "Raise",
                        `Raise ${c.name} by ${Math.round(share * 100)}%`,
                      )}
                      {t(
                        `ads:${c.ref}:lower`,
                        "Cut",
                        `Cut ${c.name} by ${Math.round(share * 100)}%`,
                      )}
                      {t(`ads:${c.ref}:pause`, "Pause", `Pause ${c.name}`)}
                    </div>
                  </td>
                </tr>
              );
            })}
            <tr className={picks.includes("ads:new") ? "on" : undefined}>
              <td className="src" data-label="Kind">
                Meta ads
              </td>
              <th scope="row">A new campaign</th>
              <td className="src" data-label="From your numbers">
                {catalog.campaigns.length > 0
                  ? "judged on what your other campaigns return"
                  : catalog.ads_connected
                    ? "no campaign measured yet to judge it by"
                    : "Meta isn't connected"}
              </td>
              <td className="sim-acts-cell">
                <div className="sim-acts">
                  <label className="sim-budget">
                    <span>{adsCurrency} a day</span>
                    <input
                      inputMode="decimal"
                      value={budget}
                      placeholder="0"
                      onChange={(ev) => setBudget(ev.target.value)}
                    />
                  </label>
                  {t("ads:new", picks.includes("ads:new") ? "Picked" : "Compare", "A new campaign")}
                </div>
              </td>
            </tr>
            <tr className={picks.includes("content") ? "on" : undefined}>
              <td className="src" data-label="Kind">
                Content
              </td>
              <th scope="row">A {SIM.horizon_days / 7}-week content calendar</th>
              <td className="src" data-label="From your numbers">
                {catalog.content.posts > 0
                  ? `${num(catalog.content.posts)} social posts on the channels you run`
                  : "no social channel on your profile"}
              </td>
              <td className="sim-acts-cell">
                <div className="sim-acts">
                  {t(
                    "content",
                    picks.includes("content") ? "Picked" : "Compare",
                    "A content calendar",
                  )}
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
  return (
    <SheetCard
      label={`Side by side · over ${SIM.horizon_days} days`}
      title="What each is likely to bring"
      meta="Ranges are the middle half of what was measured"
    >
      <div className="sim-wrap">
        <table className="rt sim-table">
          <thead>
            <tr>
              <th scope="col">Measure</th>
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
                  {row.label}
                  <small>
                    {row.unit === "money" ? `${cmp.options[0]?.currency ?? ""}` : "count"}
                  </small>
                  {row.note && <small className="flag drift">{row.note}</small>}
                </th>
                {row.cells.map((cell, i) => {
                  const o = cmp.options[i]!;
                  const v = cellView(cell, row.unit, o.currency);
                  return (
                    <td key={o.key} className="num" title={v.detail}>
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

export function Whiskers({
  results,
  caption = "Expected profit, low to high · the square is the worst case",
}: {
  results: readonly WhiskerSource[];
  caption?: string;
}) {
  const chart = whiskerChart(results);
  if (!chart) {
    return (
      <p className="sim-note">
        The options are in more than one currency, so they can&rsquo;t share one axis — I
        don&rsquo;t convert between currencies.
      </p>
    );
  }
  const rowH = 36;
  const top = 8;
  const h = top + chart.rows.length * rowH + 22;
  return (
    <figure className="sim-chart">
      <figcaption className="cs-label">{caption}</figcaption>
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
  const cur = r.currency;
  const measures = (["cost", "reached", "orders", "revenue", "profit", "worst"] as const).filter(
    (m) => r.measures[m].status === "range",
  );
  return (
    <SheetCard
      className="sim-card"
      label={KIND_LABEL[r.kind]}
      title={r.title}
      meta={r.proposable.ok ? "Can be proposed" : "Not proposable yet"}
      foot={
        <div className="sim-foot">
          {r.proposable.ok ? (
            <button type="button" className="act" disabled={busy} onClick={onPropose}>
              {busy ? (
                <>
                  <span className="live-dot" aria-hidden="true" /> Proposing
                </>
              ) : (
                "Propose this →"
              )}
            </button>
          ) : (
            <span>{r.proposable.why}</span>
          )}
          {notice && (
            <span role="status" className={notice.ok ? "sim-done" : undefined}>
              {notice.text} {notice.ok && <Link href="/proposals">Waiting for you</Link>}
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
                  {i.range ? valueText(i.range, i.unit, cur, true) : "—"}
                </td>
                <td data-label="Basis">
                  {i.basis ? (
                    <span className="sim-basis">{i.basis}</span>
                  ) : (
                    <span className="flag drift">Missing</span>
                  )}
                </td>
                <td className="src" data-label="Where it came from">
                  {i.range ? i.source : `needs ${i.needs ?? "a source"}`}
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
                <dt>
                  {m === "worst"
                    ? "Worst case"
                    : m === "reached"
                      ? "Reach"
                      : m[0]!.toUpperCase() + m.slice(1)}
                </dt>
                <dd className="fig">{c.formula}</dd>
              </div>
            ) : null;
          })}
        </dl>
      )}
      <p className="sim-worst-words">
        <span className="cs-label">Worst case</span> {r.worst_words}
      </p>
      {r.guard && (
        <p className="sim-guard">
          <span className="flag alarm">Over a limit</span> {r.guard}.
        </p>
      )}
      <p className="sim-check">
        <span className="cs-label">Against what happened before</span> {r.cross_check.line}
      </p>
    </SheetCard>
  );
}

export function SimulateScreen() {
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
    return compareOptions(options, ready.inputs);
  }, [ready, options]);

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
      <Frame title="The simulator didn't load.">
        <p className="sim-note on-desk">Something went wrong on my side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!ready) return <Frame title="Reading your numbers…" />;

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
          ? { ok: false, text: "Sign in to propose it." }
          : !res.ok
            ? { ok: false, text: j.error ?? "That didn't go through. Try again." }
            : j.proposal?.status === "blocked"
              ? {
                  ok: false,
                  text: `I wrote it, and your own limit stopped it: ${j.proposal.blocked_by_limit ?? "a limit you set"}. It's in the restraint view.`,
                }
              : j.proposal
                ? {
                    ok: true,
                    text: "Proposed, with this simulation attached. Nothing runs until you approve it in",
                  }
                : { ok: false, text: `Not proposed: ${j.skipped ?? "nothing to propose"}.` };
      setNotices((n) => ({ ...n, [r.key]: notice }));
    } finally {
      setBusy(null);
    }
  };

  const aside = (
    <>
      Nothing here spends or sends
      <br />
      As of {ready.inputs.as_of} · {ready.inputs.currency}
    </>
  );

  return (
    <Frame title={headline(ready.catalog, ready.inputs)} aside={aside}>
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
            <SheetCard label="Profit, side by side" title="The spread of each option">
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
            Pick {picks.length === 0 ? `${SIM.min_options} options` : "one more option"} to compare
            them side by side.
          </p>
        )}
      </div>
    </Frame>
  );
}
