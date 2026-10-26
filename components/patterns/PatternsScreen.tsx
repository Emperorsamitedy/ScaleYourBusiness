"use client";

// Insights · Seasons & bundles — ideas 46 and 48, on the sheet system
// (app/sheet.css). Two readings of the business's own measured history:
//
//   seasons  which weeks and months of the last year ran above and below
//            the normal week, and what the next eight weeks looked like
//            the same time last year — or, with under a year, how much
//            there is and what it can and can't say
//   bundles  what sold (or was booked) together more often than chance,
//            with the pair's margin where the owner's costs are known
//
// Read-only. "Propose this pair" drafts one proposal; nothing runs, no price
// changes and the checkout is never touched — the owner sets a pair up.

import "../../app/patterns.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PatternsView } from "../../app/api/patterns/route";
import type { BundleSource } from "../../lib/bundles/load";
import { shortDate } from "../../lib/charts/model";
import { ratioText } from "../../lib/seasons/forecast";
import { SeasonChart } from "../charts/SeasonChart";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { aheadRows, headline, marginText, proposalWord, seasonChartModel } from "./patterns-view";

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
    <main className="screen pt-screen">
      <PageHead kicker="Insights · Seasons & bundles" title={title} aside={aside} />
      {children}
    </main>
  );
}

function Seasons({ view }: { view: PatternsView }) {
  const r = view.seasons.result;
  const chart = seasonChartModel(r);
  if (r.status === "no_data") {
    return (
      <SheetCard label="Your seasons" title="Nothing measured yet">
        <p className="pt-copy">
          {view.seasons.connect}. I read your seasons from your own history only.{" "}
          <Link href="/connections">Connections</Link>
        </p>
      </SheetCard>
    );
  }
  if (r.status === "too_little") {
    return (
      <>
        {chart && <SeasonChart model={chart} />}
        <div className="pt-grid">
          <SheetCard
            label={`How much there is · ${r.series.source}`}
            title={`${num(r.covered_days)} days, ${shortDate(r.first_day)} to ${shortDate(r.last_day)}`}
            meta={`${num(r.complete_weeks)} of ${num(r.needed_weeks)} complete weeks needed`}
          >
            <p className="pt-copy">{r.headline}</p>
            <p className="pt-copy">
              If your syncs keep running, I can name your seasons from around{" "}
              {shortDate(r.ready_on)}.
            </p>
          </SheetCard>
          <SheetCard label="What I can and can't say yet" title="Honest about the gap">
            <p className="pt-sub">I can</p>
            <ul className="pt-list">
              {r.can.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="pt-sub">I can&apos;t yet</p>
            <ul className="pt-list">
              {r.cannot.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </SheetCard>
        </div>
      </>
    );
  }
  const rows = aheadRows(r);
  const others = view.seasons.other_currencies;
  return (
    <>
      {chart && <SeasonChart model={chart} />}
      <div className="pt-grid">
        <SheetCard
          label={`The next ${rows.length} weeks · beside the same weeks last year`}
          title={
            r.upcoming.length === 0
              ? "No busy or quiet stretch ahead"
              : r.upcoming[0]!.in_progress
                ? "A stretch is under way"
                : `A ${r.upcoming[0]!.run.kind} stretch starts in ${r.upcoming[0]!.starts_in_weeks} week${r.upcoming[0]!.starts_in_weeks === 1 ? "" : "s"}`
          }
          meta="Last year's week, 52 weeks back, so weekdays line up"
        >
          {r.upcoming.map((u) => (
            <p className="pt-copy pt-strong" key={u.run.start}>
              {u.sentence}
            </p>
          ))}
          <table className="rt rt-stack pt-ahead">
            <thead>
              <tr>
                <th scope="col">This year</th>
                <th scope="col">Last year</th>
                <th scope="col">Flag</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.week}>
                  <th scope="row">{a.week}</th>
                  <td data-label="Last year">
                    {a.figure}
                    <span className="pt-src">{a.last_year}</span>
                  </td>
                  <td data-label="Flag">
                    {a.flag ? (
                      <span className={`flag ${a.flag === "busy" ? "ok" : "drift"}`}>{a.flag}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SheetCard>
        <SheetCard
          label={`The months · ${r.months.length} of the last year`}
          title="Each month scaled to one week"
          meta="Months with 21 measured days or more"
        >
          <table className="rt rt-stack pt-months">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="num">
                  Against normal
                </th>
              </tr>
            </thead>
            <tbody>
              {r.months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.label}</th>
                  <td className="num" data-label="Against normal">
                    {ratioText(m)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SheetCard>
      </div>
      <SheetCard label="How I read it" title="Your own history, nothing borrowed">
        <ul className="pt-list">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {others.length > 0 && (
            <li>
              Your {r.series.noun} in {others.join(", ")} is left out: money in two currencies is
              never added together.
            </li>
          )}
        </ul>
      </SheetCard>
    </>
  );
}

function Pairs({
  source,
  view,
  onPropose,
  busyKey,
}: {
  source: BundleSource;
  view: PatternsView;
  onPropose: (key: string) => void;
  busyKey: string | null;
}) {
  const unit = source.kind === "orders" ? "orders" : "visits";
  const t = view.bundles.thresholds;
  const r = source.result;
  const label = `${source.kind === "orders" ? "Bought together" : "Booked together"} · ${source.label}`;
  if (r.status === "too_few") {
    return (
      <SheetCard label={label} title={`Only ${num(r.baskets)} ${unit} so far`}>
        <p className="pt-copy">
          I look for pairs once there are {num(r.needed)} {unit}: with fewer, chance alone can make
          any two items look inseparable.
        </p>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      label={label}
      title={
        source.pairs.length === 0
          ? "Nothing goes together more than chance"
          : `${source.pairs.length} pair${source.pairs.length === 1 ? "" : "s"} more often together than chance`
      }
      meta={`${num(r.baskets)} ${unit}, ${shortDate(source.from)} – ${shortDate(source.to)} · OBSERVED`}
      foot={`A pair shows when it shared ${t.min_together} ${unit} or more and came up at least ${t.min_lift}× as often as chance would give. ${num(r.below_count)} pair${r.below_count === 1 ? " was" : "s were"} seen too rarely, and ${num(r.below_lift)} no more often than chance${source.ungrouped > 0 ? `; ${num(source.ungrouped)} appointments with no client or service couldn't be grouped into a visit` : ""}.`}
    >
      {source.pairs.length === 0 ? (
        <p className="pt-copy">
          {r.multi === 0
            ? `Every one of your ${unit} held a single item, so nothing can be paired yet.`
            : `${num(r.multi)} of your ${unit} held two items or more, but no pair stood out from chance.`}
        </p>
      ) : (
        <div className="pt-table-wrap" tabIndex={0} aria-label="Pairs">
          <table className="rt rt-stack pt-pairs">
            <thead>
              <tr>
                <th scope="col">Pair</th>
                <th scope="col" className="num">
                  Together
                </th>
                <th scope="col">With the first, also the second</th>
                <th scope="col" className="num">
                  Against chance
                </th>
                <th scope="col">The pair&apos;s margin</th>
                <th scope="col">Proposal</th>
              </tr>
            </thead>
            <tbody>
              {source.pairs.map((p) => {
                const w = proposalWord(view.proposed[p.key]);
                return (
                  <tr key={p.key}>
                    <th scope="row">
                      {p.a_name} + {p.b_name}
                    </th>
                    <td className="num" data-label="Together">
                      {num(p.together)} {unit}
                    </td>
                    <td data-label="With the first, also the second">
                      {Math.round(p.confidence * 100)}% of {unit} with {p.a_name}
                      <span className="pt-src">
                        {num(p.count_a)} {unit} had {p.a_name}
                      </span>
                    </td>
                    <td className="num" data-label="Against chance">
                      {(Math.round(p.lift * 10) / 10).toFixed(1)}×
                      <span className="pt-src">about {num(Math.round(p.expected))} by chance</span>
                    </td>
                    <td data-label="The pair's margin">{marginText(p.margin)}</td>
                    <td data-label="Proposal">
                      {w ? (
                        <span className={`word ${w.tone}`}>{w.word}</span>
                      ) : (
                        <button
                          type="button"
                          className="act"
                          disabled={view.held !== null || busyKey !== null}
                          onClick={() => onPropose(p.key)}
                        >
                          {busyKey === p.key ? "Drafting…" : "Propose this pair →"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SheetCard>
  );
}

export function PatternsScreen() {
  const [view, setView] = useState<PatternsView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/patterns", { cache: "no-store" });
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as PatternsView);
    } catch {
      setFailed("error");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const propose = async (key: string) => {
    setBusyKey(key);
    setNote(null);
    try {
      const res = await fetch("/api/patterns", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "propose", key }),
      });
      const body = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) setNote(body.error ?? "That didn't work.");
      else {
        setNote(
          body.status === "blocked"
            ? "A rule of yours rules this out, so it sits blocked in your queue."
            : "Drafted. It waits for you; nothing changes in your shop when you approve it.",
        );
        await load();
      }
    } catch {
      setNote("Something went wrong on our side.");
    } finally {
      setBusyKey(null);
    }
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="pt-wait">
          <Link href="/intake">Start with the interview</Link>.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Seasons and bundles didn't load.">
        <p className="pt-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) return <Frame title="Reading your history…" />;

  const r = view.seasons.result;
  const aside =
    r.status === "no_data" ? (
      "Nothing measured yet"
    ) : (
      <>
        {r.series.source} · {shortDate(r.first_day)}–{shortDate(r.last_day)} · MEASURED
      </>
    );
  const sources = view.bundles.sources;

  return (
    <Frame title={headline(view)} aside={aside}>
      <Seasons view={view} />
      <h2 className="pt-section">What goes together</h2>
      {sources.length === 0 ? (
        <SheetCard label="What goes together" title="No orders or visits to read yet">
          <p className="pt-copy">
            Connect Shopify or WooCommerce and I keep which products each order held, or import your
            bookings and I group each client&apos;s visit.
            {view.bundles.without_lines.length > 0 &&
              ` ${view.bundles.without_lines.join(", ")} records payments, not products, so it can't say what went together.`}{" "}
            <Link href="/connections">Connections</Link>
          </p>
        </SheetCard>
      ) : (
        sources.map((s) => (
          <Pairs
            key={s.connection_id + s.kind}
            source={s}
            view={view}
            onPropose={(k) => void propose(k)}
            busyKey={busyKey}
          />
        ))
      )}
      {sources.some((s) => s.pairs.length > 0) && (
        <p className="pt-copy pt-held">
          {view.held ??
            "A proposal is a draft for you: both items at full price, no discount. I don't change your shop or your checkout — you set the pair up."}{" "}
          {note && (
            <>
              {note} <Link href="/proposals">Waiting for you</Link>
            </>
          )}
        </p>
      )}
    </Frame>
  );
}
