"use client";

// Insights · Compared with similar businesses — idea 44, on the sheet
// system (app/sheet.css). A few of the business's own numbers, each set
// beside one named, dated Eurostat cell: the head is the group in words,
// then one sheet per line (both figures and the gap, the cell and its
// year, the one definition gap that matters most, the owner's arithmetic
// and what it rests on), then the source foot. Decluttered 2026-11-09 on the
// owner's instruction: each sheet shows both figures and the gap; the cell,
// the definition gap, the arithmetic and its inputs, what the code covers
// and the Eurostat acknowledgement sit folded under "How this works".
// 2026-11-16: above the sheets, the compared lines as one list of marks
// (./view dumbRows) — Eurostat's figure hollow, the owner's filled. Eurostat
// only: the peer panel's figures never join it (v1 spec §5.4).
//
// Read-only, but for one button. A benchmark is a reference: nothing here
// makes a fact on the profile, and nothing calls a model or the network
// beyond this screen's reads and that button. I-44a: when the margin's gap
// is large (lib/benchmarks/gap, a stated threshold, like for like), a card
// says so, that it is in the report, and offers to propose going through
// prices and costs (POST /api/proposals/margin-review), which writes
// nothing anywhere when approved.
//
// Said plainly on 2026-11-23 (the canvas design the owner approved): the
// title says who you are compared with, one line says the figures are
// totals counted a little differently; each line is a card with its plain
// name (the accountant's word small beneath), two labelled bars, one
// sentence, and its "not quite like for like" note in the open; the cell,
// the arithmetic and its inputs fold under "How Lex worked this out". The
// list of arrows is gone, and the live comparison moves to the foot.
//
// L-3b: the screen's own words are the "benchmarks" catalogue; what
// lib/benchmarks words (the cell, the why, the gap note, the figures, the
// inputs) arrives from /api/benchmarks in the reader's language (L-4b).

import "../../app/benchmarks.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { BenchView } from "../../app/api/benchmarks/route";
import type { BenchLine, BenchResult, ComparedLine, Need } from "../../lib/benchmarks/compare";
import { num } from "../sheet/num";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { BenchWords } from "./view";
import { dateWords, footLine, headline, sizeNote } from "./view";

type Load =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; result: BenchResult; view: BenchView };

function useWords(): BenchWords {
  const { tr, locale } = useTr("benchmarks");
  return { tr, locale };
}

function Frame({
  title,
  aside,
  notes,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  notes?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useWords();
  return (
    <main className="screen bm-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

function Needs({ needs }: { needs: Need[] }) {
  const { tr } = useWords();
  if (needs.length === 0) return null;
  return (
    <p className="bm-needs">
      {needs.map((n) => (
        <Link key={n.href + n.what} href={n.href}>
          {tr("add", { what: n.what })}
        </Link>
      ))}
    </p>
  );
}

/** The lines whose plain name this screen knows ("plain.name.<key>"); another shows Eurostat's title. */
const PLAIN_NAMES = new Set([
  "operating_margin",
  "purchases_share",
  "turnover_per_person",
  "staff_cost_per_employee",
]);

/** A line's name said plainly, with the accountant's word kept small beneath it. */
function LineHead({ line, scope }: { line: BenchLine; scope?: string }) {
  const { tr } = useWords();
  const plain = PLAIN_NAMES.has(line.key) ? tr(`plain.name.${line.key}`) : line.title;
  return (
    <div className="bm-head">
      <h2 className="bm-name">{plain}</h2>
      <p className="bm-term">{scope ? `${line.title} · ${scope}` : line.title}</p>
    </div>
  );
}

/** Two labelled bars, each from zero on one scale; none when a figure is below zero. */
function Bars({ line, others }: { line: ComparedLine; others: string }) {
  const { tr } = useWords();
  const max = Math.max(line.own, line.bench);
  const drawn = line.own >= 0 && line.bench >= 0 && max > 0;
  const width = (v: number) => `${Math.max(2, Math.round((v / max) * 100))}%`;
  const row = (label: string, value: number, words: string, cls: string) => (
    <div className="bm-row">
      <span>{label}</span>
      {drawn ? (
        <span className="bm-bar" aria-hidden="true">
          <span className={cls} style={{ width: width(value) }} />
        </span>
      ) : (
        <span />
      )}
      <span className="bm-fig fig">{words}</span>
    </div>
  );
  return (
    <div className="bm-bars">
      {row(tr("yours"), line.own, line.own_words, "own")}
      {row(others, line.bench, line.bench_words, "them")}
    </div>
  );
}

function Line({ line, others }: { line: BenchLine; others: string }) {
  const w = useWords();
  const t = useTranslations("benchmarks");
  const { tr } = w;
  if (line.status !== "compared") {
    return (
      <SheetCard className="bm-line">
        <LineHead line={line} />
        <p className="bm-say">
          {line.status === "missing" ? tr("notComparedYet") : tr("noComparison")}
        </p>
        <p className="bm-copy">{line.why}</p>
        {line.status === "missing" && <Needs needs={line.needs} />}
        {line.gap_note && (
          <p className="bm-caveat">
            {t.rich("plain.caveat", { note: line.gap_note, b: (c) => <b>{c}</b> })}
          </p>
        )}
      </SheetCard>
    );
  }
  const scope = line.cell.size === "TOTAL" ? tr("plain.scope.all") : tr("plain.scope.yours");
  const say = READING_SAY[line.reading] ?? "plain.say.same";
  return (
    <SheetCard className="bm-line">
      <LineHead line={line} scope={scope} />
      <Bars line={line} others={others} />
      <p className="bm-say">{tr(say, { gap: line.gap_words })}</p>
      {line.gap_note && (
        <p className="bm-caveat">
          {t.rich("plain.caveat", { note: line.gap_note, b: (c) => <b>{c}</b> })}
        </p>
      )}
      <Needs needs={line.needs} />
      <Fold summary={tr("plain.how")}>
        <p className="bm-copy bm-cell">
          {line.cell.flag
            ? tr("cellFlagged", { words: line.cell.words, flag: line.cell.flag })
            : tr("cell", { words: line.cell.words })}
          {line.cell.fallback ? ` ${line.cell.fallback}` : ""}
          {line.conversion ? ` ${line.conversion}` : ""}
        </p>
        <p className="bm-math fig">{line.formula}</p>
        <div className="bm-wrap">
          <table className="rt rt-stack bm-inputs">
            <thead>
              <tr>
                <th scope="col">{tr("col.restsOn")}</th>
                <th scope="col" className="num">
                  {tr("col.value")}
                </th>
                <th scope="col">{tr("col.basis")}</th>
                <th scope="col">{tr("col.source")}</th>
              </tr>
            </thead>
            <tbody>
              {line.inputs.map((i) => (
                <tr key={i.label}>
                  <th scope="row">{i.label}</th>
                  <td className="num" data-label={tr("col.value")}>
                    {i.value}
                  </td>
                  <td data-label={tr("col.basis")}>
                    <span className="bm-basis">{i.basis}</span>
                  </td>
                  <td className="src" data-label={tr("col.source")}>
                    {i.source}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {line.left_out.length > 0 && (
          <>
            <p className="bm-sub">{tr("notCounted")}</p>
            <ul className="bm-list">
              {line.left_out.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        )}
      </Fold>
    </SheetCard>
  );
}

/** A line's reading, said as a sentence: "Yours is higher: 35.7 points above." */
const READING_SAY: Record<string, string> = {
  above: "plain.say.above",
  below: "plain.say.below",
  "about the same": "plain.say.same",
};

/** I-44a: the margin's large gap, and the proposal it may prompt. */
function GapCard({ view, onProposed }: { view: BenchView; onProposed: () => Promise<void> }) {
  const t = useTranslations("benchmarkGap");
  const { tr, locale } = useWords();
  const how = tr("how");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const gap = view.gap;
  if (!gap) return null;
  const propose = async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/proposals/margin-review", { method: "POST" });
      const body = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) setNote(body.error ?? t("failed"));
      else {
        setNote(body.status === "blocked" ? t("blocked") : t("drafted"));
        await onProposed();
      }
    } catch {
      setNote(t("failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SheetCard
      className="bm-line"
      label={t("label")}
      title={t("title", { points: num(gap.points, 1, locale) })}
    >
      <p className="bm-needs">
        {view.proposal ? (
          <>
            <span className="word boxed">{t("status", { status: view.proposal.status })}</span>{" "}
            <Link href={`/proposals/${view.proposal.id}`}>{t("queue")}</Link>
          </>
        ) : view.held ? (
          <span>{view.held}</span>
        ) : (
          <button type="button" className="act" disabled={busy} onClick={() => void propose()}>
            {busy ? t("drafting") : t("propose")}
          </button>
        )}
      </p>
      {note && (
        <p className="bm-copy" role="status">
          {note}
        </p>
      )}
      <Fold summary={how}>
        <p className="bm-copy">{t("rule", { threshold: num(gap.threshold_points, 0, locale) })}</p>
        <p className="bm-copy">{t("where")}</p>
      </Fold>
    </SheetCard>
  );
}

/** `peers`: the live comparison (components/peers/PeerPanel), rendered on the server; it sits under the Eurostat cards. */
export function BenchmarksScreen({ peers }: { peers?: ReactNode } = {}) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const t = useTranslations("benchmarks");
  const w = useWords();
  const { tr } = w;

  const read = useCallback(async () => {
    try {
      const res = await fetch("/api/benchmarks");
      if (res.status === 401) return setLoad({ phase: "signedout" });
      if (!res.ok) return setLoad({ phase: "error" });
      const data = (await res.json()) as BenchView;
      setLoad({ phase: "ready", result: data.result, view: data });
    } catch {
      setLoad({ phase: "error" });
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);

  if (load.phase === "signedout") {
    return (
      <Frame title={tr("signedOut.title")}>
        <p className="bm-copy on-desk">
          {t.rich("signedOut.body", { link: (c) => <Link href="/start">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (load.phase === "error") {
    return (
      <Frame title={tr("error.title")}>
        <p className="bm-copy on-desk">{tr("error.body")}</p>
      </Frame>
    );
  }
  if (load.phase === "loading") return <Frame title={tr("loading")} />;

  const r = load.result;
  if (r.status !== "ready") {
    return (
      <Frame title={headline(r, w)} aside={tr("aside")}>
        {peers}
        <SheetCard title={tr("nothingToCompare")}>
          <p className="bm-copy">{r.why}</p>
          {"needs" in r && <Needs needs={r.needs} />}
        </SheetCard>
      </Frame>
    );
  }

  const note = sizeNote(r, w);
  const others = tr("plain.others", { country: r.head.country });
  return (
    <Frame
      title={tr("plain.title", { group: r.head.group, country: r.head.country })}
      notes={
        <>
          <p className="bm-lede">
            {tr("plain.lede", { group: r.head.group, country: r.head.country })}
          </p>
          {note && (
            <p className="bm-note">
              {note} <Link href="/intake?ask=1.6">{tr("addPeople")}</Link>
            </p>
          )}
        </>
      }
    >
      <div className="bm-cards">
        {r.lines.map((l) => (
          <Line key={l.key} line={l} others={others} />
        ))}
      </div>
      <div className="bm-stack">
        <GapCard view={load.view} onProposed={read} />
        {peers}
      </div>
      <p className="bm-source">
        {tr("plain.source", { updated: dateWords(r.source.updated, w.locale) })}
      </p>
      <Fold summary={tr("how")}>
        <p className="bm-note">{r.head.covers}</p>
        <p className="bm-foot">{footLine(r.source, r.caveat, w)}</p>
      </Fold>
    </Frame>
  );
}
