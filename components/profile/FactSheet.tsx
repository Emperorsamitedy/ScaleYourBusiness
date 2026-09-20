"use client";

// The fact sheet — P1-59/60. Session D's closing claim: the owner sees
// everything they told us, with its source, and everything still open,
// with what answering it would buy.
//
// Everything rendered here is the API's deterministic read of the
// snapshot. No number on this screen is computed in the browser beyond
// percentages for ring geometry.

import { useCallback, useEffect, useMemo, useState } from "react";
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

const nice = (key: string): string => key.split(".").slice(1).join(" · ").replace(/_/g, " ");

function Ring({ frac, label }: { frac: number; label: string }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <svg viewBox="0 0 110 110" className="fs-ring" aria-label={`completeness ${label}`}>
      <circle cx="55" cy="55" r={R} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="9" />
      <circle
        cx="55"
        cy="55"
        r={R}
        fill="none"
        stroke="url(#fsGrad)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeDasharray={`${(C * frac).toFixed(1)} ${C.toFixed(1)}`}
        transform="rotate(-90 55 55)"
      />
      <defs>
        <linearGradient id="fsGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffb25c" />
          <stop offset="100%" stopColor="#e1560f" />
        </linearGradient>
      </defs>
      <text x="55" y="61" textAnchor="middle" className="fs-ring-v">
        {label}
      </text>
    </svg>
  );
}

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
    <section className="fs-block">
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
  const blocking = sheet.gaps.filter((g) => g.blocking).length;

  return (
    <main className="fs-shell">
      <header className="fs-top">
        <span className="wordmark">Ledgerline</span>
        <nav className="fs-nav">
          <span aria-current="page">Fact sheet</span>
          <Link href="/intake">Interview</Link>
        </nav>
      </header>

      <div className="fs-title">
        <h1>{name}</h1>
        <span className="fs-title-meta">
          {sheet.fact_count} facts · as of{" "}
          {new Date(sheet.taken_at).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
          })}{" "}
          · every one carries its source
        </span>
      </div>

      <div className="fs-summary">
        <div className="fs-card fs-comp">
          <Ring
            frac={sheet.completeness.overall}
            label={`${Math.round(sheet.completeness.overall * 100)}%`}
          />
          <div>
            <h2>How complete this is</h2>
            <p>
              {sheet.completeness.core_complete
                ? "The core set is answered — the picture holds."
                : `${blocking} core question${blocking === 1 ? "" : "s"} still open — these hold the diagnosis back.`}
            </p>
          </div>
        </div>

        <div className="fs-card fs-prov">
          <h2>Where the {sheet.fact_count} came from</h2>
          {sheet.provenance.map((p) => (
            <div className="fs-prov-row" key={p.kind}>
              <SourcePill kind={p.kind} />
              <i className="fs-prov-bar">
                <b style={{ width: `${(p.count / sheet.fact_count) * 100}%` }} />
              </i>
              <span>{p.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── the gaps: what's missing and what answering it buys (P1-60) ── */}
      {sheet.gaps.length > 0 && (
        <section className="fs-block">
          <header className="fs-block-head">
            <h2>Still open</h2>
            <span className="fs-block-meta">
              {sheet.gaps.length} question{sheet.gaps.length === 1 ? "" : "s"} · a gap is a finding,
              not a failure
            </span>
          </header>
          {sheet.gaps.slice(0, 12).map((g) => (
            <div className={g.blocking ? "fs-gap blocking" : "fs-gap"} key={g.question_id}>
              <span className={`fs-gap-p ${g.priority}`}>{g.priority}</span>
              <div>
                <p className="fs-gap-q">{g.prompt}</p>
                <p className="fs-gap-b">{g.buys}</p>
              </div>
              <Link
                className="ghost quiet"
                href={`/intake?ask=${encodeURIComponent(g.question_id)}`}
              >
                Answer now
              </Link>
            </div>
          ))}
          {sheet.gaps.length > 12 && (
            <p className="fs-note">…and {sheet.gaps.length - 12} more, waiting in the interview.</p>
          )}
        </section>
      )}

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
        <section className="fs-block" key={section}>
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
        <section className="fs-block">
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
