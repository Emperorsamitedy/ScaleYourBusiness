"use client";

// The fact sheet — P1-59/60, on the sheet system (ux-spec §2). Session
// D's closing claim: the owner sees everything they told us, with its
// source, and everything still open, with what answering it would buy.
//
// Every fact prints its basis (a named class from what produced it —
// components/report/basis.ts — never a confidence percentage), its
// source and the date it was observed, as visible text in its row.
//
// Everything rendered here is the API's deterministic read of the
// snapshot. The browser computes nothing beyond the completeness and
// share-of-facts percentages, and re-prints money through
// components/sheet/num.ts.

import "../../app/factsheet.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { num } from "../sheet/num";
import { BASES, BASIS_MEANING, basisOf, gapWord, sourceLabel } from "../report/basis";
import { fmtDate, isFigureText, keyWords, refigureNumber } from "../report/figures";

/* ── the API's shapes (lib/profile/factsheet.ts) ── */

interface FactRow {
  key: string;
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
  source_detail: string | null;
  observed_at: string;
  note: string | null;
}
interface EntityGroup {
  id: string;
  spine: string;
  name: string | null;
  facts: FactRow[];
}
interface GapRow {
  question_id: string;
  prompt: string;
  section: string;
  priority: "core" | "important" | "deep" | "optional";
  buys: string;
  blocking: boolean;
}
interface FactSheet {
  profile_id: string;
  snapshot_id: string;
  taken_at: string;
  fact_count: number;
  completeness: {
    overall: number;
    core_complete: boolean;
    by_section: { section: string; score: number }[];
  };
  provenance: { kind: string; count: number }[];
  sections: { section: string; facts: FactRow[] }[];
  entities: EntityGroup[];
  gaps: GapRow[];
}
interface Candidate {
  name: string;
  url: string;
  evidence: string;
}

const sectionWords = (s: string) => {
  const w = s.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** The source detail as words: a URL without its scheme, a formula or a question id as given. */
function detailWords(d: string): string {
  return d.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

/** The value cell: a figure in mono, words in prose, a gap as what it is. */
function Value({ fact }: { fact: FactRow }) {
  if (fact.value === null) {
    return (
      <span className="fx-missing">
        {fact.status === "unknown"
          ? fact.source_kind === "web_research"
            ? "Their pages didn't say — that's recorded"
            : "You didn't know — that's recorded"
          : fact.status === "skipped"
            ? "Skipped for now"
            : fact.status === "not_applicable"
              ? "Doesn't apply"
              : "Not asked yet"}
      </span>
    );
  }
  if (isFigureText(fact.value)) return <span className="fig">{refigureNumber(fact.value)}</span>;
  return <>{fact.value}</>;
}

function FactsTable({
  facts,
  caption,
  label,
}: {
  facts: FactRow[];
  caption: string;
  /** How to name a row: the entity field alone, or the key without its section. */
  label: (key: string) => string;
}) {
  return (
    <div className="fx-scroll">
      <table className="fx-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Fact</th>
            <th scope="col">Value</th>
            <th scope="col">Basis</th>
            <th scope="col">Source</th>
            <th scope="col" className="num-col">
              Observed
            </th>
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => {
            const basis = basisOf(f);
            return (
              <tr key={f.key} className={basis === null ? "is-gap" : undefined}>
                <th scope="row">{label(f.key) || f.key}</th>
                <td data-label="Value" className="fx-val">
                  <span>
                    <Value fact={f} />
                    {f.note !== null && f.value !== null && (
                      <span className="fx-note">noted: {f.note}</span>
                    )}
                  </span>
                </td>
                <td data-label="Basis">
                  {basis !== null ? (
                    <b className="fx-basis">{basis}</b>
                  ) : (
                    <span className="flag none">{gapWord(f.status)}</span>
                  )}
                </td>
                <td data-label="Source" className="fx-source">
                  <span>
                    {sourceLabel(f.source_kind)}
                    {f.source_detail !== null && (
                      <span className="fx-detail">{detailWords(f.source_detail)}</span>
                    )}
                  </span>
                </td>
                <td data-label="Observed" className="fig num-col">
                  {fmtDate(f.observed_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Competitors: the one entity block with an action — the agent goes and looks. */
function Competitors({
  groups,
  onChanged,
}: {
  groups: EntityGroup[];
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const discover = useCallback(async () => {
    setBusy("discover");
    setNote(null);
    try {
      const res = await fetch("/api/research/discover", { method: "POST" });
      const payload = (await res.json()) as { candidates?: Candidate[]; error?: string };
      if (!res.ok || !payload.candidates) {
        setNote(payload.error ?? "the search came back with nothing usable");
        return;
      }
      setCandidates(payload.candidates);
    } catch {
      setNote("I couldn't reach the server. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }, []);

  const confirm = useCallback(
    async (candidate: Candidate) => {
      setBusy(candidate.url);
      setNote(null);
      try {
        const res = await fetch("/api/research/competitor", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: candidate.name }),
        });
        const payload = (await res.json()) as { error?: string; written?: string[] };
        if (!res.ok) {
          setNote(payload.error ?? "research failed");
          return;
        }
        setCandidates((prev) => prev?.filter((c) => c.url !== candidate.url) ?? null);
        await onChanged();
      } catch {
        setNote("I couldn't reach the server. Try again in a moment.");
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  return (
    <section className="fx-section" id="fs-competitors" data-rail aria-labelledby="fx-h-comp">
      <header className="fx-section-head">
        <h2 id="fx-h-comp" className="fx-h2">
          Competitors
        </h2>
        <button className="ghost" onClick={() => void discover()} disabled={busy !== null}>
          {busy === "discover" ? "Searching the web…" : "Find my competitors →"}
        </button>
      </header>

      {busy !== null && (
        <p className="fx-status live" role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />{" "}
          {busy === "discover" ? "Searching from what you told me" : "Reading their pages"}
        </p>
      )}
      {note !== null && (
        <p className="fx-note-line" role="alert">
          {note}
        </p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div className="fx-cands">
          <p className="fx-lede">
            Found by searching from what you told me. Nothing is saved until you confirm — you know
            your market better than a search does.
          </p>
          <ul className="fx-list">
            {candidates.map((c) => (
              <li className="fx-cand" key={c.url}>
                <div>
                  <strong>{c.name}</strong>
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className="fx-detail">
                    {detailWords(c.url).slice(0, 48)}
                  </a>
                  <p>{c.evidence}</p>
                </div>
                <button className="ghost" onClick={() => void confirm(c)} disabled={busy !== null}>
                  {busy === c.url ? "Reading their pages…" : "That's one — look them up →"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length === 0 && candidates === null && (
        <p className="fx-empty">
          None recorded yet. Name them in the interview, or let me search from what you&rsquo;ve
          already told me.
        </p>
      )}

      {groups.map((g) => (
        <div className="fx-entity" key={g.id}>
          <h3 className="fx-h3">{g.name ?? "Unnamed competitor"}</h3>
          <FactsTable
            facts={g.facts.filter((f) => f.key !== "name")}
            caption={`What is recorded about ${g.name ?? "this competitor"}`}
            label={(k) => keyWords(k, false)}
          />
        </div>
      ))}
    </section>
  );
}

export function FactSheetScreen() {
  const [sheet, setSheet] = useState<FactSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAllGaps, setShowAllGaps] = useState(false);
  const [active, setActive] = useState<string>("");

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/profile");
      if (res.status === 401) {
        setError("no-session");
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setSheet((await res.json()) as FactSheet);
    } catch {
      setError("failed");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The contents follow the scroll: whichever marked section is nearest
  // the top of the viewport is the one marked current.
  useEffect(() => {
    if (sheet === null) return;
    const marked = Array.from(document.querySelectorAll("[data-rail]"));
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-15% 0px -65% 0px" },
    );
    marked.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sheet, query, showAllGaps]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!sheet) return [];
    if (q === "") return sheet.sections;
    return sheet.sections
      .map(({ section, facts }) => ({
        section,
        facts: facts.filter((f) => {
          const basis = basisOf(f) ?? "";
          return (
            f.key.toLowerCase().includes(q) ||
            (f.value ?? "").toLowerCase().includes(q) ||
            f.source_kind.includes(q) ||
            sourceLabel(f.source_kind).includes(q) ||
            basis.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((s) => s.facts.length > 0);
  }, [sheet, q]);

  if (error === "no-session") {
    return (
      <main className="fs-shell fx">
        <h1 className="display fx-h1">Fact sheet</h1>
        <p className="fx-empty">
          There&rsquo;s no profile on this device yet.{" "}
          <Link href="/intake">Start the questions</Link> — or open the link I sent you.
        </p>
      </main>
    );
  }
  if (error !== null) {
    return (
      <main className="fs-shell fx">
        <h1 className="display fx-h1">Fact sheet</h1>
        <p className="fx-empty" role="alert">
          Something went wrong loading your profile. Refresh to try again — nothing you told me is
          lost.
        </p>
      </main>
    );
  }
  if (sheet === null) {
    return (
      <main className="fs-shell fx">
        <p className="fx-empty" role="status">
          Reading your profile…
        </p>
      </main>
    );
  }

  const name =
    sheet.sections
      .find((s) => s.section === "identity")
      ?.facts.find((f) => f.key === "identity.legal_name")?.value ?? "Your business";
  const blocking = sheet.gaps.filter((g) => g.blocking).length;
  const others = sheet.entities.filter((e) => e.spine !== "competitors");
  const pct = Math.round(sheet.completeness.overall * 100);
  const link = (id: string) => ({
    href: `#${id}`,
    "aria-current": active === id ? ("location" as const) : undefined,
  });

  return (
    <main className="fs-shell fx">
      <header className="fx-head">
        <div>
          <p className="label fx-kicker">
            Fact sheet · as of {fmtDate(sheet.taken_at)} · snapshot {sheet.snapshot_id.slice(0, 8)}
          </p>
          <h1 className="display fx-h1">{name}</h1>
          <p className="fx-sub">
            <span className="fig">{num(sheet.fact_count)}</span> facts · each prints its basis,
            source and the date it was observed
          </p>
        </div>
        <Link href="/intake" className="ghost fx-answer">
          Answer more questions →
        </Link>
      </header>

      <div className="fx-body">
        <nav className="fx-contents" aria-label="Sections of the fact sheet">
          <p className="label">Contents</p>
          <ul>
            <li>
              <a {...link("fs-overview")}>Overview</a>
            </li>
            {sheet.gaps.length > 0 && (
              <li>
                <a {...link("fs-gaps")}>
                  Still open <span className="fig">{sheet.gaps.length}</span>
                </a>
              </li>
            )}
            <li>
              <a {...link("fs-competitors")}>Competitors</a>
            </li>
            {filtered.map(({ section, facts }) => (
              <li key={section}>
                <a {...link(`sec-${section}`)}>
                  {sectionWords(section)} <span className="fig">{facts.length}</span>
                </a>
              </li>
            ))}
            {others.length > 0 && (
              <li>
                <a {...link("fs-entities")}>Offers and the rest</a>
              </li>
            )}
          </ul>
        </nav>

        <div className="fx-main">
          <section
            className="fx-section fx-overview"
            id="fs-overview"
            data-rail
            aria-labelledby="fx-h-over"
          >
            <h2 id="fx-h-over" className="sr-only">
              Overview
            </h2>
            <div className="fx-panel">
              <h3 className="fx-h3">How complete this is</h3>
              <p className="fig fx-pct">{pct} %</p>
              <span className="fx-bar" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </span>
              <p className="fx-panel-note">
                {sheet.completeness.core_complete
                  ? "The core set is answered — the diagnosis can run on it."
                  : `${blocking} core question${blocking === 1 ? "" : "s"} still open — these hold the diagnosis back.`}
              </p>
            </div>

            <div className="fx-panel">
              <h3 className="fx-h3">Where the {num(sheet.fact_count)} came from</h3>
              <table className="fx-table fx-prov">
                <caption className="sr-only">Facts by source, with each source's share</caption>
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col" className="num-col">
                      Facts
                    </th>
                    <th scope="col" className="num-col">
                      Share %
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.provenance.map((p) => {
                    const share = sheet.fact_count > 0 ? (p.count / sheet.fact_count) * 100 : 0;
                    return (
                      <tr key={p.kind}>
                        <th scope="row">{sourceLabel(p.kind)}</th>
                        <td className="fig num-col" data-label="Facts">
                          {num(p.count)}
                        </td>
                        <td className="fig num-col" data-label="Share %">
                          {num(share, 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── the gaps: what's missing and what answering it buys (P1-60) ── */}
          {sheet.gaps.length > 0 && (
            <section className="fx-section" id="fs-gaps" data-rail aria-labelledby="fx-h-gaps">
              <header className="fx-section-head">
                <h2 id="fx-h-gaps" className="fx-h2">
                  Still open
                </h2>
                <span className="fx-meta">
                  <span className="fig">{sheet.gaps.length}</span> question
                  {sheet.gaps.length === 1 ? "" : "s"} · a gap is a finding, not a failure
                </span>
              </header>
              <ul className="fx-list">
                {sheet.gaps.slice(0, showAllGaps ? sheet.gaps.length : 5).map((g) => (
                  <li className="fx-gap" key={g.question_id}>
                    <div>
                      <p className="fx-gap-head">
                        <span className="label">{g.priority}</span>
                        {g.blocking && <span className="flag drift">BLOCKING</span>}
                      </p>
                      <p className="fx-gap-q">{g.prompt}</p>
                      <p className="fx-gap-b">{g.buys}</p>
                    </div>
                    <Link
                      className="ghost quiet"
                      href={`/intake?ask=${encodeURIComponent(g.question_id)}`}
                    >
                      Answer now →
                    </Link>
                  </li>
                ))}
              </ul>
              {sheet.gaps.length > 5 && (
                <button
                  className="ghost quiet fx-more"
                  onClick={() => setShowAllGaps((v) => !v)}
                  aria-expanded={showAllGaps}
                >
                  {showAllGaps ? "Show fewer" : `Show all ${sheet.gaps.length}`}
                </button>
              )}
            </section>
          )}

          <Competitors
            groups={sheet.entities.filter((e) => e.spine === "competitors")}
            onChanged={load}
          />

          {/* ── every scalar fact, by section ── */}
          <div className="fx-search">
            <label className="label" htmlFor="fx-q">
              Search the facts
            </label>
            <input
              id="fx-q"
              className="field"
              type="search"
              placeholder={`Search across ${sheet.fact_count} facts — a word, a source, or a basis`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {q !== "" && filtered.length === 0 && (
            <p className="fx-empty" role="status">
              No fact matches &ldquo;{query.trim()}&rdquo;.
            </p>
          )}

          {filtered.map(({ section, facts }) => (
            <section
              className="fx-section"
              key={section}
              id={`sec-${section}`}
              data-rail
              aria-labelledby={`fx-h-${section}`}
            >
              <header className="fx-section-head">
                <h2 id={`fx-h-${section}`} className="fx-h2">
                  {sectionWords(section)}
                </h2>
                <span className="fx-meta">
                  <span className="fig">{facts.length}</span> fact{facts.length === 1 ? "" : "s"}
                </span>
              </header>
              <FactsTable
                facts={facts}
                caption={`${sectionWords(section)}: every fact with its basis, source and date`}
                label={(k) => keyWords(k)}
              />
            </section>
          ))}

          {others.length > 0 && (
            <section
              className="fx-section"
              id="fs-entities"
              data-rail
              aria-labelledby="fx-h-entities"
            >
              <header className="fx-section-head">
                <h2 id="fx-h-entities" className="fx-h2">
                  Offers and the rest
                </h2>
              </header>
              {others.map((g) => (
                <div className="fx-entity" key={g.id}>
                  <h3 className="fx-h3">
                    {g.name ?? sectionWords(g.spine)}{" "}
                    <span className="label fx-spine">{g.spine.replace(/_/g, " ")}</span>
                  </h3>
                  <FactsTable
                    facts={g.facts.filter((f) => f.key !== "name")}
                    caption={`What is recorded about ${g.name ?? g.spine}`}
                    label={(k) => keyWords(k, false)}
                  />
                </div>
              ))}
            </section>
          )}

          <footer className="fx-foot">
            <p>
              {BASES.map((b, i) => (
                <span key={b}>
                  {i > 0 && " · "}
                  <b>{b}</b> {BASIS_MEANING[b]}
                </span>
              ))}
            </p>
            <p>
              Snapshot {sheet.snapshot_id.slice(0, 8)} · nothing here is invented — a value I
              computed says so, a value you gave me says so.
            </p>
          </footer>
        </div>
      </div>
    </main>
  );
}
