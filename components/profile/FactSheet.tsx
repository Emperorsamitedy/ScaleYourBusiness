"use client";

// The fact sheet — P1-59/60, set as the owner's fact-sheet design
// (2026-10-17) inside the rail shell: a page head stating the count and
// the basis mix, then one sheet with a search band and filters, the
// sections on the left, and the facts on the right — value, source,
// basis, since — with every superseded value struck through beneath the
// fact it used to be (rule 3: superseded, never erased).
//
// Everything rendered is the API's deterministic read of the snapshot
// plus the superseded field_records; components/profile/model.ts holds
// the rules (filing, basis words, filters) and their tests.

import "../../app/factsheet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useBusinessNoun } from "../nav/useBusinessNoun";
import { ChartsPanel } from "../charts/ChartsPanel";
import { PageHead } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { fmtDay } from "../report/figures";
import type { DisplaySection, FactSheet, GapRow, Mode, SupersededFact } from "./model";
import {
  basisCounts,
  basisWord,
  changedIn,
  displaySections,
  filterSections,
  sourceText,
  valueView,
} from "./model";
import { basisOf, newerWord, successorKind } from "../report/basis";

interface Candidate {
  name: string;
  url: string;
  evidence: string;
}

const anchor = (section: string) => `fs-${section}`;
const GAPS = "fs-open";

/** Competitors: the one section with an action — the agent goes and looks. */
function CompetitorFinder({ onChanged }: { onChanged: () => Promise<void> }) {
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
        const payload = (await res.json()) as { error?: string };
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
    <div className="fs-finder">
      <button className="fs-btn" onClick={() => void discover()} disabled={busy !== null}>
        {busy === "discover" ? "Searching the web…" : "Find my competitors →"}
      </button>
      {busy !== null && (
        <p className="fs-status live" role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />{" "}
          {busy === "discover" ? "Searching from what you told me" : "Reading their pages"}
        </p>
      )}
      {note !== null && (
        <p className="fs-note" role="alert">
          {note}
        </p>
      )}
      {candidates !== null && candidates.length > 0 && (
        <>
          <p className="fs-note">
            Found by searching from what you told me. Nothing is saved until you confirm.
          </p>
          <ul className="fs-cands">
            {candidates.map((c) => (
              <li key={c.url}>
                <div>
                  <strong>{c.name}</strong>{" "}
                  <a href={c.url} target="_blank" rel="noreferrer noopener" className="fs-sub">
                    {c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}
                  </a>
                  <p>{c.evidence}</p>
                </div>
                <button className="fs-btn" onClick={() => void confirm(c)} disabled={busy !== null}>
                  {busy === c.url ? "Reading their pages…" : "That's one — look them up →"}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SupersededRow({ label, h, by }: { label: string; h: SupersededFact; by: string }) {
  const v = valueView(h);
  return (
    <tr className="fs-sup">
      <th scope="row">
        <s>{label}</s>
        <s className="fs-sub">
          superseded {fmtDay(h.superseded_at)} by a newer {by}
        </s>
      </th>
      <td className="num" data-label="Value">
        <s>{v.text}</s>
      </td>
      <td className="fs-src" data-label="Source">
        {sourceText(h)}
      </td>
      <td data-label="Basis">
        <span className="fs-basis sup">Superseded</span>
      </td>
      <td className="num fs-since" data-label="Since">
        {fmtDay(h.observed_at)}
      </td>
    </tr>
  );
}

function SectionTable({
  s,
  history,
  changed,
  showSuperseded,
}: {
  s: DisplaySection;
  history: Record<string, SupersededFact[]>;
  changed: ReadonlySet<string>;
  showSuperseded: boolean;
}) {
  return (
    <table className="fs-table">
      <caption className="sr-only">
        {s.label}: every fact with its value, source, basis and the date it holds from
      </caption>
      <thead>
        <tr>
          <th scope="col">Fact</th>
          <th scope="col" className="num">
            Value
          </th>
          <th scope="col">Source</th>
          <th scope="col">Basis</th>
          <th scope="col" className="num">
            Since
          </th>
        </tr>
      </thead>
      <tbody>
        {s.facts.map((d) => {
          const v = valueView(d.fact);
          const b = basisWord(d.fact);
          const past = showSuperseded ? (history[d.key] ?? []) : [];
          return [
            <tr key={d.key} id={`fact-${d.key}`} className={v.gap ? "fs-gap" : undefined}>
              <th scope="row">
                {d.label}
                {basisOf(d.fact) === "ASSUMED" && (
                  <span className="fs-sub">confirm to replace the default</span>
                )}
                {d.fact.note !== null && d.fact.value !== null && (
                  <span className="fs-sub">noted: {d.fact.note}</span>
                )}
              </th>
              <td className={`num${v.figure ? "" : " fs-words"}`} data-label="Value">
                {changed.has(d.key) ? <span className="marked">{v.text}</span> : v.text}
              </td>
              <td className="fs-src" data-label="Source">
                {sourceText(d.fact)}
              </td>
              <td data-label="Basis">
                <span className={`fs-basis ${b.tone}`}>{b.word}</span>
              </td>
              <td className="num fs-since" data-label="Since">
                {fmtDay(d.fact.observed_at)}
              </td>
            </tr>,
            ...past.map((h, i) => (
              <SupersededRow
                key={`${d.key}~${h.superseded_at}~${i}`}
                label={d.label}
                h={h}
                by={newerWord(successorKind(past, i, d.fact.source_kind))}
              />
            )),
          ];
        })}
      </tbody>
    </table>
  );
}

function OpenQuestions({ gaps }: { gaps: GapRow[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? gaps : gaps.slice(0, 6);
  return (
    <>
      <ul className="fs-gaps">
        {shown.map((g) => (
          <li key={g.question_id}>
            <div>
              <p className="fs-gap-head">
                <span className="fs-sub">{g.priority}</span>
                {g.blocking && <span className="word drift">Blocking</span>}
              </p>
              <p className="fs-gap-q">{g.prompt}</p>
              <p className="fs-sub">{g.buys}</p>
            </div>
            <Link className="fs-btn" href={`/intake?ask=${encodeURIComponent(g.question_id)}`}>
              Answer now →
            </Link>
          </li>
        ))}
      </ul>
      {gaps.length > 6 && (
        <button className="fs-btn fs-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? "Show fewer" : `Show all ${num(gaps.length)}`}
        </button>
      )}
    </>
  );
}

export function FactSheetScreen() {
  const [sheet, setSheet] = useState<FactSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [showSuperseded, setShowSuperseded] = useState(true);
  const [active, setActive] = useState<string>("");
  const pane = useRef<HTMLDivElement>(null);
  const noun = useBusinessNoun();

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

  const sections = useMemo(() => (sheet ? displaySections(sheet) : []), [sheet]);
  const changed = useMemo(() => new Set(sheet?.changed ?? []), [sheet]);
  const history = useMemo(() => sheet?.history ?? {}, [sheet]);
  const visible = useMemo(
    () => filterSections(sections, { mode, query, changed }),
    [sections, mode, query, changed],
  );
  const allFacts = useMemo(() => sections.flatMap((s) => s.facts.map((d) => d.fact)), [sections]);
  const counts = useMemo(() => basisCounts(allFacts), [allFacts]);
  const supersededCount = useMemo(
    () => Object.values(history).reduce((n, l) => n + l.length, 0),
    [history],
  );
  const hasCompetitors = sections.some((s) => s.section === "competitors");
  const filtering = mode !== "all" || query.trim() !== "";
  const gaps = sheet?.gaps ?? [];

  // The contents follow the pane's scroll: the section nearest its top is current.
  useEffect(() => {
    const root = pane.current;
    if (!root) return;
    const marked = Array.from(root.querySelectorAll("[data-sec]"));
    const io = new IntersectionObserver(
      (entries) => {
        const seen = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (seen[0]) setActive(seen[0].target.id);
      },
      { root: root.scrollHeight > root.clientHeight ? root : null, rootMargin: "0px 0px -70% 0px" },
    );
    marked.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [visible, gaps.length]);

  const jump = (id: string) => {
    const el = document.getElementById(id);
    const root = pane.current;
    if (!el || !root) return;
    setActive(id);
    if (root.scrollHeight > root.clientHeight) {
      root.scrollTo({ top: el.offsetTop - root.offsetTop - 8, behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  if (error !== null || sheet === null) {
    return (
      <main className="screen fs">
        <PageHead kicker="Your business · Fact sheet" title="The record." />
        <section className="fs-card fs-msg">
          {error === "no-session" ? (
            <p>
              There&rsquo;s no profile on this device yet.{" "}
              <Link href="/intake">Start the questions</Link> — or open the link I sent you.
            </p>
          ) : error !== null ? (
            <p role="alert">
              Something went wrong loading your profile. Refresh to try again — nothing you told me
              is lost.
            </p>
          ) : (
            <p role="status">Reading your profile…</p>
          )}
        </section>
      </main>
    );
  }

  const assumedCount = counts.assumed;
  const filters: { m: Mode; label: string }[] = [
    { m: "all", label: "All" },
    { m: "assumed", label: `Assumed · ${num(assumedCount)}` },
    { m: "changed", label: `Changed this month · ${num(changed.size)}` },
  ];

  return (
    <main className="screen fs">
      <PageHead
        kicker="Your business · Fact sheet"
        title={
          <>
            {num(allFacts.length)} fact{allFacts.length === 1 ? "" : "s"} about {noun}. Every one
            shows where it came from.
          </>
        }
      >
        <p className="fs-counts">
          <span>
            <b>{num(counts.observed)}</b> observed
          </span>
          <span>
            <b>{num(counts.derived)}</b> derived
          </span>
          <span>
            <b>{num(counts.fromYou)}</b> from you
          </span>
          <span>
            <b>{num(counts.assumed)}</b> assumed
          </span>
          {counts.gaps > 0 && (
            <span>
              <b>{num(counts.gaps)}</b> recorded as not known
            </span>
          )}
        </p>
      </PageHead>

      <ChartsPanel />

      <section className="fs-card" aria-label="The record">
        <div className="fs-top">
          <div className="fs-search">
            <label className="fs-label" htmlFor="fs-q">
              Search the record
            </label>
            <input
              id="fs-q"
              type="search"
              className="fs-input"
              placeholder="e.g. hours, price, channels"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="fs-filters" role="group" aria-label="Filter the record">
            {filters.map((f) => (
              <button
                key={f.m}
                type="button"
                className={`fs-filter${mode === f.m ? " on" : ""}`}
                aria-pressed={mode === f.m}
                onClick={() => setMode(f.m)}
              >
                {f.label}
              </button>
            ))}
            <button
              type="button"
              className={`fs-filter fs-toggle${showSuperseded ? "" : " off"}`}
              aria-pressed={showSuperseded}
              onClick={() => setShowSuperseded((v) => !v)}
              title={`${num(supersededCount)} superseded value${supersededCount === 1 ? "" : "s"}`}
            >
              Show superseded
            </button>
          </div>
        </div>

        <div className="fs-body">
          <nav className="fs-nav" aria-label="Sections of the record">
            <ul>
              {visible.map((s) => (
                <li key={s.section}>
                  <button
                    type="button"
                    className={`fs-nav-i${active === anchor(s.section) ? " on" : ""}`}
                    aria-current={active === anchor(s.section) ? "location" : undefined}
                    onClick={() => jump(anchor(s.section))}
                  >
                    <span>{s.label}</span>
                    <span className="fs-nav-n">{num(s.facts.length)}</span>
                  </button>
                </li>
              ))}
              {!filtering && gaps.length > 0 && (
                <li>
                  <button
                    type="button"
                    className={`fs-nav-i${active === GAPS ? " on" : ""}`}
                    aria-current={active === GAPS ? "location" : undefined}
                    onClick={() => jump(GAPS)}
                  >
                    <span>Still open</span>
                    <span className="fs-nav-n">{num(gaps.length)}</span>
                  </button>
                </li>
              )}
            </ul>
          </nav>

          <div className="fs-pane" ref={pane}>
            {visible.length === 0 && (
              <p className="fs-empty" role="status">
                {query.trim() !== ""
                  ? `No fact matches “${query.trim()}”.`
                  : mode === "assumed"
                    ? "No fact rests on an assumption — every value came from you, a connection or arithmetic."
                    : mode === "changed"
                      ? "Nothing was replaced this month."
                      : "Nothing recorded yet."}
              </p>
            )}
            {visible.map((s) => {
              const n = changedIn(s, changed);
              return (
                <section
                  key={s.section}
                  id={anchor(s.section)}
                  data-sec
                  className="fs-sec"
                  aria-labelledby={`${anchor(s.section)}-h`}
                >
                  <header className="fs-sec-head">
                    <h2 id={`${anchor(s.section)}-h`}>{s.label}</h2>
                    <span className="fs-meta">
                      {num(s.facts.length)} fact{s.facts.length === 1 ? "" : "s"}
                      {n > 0 && <> · {num(n)} changed this month</>}
                    </span>
                  </header>
                  <SectionTable
                    s={s}
                    history={history}
                    changed={changed}
                    showSuperseded={showSuperseded}
                  />
                  {s.section === "competitors" && <CompetitorFinder onChanged={load} />}
                </section>
              );
            })}
            {!filtering && !hasCompetitors && (
              <section className="fs-sec" aria-labelledby="fs-comp-h">
                <header className="fs-sec-head">
                  <h2 id="fs-comp-h">Competitors</h2>
                  <span className="fs-meta">none recorded</span>
                </header>
                <p className="fs-note">
                  Name them in the interview, or let me search from what you&rsquo;ve already told
                  me.
                </p>
                <CompetitorFinder onChanged={load} />
              </section>
            )}
            {!filtering && gaps.length > 0 && (
              <section id={GAPS} data-sec className="fs-sec" aria-labelledby={`${GAPS}-h`}>
                <header className="fs-sec-head">
                  <h2 id={`${GAPS}-h`}>Still open</h2>
                  <span className="fs-meta">
                    {num(gaps.length)} question{gaps.length === 1 ? "" : "s"} · a gap is a finding,
                    not a failure
                  </span>
                </header>
                <OpenQuestions gaps={gaps} />
              </section>
            )}
          </div>
        </div>

        <footer className="fs-foot">
          Struck-through lines were true until something better came in. Nothing in the record is
          ever deleted. Snapshot {sheet.snapshot_id.slice(0, 8)} · {fmtDay(sheet.taken_at)}.
        </footer>
      </section>
    </main>
  );
}
