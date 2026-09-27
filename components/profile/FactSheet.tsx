"use client";

// The fact sheet — P1-59/60. Session D's closing claim: the owner sees
// everything they told us, with its source, and everything still open,
// with what answering it would buy.
//
// Everything rendered here is the API's deterministic read of the
// snapshot. No number on this screen is computed in the browser beyond
// percentages for ring geometry.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

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
  input_type: string;
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

const SOURCE_LABEL: Record<string, string> = {
  owner_input: "you told me",
  conversation: "from our conversation",
  inferred: "computed",
  web_research: "researched",
  benchmark: "benchmark",
  connector: "measured",
};

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* Keys whose literal words mislead — the bank's phrasing, shortened. */
const KEY_LABEL: Record<string, string> = { volume_period: "sold per month" };
const nice = (key: string): string =>
  key
    .split(".")
    .slice(1)
    .filter((seg) => !UUID_SEG.test(seg))
    .map((seg) => KEY_LABEL[seg] ?? seg.replace(/_/g, " "))
    .join(" · ");

function SourcePill({ kind }: { kind: string }) {
  return <span className={`fs-pill s-${kind}`}>{SOURCE_LABEL[kind] ?? kind}</span>;
}

function Row({ fact }: { fact: FactRow }) {
  return (
    <div className={fact.status === "unknown" ? "fs-row unknown" : "fs-row"}>
      <span className="fs-key">{nice(fact.key) || fact.key}</span>
      <span className="fs-val">
        {fact.value ?? (
          <em>
            {fact.status !== "unknown"
              ? fact.status
              : fact.source_kind === "web_research"
                ? "their pages didn't say — that's recorded"
                : "you didn't know — that's recorded"}
          </em>
        )}
      </span>
      <span className="fs-meta">
        <SourcePill kind={fact.source_kind} />
        <i className="fs-conf" style={{ opacity: 0.35 + fact.confidence * 0.65 }}>
          {Math.round(fact.confidence * 100)}%
        </i>
      </span>
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
      setNote("couldn't reach the server");
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
        setNote("couldn't reach the server");
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  return (
    <section className="fs-block" id="fs-competitors" data-rail>
      <header className="fs-block-head">
        <h2>Competitors</h2>
        <button className="ghost" onClick={() => void discover()} disabled={busy !== null}>
          {busy === "discover" ? "searching the web…" : "Find my competitors"}
        </button>
      </header>

      {note !== null && <p className="fs-note">{note}</p>}

      {candidates !== null && candidates.length > 0 && (
        <div className="fs-cands">
          <p className="fs-cands-lede">
            Found by searching from what you told me. Nothing is saved until you confirm — you know
            your market better than a search does.
          </p>
          {candidates.map((c) => (
            <div className="fs-cand" key={c.url}>
              <div>
                <strong>{c.name}</strong>
                <a href={c.url} target="_blank" rel="noreferrer noopener">
                  {c.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}
                </a>
                <p>{c.evidence}</p>
              </div>
              <button className="ghost" onClick={() => void confirm(c)} disabled={busy !== null}>
                {busy === c.url ? "reading their pages…" : "That's one — look them up"}
              </button>
            </div>
          ))}
        </div>
      )}

      {groups.length === 0 && candidates === null && (
        <p className="fs-empty">
          None recorded yet. Name them in the interview, or let me search from what you&rsquo;ve
          already told me.
        </p>
      )}

      {groups.map((g) => (
        <div className="fs-entity" key={g.id}>
          <h3>{g.name ?? "unnamed competitor"}</h3>
          {g.facts
            .filter((f) => f.key !== "name")
            .map((f) => (
              <Row key={f.key} fact={{ ...f, key: `x.${f.key}` }} />
            ))}
        </div>
      ))}
    </section>
  );
}

export function FactSheetScreen() {
  const [sheet, setSheet] = useState<FactSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string>("");
  const [askIdx, setAskIdx] = useState(0);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

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

  // The rail follows the scroll: whichever marked section is nearest
  // the top of the viewport is the one lit.
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
  }, [sheet, query]);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!sheet) return [];
    if (q === "") return sheet.sections;
    return sheet.sections
      .map(({ section, facts }) => ({
        section,
        facts: facts.filter(
          (f) =>
            f.key.toLowerCase().includes(q) ||
            (f.value ?? "").toLowerCase().includes(q) ||
            f.source_kind.includes(q),
        ),
      }))
      .filter((s) => s.facts.length > 0);
  }, [sheet, q]);

  if (error === "no-session") {
    return (
      <main className="fs-shell">
        <p className="fs-empty">
          There&rsquo;s no profile on this device yet.{" "}
          <Link href="/intake">Start the questions</Link> — or open the link I sent you.
        </p>
      </main>
    );
  }
  if (error !== null) {
    return (
      <main className="fs-shell">
        <p className="fs-empty">Something went wrong loading your profile. Refresh to try again.</p>
      </main>
    );
  }
  if (sheet === null) {
    return (
      <main className="fs-shell">
        <p className="fs-empty">Reading your profile…</p>
      </main>
    );
  }

  const name =
    sheet.sections
      .find((s) => s.section === "identity")
      ?.facts.find((f) => f.key === "identity.legal_name")?.value ?? "your business";

  /* ── the worksheet: every line of the profile as one tile ── */
  const allFacts = [
    ...sheet.sections.flatMap((sec) => sec.facts.map((f) => ({ ...f, label: nice(f.key) }))),
    ...sheet.entities.flatMap((g) =>
      g.facts.map((f) => ({
        ...f,
        label: `${g.name ?? g.spine} — ${f.key === "name" ? "name" : f.key.replace(/_/g, " ")}`,
      })),
    ),
  ];
  const computedKinds = new Set(["inferred", "connector"]);
  const toldCount = allFacts.filter((f) => !computedKinds.has(f.source_kind)).length;
  const computedCount = allFacts.length - toldCount;
  const coreOpen = sheet.gaps.filter((g) => g.priority === "core").length;
  const optOpen = sheet.gaps.length - coreOpen;
  const total = allFacts.length + sheet.gaps.length;
  const pct = Math.round(sheet.completeness.overall * 100);
  const COLS = 11;
  const tiles = [
    ...allFacts.map((f, i) => ({
      n: i + 1,
      cls: computedKinds.has(f.source_kind) ? "computed" : "told",
      title: `${f.label || f.key} — ${SOURCE_LABEL[f.source_kind] ?? f.source_kind}`,
      gapIdx: null as number | null,
    })),
    ...sheet.gaps.map((g, i) => ({
      n: allFacts.length + i + 1,
      cls: g.priority === "core" ? "core-open" : "opt-open",
      title: g.prompt,
      gapIdx: i as number | null,
    })),
  ];
  const gapNow =
    sheet.gaps.length > 0 ? (sheet.gaps[Math.min(askIdx, sheet.gaps.length - 1)] ?? null) : null;
  const askLine = allFacts.length + Math.min(askIdx, Math.max(sheet.gaps.length - 1, 0)) + 1;
  const nextSkipIdx = sheet.gaps.length > 1 ? (askIdx + 1) % sheet.gaps.length : askIdx;
  const textLike = gapNow !== null && ["text", "long_text", "number"].includes(gapNow.input_type);

  const post = async (): Promise<void> => {
    if (!gapNow || draft.trim() === "" || posting) return;
    const wire: string | number =
      gapNow.input_type === "number" ? Number(draft.replace(/[ ,]/g, "")) : draft.trim();
    if (typeof wire === "number" && Number.isNaN(wire)) {
      setPostError("that one needs a number");
      return;
    }
    setPosting(true);
    setPostError(null);
    try {
      const res = await fetch("/api/intake", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_id: gapNow.question_id, action: { kind: "value", wire } }),
      });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) {
        setPostError(payload.error ?? "that didn't record — try it in the interview");
        return;
      }
      setDraft("");
      setAskIdx(0);
      await load();
    } catch {
      setPostError("couldn't reach the server — try again");
    } finally {
      setPosting(false);
    }
  };

  const pickGap = (i: number): void => {
    setAskIdx(i);
    setDraft("");
    setPostError(null);
  };

  return (
    <main className="fs-shell">
      <header className="fs-top">
        <span className="wordmark">Ledgerline</span>
        <div className="fs-topright">
          <span className="fs-lock">
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden="true"
            >
              <rect x="4" y="10" width="16" height="11" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
            {sheet.completeness.core_complete
              ? "diagnosis unlocked"
              : `diagnosis locked · ${coreOpen} to go`}
          </span>
          <nav className="fs-nav">
            <span aria-current="page">Fact sheet</span>
            <Link href="/intake">Interview</Link>
          </nav>
        </div>
      </header>

      <span className="fs-edge" aria-hidden="true">
        {name} — fact sheet — sheet 01
      </span>
      <span className="fs-edge-pct" aria-hidden="true">
        {pct} %
      </span>

      <nav className="fs-rail" aria-label="Sections">
        <a href="#fs-hero" className={active === "fs-hero" ? "on" : ""}>
          worksheet <b>{total}</b>
        </a>
        <a href="#fs-competitors" className={active === "fs-competitors" ? "on" : ""}>
          competitors
        </a>
        {filtered.map(({ section, facts }) => (
          <a
            key={section}
            href={`#sec-${section}`}
            className={active === `sec-${section}` ? "on" : ""}
          >
            {section.replace(/_/g, " ")} <b>{facts.length}</b>
          </a>
        ))}
        {sheet.entities.filter((e) => e.spine !== "competitors").length > 0 && (
          <a href="#fs-entities" className={active === "fs-entities" ? "on" : ""}>
            offers &amp; more
          </a>
        )}
      </nav>

      {/* ── the worksheet hero: what we know, what we don't, one line loaded ── */}
      <section className="fs-hero" id="fs-hero" data-rail>
        <div className="fs-hero-left">
          <p className="fs-eyebrow">
            <i />
            {name} ·{" "}
            {new Date(sheet.taken_at)
              .toLocaleDateString("en-GB", { day: "numeric", month: "short" })
              .toUpperCase()}
          </p>
          <h1 className="fs-hero-h">
            {allFacts.length} thing{allFacts.length === 1 ? "" : "s"} we know.
            <br />
            <b>{sheet.gaps.length}</b> we don&rsquo;t.
          </h1>

          {gapNow && (
            <div className="fs-ask">
              <p className="fs-ask-tag">
                <span className="fs-ask-num">{askLine}</span>
                {gapNow.priority} · next up
              </p>
              <h2 className="fs-ask-q">{gapNow.prompt}</h2>
              {textLike ? (
                <>
                  <textarea
                    className="fs-ask-field"
                    placeholder="Answer in your own words. It stays on file with your name on it."
                    value={draft}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setPostError(null);
                    }}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void post();
                    }}
                    disabled={posting}
                  />
                  <div className="fs-ask-row">
                    <button
                      className="next fs-ask-post"
                      onClick={() => void post()}
                      disabled={posting || draft.trim() === ""}
                    >
                      {posting ? "Recording…" : "Post answer →"}
                    </button>
                    {sheet.gaps.length > 1 && (
                      <button className="fs-ask-skip" onClick={() => pickGap(nextSkipIdx)}>
                        Skip to line {allFacts.length + nextSkipIdx + 1}
                      </button>
                    )}
                    <span className="fs-ask-hint">⌘↩ to post</span>
                  </div>
                </>
              ) : (
                <div className="fs-ask-row">
                  <Link
                    className="next fs-ask-post"
                    href={`/intake?ask=${encodeURIComponent(gapNow.question_id)}`}
                  >
                    This one has options — answer it in the interview →
                  </Link>
                  {sheet.gaps.length > 1 && (
                    <button className="fs-ask-skip" onClick={() => pickGap(nextSkipIdx)}>
                      Skip to line {allFacts.length + nextSkipIdx + 1}
                    </button>
                  )}
                </div>
              )}
              {postError && <p className="auth-error">{postError}</p>}
            </div>
          )}
        </div>

        <figure className="fs-fig">
          <div className="fs-gridbox">
            <div className="fs-grid-head">
              <span />
              {Array.from({ length: COLS }, (_, i) => (
                <span key={i}>{i + 1}</span>
              ))}
            </div>
            <div className="fs-grid">
              {Array.from({ length: Math.ceil(total / COLS) }, (_, r) => (
                <Fragment key={r}>
                  <span className="fs-grid-letter">{String.fromCharCode(65 + r)}</span>
                  {tiles.slice(r * COLS, (r + 1) * COLS).map((t) =>
                    t.gapIdx !== null ? (
                      <button
                        key={t.n}
                        type="button"
                        className={`fs-tile ${t.cls}${t.gapIdx === askIdx ? " next" : ""}`}
                        title={t.title}
                        onClick={() => pickGap(t.gapIdx as number)}
                      >
                        <span>{t.n}</span>
                      </button>
                    ) : (
                      <div key={t.n} className={`fs-tile ${t.cls}`} title={t.title}>
                        <span>{t.n}</span>
                      </div>
                    ),
                  )}
                </Fragment>
              ))}
            </div>
          </div>
          <figcaption className="fs-figcap">
            <span className="fig-n">Fig. 1</span>
            <span>
              <b>
                {name}, all {total} lines.
              </b>{" "}
              Every filled tile carries its source; the diagnosis runs once the {coreOpen} outlined
              line{coreOpen === 1 ? "" : "s"} {coreOpen === 1 ? "is" : "are"} filled.
            </span>
          </figcaption>
          <div className="fs-legend">
            <span className="l-told">
              <i />
              <b>{toldCount}</b> you told us
            </span>
            <span className="l-computed">
              <i />
              <b>{computedCount}</b> computed
            </span>
            <span className="l-core">
              <i />
              <b>{coreOpen}</b> core, open
            </span>
            <span className="l-opt">
              <i />
              <b>{optOpen}</b> optional, open
            </span>
            <span className="fs-legend-pct">
              <b>{pct}%</b> complete
            </span>
          </div>
        </figure>
      </section>

      <Competitors
        groups={sheet.entities.filter((e) => e.spine === "competitors")}
        onChanged={load}
      />

      {/* ── every scalar fact, by section ── */}
      <div className="fs-search">
        <input
          className="field"
          placeholder={`Search across ${sheet.fact_count} facts`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {filtered.map(({ section, facts }) => (
        <section className="fs-block" key={section} id={`sec-${section}`} data-rail>
          <header className="fs-block-head">
            <h2>{section}</h2>
            <span className="fs-block-meta">
              {facts.length} fact{facts.length === 1 ? "" : "s"}
            </span>
          </header>
          {facts.map((f) => (
            <Row key={f.key} fact={f} />
          ))}
        </section>
      ))}

      {sheet.entities.filter((e) => e.spine !== "competitors").length > 0 && (
        <section className="fs-block" id="fs-entities" data-rail>
          <header className="fs-block-head">
            <h2>Offers &amp; the rest</h2>
          </header>
          {sheet.entities
            .filter((e) => e.spine !== "competitors")
            .map((g) => (
              <div className="fs-entity" key={g.id}>
                <h3>
                  {g.name ?? g.spine} <span className="fs-block-meta">{g.spine}</span>
                </h3>
                {g.facts
                  .filter((f) => f.key !== "name")
                  .map((f) => (
                    <Row key={f.key} fact={{ ...f, key: `x.${f.key}` }} />
                  ))}
              </div>
            ))}
        </section>
      )}

      <footer className="fs-foot">
        Snapshot {sheet.snapshot_id.slice(0, 8)} · nothing here is invented — a value I computed
        says so, a value you gave me says so.
      </footer>
    </main>
  );
}
