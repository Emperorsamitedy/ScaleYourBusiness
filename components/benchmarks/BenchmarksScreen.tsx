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

import "../../app/benchmarks.css";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { BenchView } from "../../app/api/benchmarks/route";
import type { BenchLine, BenchResult, Need } from "../../lib/benchmarks/compare";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { comparedCount, footLine, headline, lineSentence, readingWord, sizeNote } from "./view";

type Load =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | { phase: "ready"; result: BenchResult };

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
  return (
    <main className="screen bm-screen">
      <PageHead kicker="Insights · Compared with similar businesses" title={title} aside={aside}>
        {notes}
      </PageHead>
      {children}
    </main>
  );
}

function Needs({ needs }: { needs: Need[] }) {
  if (needs.length === 0) return null;
  return (
    <p className="bm-needs">
      {needs.map((n) => (
        <Link key={n.href + n.what} href={n.href}>
          Add {n.what} →
        </Link>
      ))}
    </p>
  );
}

function Line({ line }: { line: BenchLine }) {
  if (line.status !== "compared") {
    return (
      <SheetCard
        className="bm-line"
        label={line.title}
        title={line.status === "missing" ? "Not compared yet" : "No comparison"}
        meta={<span className="word boxed">{readingWord(line)}</span>}
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
      title={lineSentence(line)}
      meta={<span className="word boxed">{readingWord(line)}</span>}
    >
      <dl className="bm-pair">
        <div>
          <dt>Yours</dt>
          <dd className="fig">{line.own_words}</dd>
        </div>
        <div>
          <dt>Theirs</dt>
          <dd className="fig">{line.bench_words}</dd>
        </div>
      </dl>
      <p className="bm-copy bm-cell">
        Theirs: {line.cell.words}
        {line.cell.flag ? ` (${line.cell.flag})` : ""}.
        {line.cell.fallback ? ` ${line.cell.fallback}` : ""}
        {line.conversion ? ` ${line.conversion}` : ""}
      </p>
      <p className="bm-copy bm-gap">{line.gap_note}</p>
      <p className="bm-math fig">{line.formula}</p>
      <div className="bm-wrap">
        <table className="rt rt-stack bm-inputs">
          <thead>
            <tr>
              <th scope="col">What yours rests on</th>
              <th scope="col" className="num">
                Value
              </th>
              <th scope="col">Basis</th>
              <th scope="col">Where it came from</th>
            </tr>
          </thead>
          <tbody>
            {line.inputs.map((i) => (
              <tr key={i.label}>
                <th scope="row">{i.label}</th>
                <td className="num" data-label="Value">
                  {i.value}
                </td>
                <td data-label="Basis">
                  <span className="bm-basis">{i.basis}</span>
                </td>
                <td className="src" data-label="Where it came from">
                  {i.source}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {line.left_out.length > 0 && (
        <>
          <p className="bm-sub">Not counted</p>
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
      <Frame title="There's no business here yet.">
        <p className="bm-copy on-desk">
          <Link href="/intake">Start with the interview</Link>, and your own numbers fill this in.
        </p>
      </Frame>
    );
  }
  if (load.phase === "error") {
    return (
      <Frame title="The comparison didn't load.">
        <p className="bm-copy on-desk">Something went wrong on my side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (load.phase === "loading") return <Frame title="Reading your numbers…" />;

  const r = load.result;
  if (r.status !== "ready") {
    return (
      <Frame title={headline(r)} aside="Eurostat · read-only">
        <SheetCard label="Compared with similar businesses" title="Nothing to compare">
          <p className="bm-copy">{r.why}</p>
          {"needs" in r && <Needs needs={r.needs} />}
        </SheetCard>
      </Frame>
    );
  }

  const note = sizeNote(r);
  return (
    <Frame
      title={headline(r)}
      aside={
        <>
          Eurostat · read-only
          <br />
          {comparedCount(r)}
        </>
      }
      notes={
        <>
          <p className="bm-note">{r.head.covers}</p>
          {note && (
            <p className="bm-note">
              {note} <Link href="/intake?ask=1.6">Add how many people work here</Link>
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
      <p className="bm-foot">{footLine(r.source, r.caveat)}</p>
    </Frame>
  );
}
