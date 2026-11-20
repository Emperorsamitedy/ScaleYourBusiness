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
// L-3b: the screen's own words are the "benchmarks" catalogue; what
// lib/benchmarks words (the cell, the why, the gap note, the figures, the
// inputs) arrives from /api/benchmarks in the reader's language (L-4b).

import "../../app/benchmarks.css";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { BenchView } from "../../app/api/benchmarks/route";
import type { BenchLine, BenchResult, Need } from "../../lib/benchmarks/compare";
import { Dumbbell } from "../charts/Viz";
import { num } from "../sheet/num";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { BenchWords } from "./view";
import {
  comparedCount,
  dumbRows,
  footLine,
  headline,
  lineSentence,
  readingWordIn,
  sizeNote,
} from "./view";

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

function Line({ line }: { line: BenchLine }) {
  const w = useWords();
  const { tr } = w;
  if (line.status !== "compared") {
    return (
      <SheetCard
        className="bm-line"
        label={line.title}
        title={line.status === "missing" ? tr("notComparedYet") : tr("noComparison")}
        meta={<span className="word boxed">{readingWordIn(line, w)}</span>}
      >
        <p className="bm-copy">{line.why}</p>
        {line.status === "missing" && <Needs needs={line.needs} />}
        <Fold summary={tr("how")}>
          <p className="bm-copy bm-gap">{line.gap_note}</p>
        </Fold>
      </SheetCard>
    );
  }
  return (
    <SheetCard
      className="bm-line"
      label={line.title}
      title={lineSentence(line, w)}
      meta={<span className="word boxed">{readingWordIn(line, w)}</span>}
    >
      <dl className="bm-pair">
        <div>
          <dt>{tr("yours")}</dt>
          <dd className="fig">{line.own_words}</dd>
        </div>
        <div>
          <dt>{tr("theirs")}</dt>
          <dd className="fig">{line.bench_words}</dd>
        </div>
      </dl>
      <Needs needs={line.needs} />
      <Fold summary={tr("how")}>
        <p className="bm-copy bm-cell">
          {line.cell.flag
            ? tr("cellFlagged", { words: line.cell.words, flag: line.cell.flag })
            : tr("cell", { words: line.cell.words })}
          {line.cell.fallback ? ` ${line.cell.fallback}` : ""}
          {line.conversion ? ` ${line.conversion}` : ""}
        </p>
        <p className="bm-copy bm-gap">{line.gap_note}</p>
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

/** `peers`: the live comparison (components/peers/PeerPanel), rendered on the server above the Eurostat sheets. */
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
          {t.rich("signedOut.body", { link: (c) => <Link href="/intake">{c}</Link> })}
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
  const marks = dumbRows(r.lines);
  return (
    <Frame
      title={headline(r, w)}
      // One line: under a long title the side text drops below it, where a
      // second, shorter line sat crooked against the first.
      aside={`${tr("aside")} · ${comparedCount(r, w)}`}
      notes={
        note && (
          <p className="bm-note">
            {note} <Link href="/intake?ask=1.6">{tr("addPeople")}</Link>
          </p>
        )
      }
    >
      {peers}
      <div className="bm-stack">
        {marks.length > 0 && (
          <SheetCard className="bm-marks" label={tr("aside")} meta={comparedCount(r, w)}>
            <Dumbbell
              rows={marks}
              aWord={tr("theirs")}
              bWord={tr("yours")}
              label={headline(r, w)}
            />
          </SheetCard>
        )}
        {r.lines.map((l) => (
          <Line key={l.key} line={l} />
        ))}
        <GapCard view={load.view} onProposed={read} />
      </div>
      <Fold summary={tr("how")}>
        <p className="bm-note">{r.head.covers}</p>
        <p className="bm-foot">{footLine(r.source, r.caveat, w)}</p>
      </Fold>
    </Frame>
  );
}
