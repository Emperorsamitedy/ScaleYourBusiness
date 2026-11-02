"use client";

// Insights · Compared with similar businesses — idea 44, on the sheet
// system (app/sheet.css). A few of the business's own numbers, each set
// beside one named, dated Eurostat cell: the head is the group in words,
// then one sheet per line (both figures and the gap, the cell and its
// year, the one definition gap that matters most, the owner's arithmetic
// and what it rests on), then the source foot.
//
// Read-only. A benchmark is a reference: nothing here makes a finding, a
// proposal or a fact on the profile, and nothing calls a model or the
// network beyond this screen's own read of /api/benchmarks.
//
// L-3b: the screen's own words are the "benchmarks" catalogue; what
// lib/benchmarks words (the cell, the why, the gap note, the figures, the
// inputs) stays English until L-4.

import "../../app/benchmarks.css";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { BenchView } from "../../app/api/benchmarks/route";
import type { BenchLine, BenchResult, Need } from "../../lib/benchmarks/compare";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { BenchWords } from "./view";
import { comparedCount, footLine, headline, lineSentence, readingWordIn, sizeNote } from "./view";

type Load =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; result: BenchResult };

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
        <p className="bm-copy bm-gap">{line.gap_note}</p>
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
      <Needs needs={line.needs} />
    </SheetCard>
  );
}

export function BenchmarksScreen() {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const t = useTranslations("benchmarks");
  const w = useWords();
  const { tr } = w;

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/benchmarks");
        if (res.status === 401) return setLoad({ phase: "signedout" });
        if (!res.ok) return setLoad({ phase: "error" });
        const data = (await res.json()) as BenchView;
        setLoad({ phase: "ready", result: data.result });
      } catch {
        setLoad({ phase: "error" });
      }
    })();
  }, []);

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
        <SheetCard label={tr("kickerShort")} title={tr("nothingToCompare")}>
          <p className="bm-copy">{r.why}</p>
          {"needs" in r && <Needs needs={r.needs} />}
        </SheetCard>
      </Frame>
    );
  }

  const note = sizeNote(r, w);
  return (
    <Frame
      title={headline(r, w)}
      aside={
        <>
          {tr("aside")}
          <br />
          {comparedCount(r, w)}
        </>
      }
      notes={
        <>
          <p className="bm-note">{r.head.covers}</p>
          {note && (
            <p className="bm-note">
              {note} <Link href="/intake?ask=1.6">{tr("addPeople")}</Link>
            </p>
          )}
        </>
      }
    >
      <div className="bm-stack">
        {r.lines.map((l) => (
          <Line key={l.key} line={l} />
        ))}
      </div>
      <p className="bm-foot">{footLine(r.source, r.caveat, w)}</p>
    </Frame>
  );
}
