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
//
// L-3a: the screen's words are the "factsheet" catalogue in the reader's
// language, every figure and date the reader's own writing; the facts'
// labels and coded values arrive named by the server (app/api/profile).

import "../../app/factsheet.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useBusinessNoun } from "../nav/useBusinessNoun";
import { ChartsPanel } from "../charts/ChartsPanel";
import { SegBar } from "../charts/Viz";
import { PageHead } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { gapBuysWords } from "../../lib/profile/gap-words";
import { fmtDay } from "../report/figures";
import type { DisplaySection, FactSheet, FsWords, GapRow, Mode, SupersededFact } from "./model";
import {
  basisCounts,
  basisSegs,
  basisWord,
  changedIn,
  displaySections,
  filterSections,
  sourceText,
  valueView,
} from "./model";
import { newerKind, successorKind } from "../report/basis";
import { WhyFold } from "../report/WhyFold";

interface Candidate {
  name: string;
  url: string;
  evidence: string;
}

const anchor = (section: string) => `fs-${section}`;
const GAPS = "fs-open";

/** The sheet's words: the catalogue, the shared sheet words and the locale. */
function useFsWords(): FsWords {
  const fs = useTr("factsheet");
  const sheet = useTr("sheet");
  return { tr: fs.tr, st: sheet.tr, locale: fs.locale };
}

/** Competitors: the one section with an action — the agent goes and looks. */
function CompetitorFinder({ onChanged }: { onChanged: () => Promise<void> }) {
  const t = useTranslations("factsheet.finder");
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
        setNote(payload.error ?? t("nothingUsable"));
        return;
      }
      setCandidates(payload.candidates);
    } catch {
      setNote(t("unreachable"));
    } finally {
      setBusy(null);
    }
  }, [t]);

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
          setNote(payload.error ?? t("failed"));
          return;
        }
        setCandidates((prev) => prev?.filter((c) => c.url !== candidate.url) ?? null);
        await onChanged();
      } catch {
        setNote(t("unreachable"));
      } finally {
        setBusy(null);
      }
    },
    [onChanged, t],
  );

  return (
    <div className="fs-finder">
      <button className="fs-btn" onClick={() => void discover()} disabled={busy !== null}>
        {busy === "discover" ? t("searching") : t("find")}
      </button>
      {busy !== null && (
        <p className="fs-status live" role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />{" "}
          {busy === "discover" ? t("searchingFrom") : t("readingPages")}
        </p>
      )}
      {note !== null && (
        <p className="fs-note" role="alert">
          {note}
        </p>
      )}
      {candidates !== null && candidates.length > 0 && (
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
                {busy === c.url ? t("readingPagesNow") : t("thatsOne")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SupersededRow({
  label,
  h,
  by,
}: {
  label: string;
  h: SupersededFact;
  by: ReturnType<typeof newerKind>;
}) {
  const t = useTranslations("factsheet");
  const w = useFsWords();
  const v = valueView(h, w);
  return (
    <tr className="fs-sup">
      <th scope="row">
        <s>{label}</s>
        <s className="fs-sub">
          {t("superseded", { date: fmtDay(h.superseded_at, undefined, w.locale), kind: by })}
        </s>
      </th>
      <td className="num" data-label={t("col.value")}>
        <s>{v.text}</s>
      </td>
      <td className="fs-src" data-label={t("col.source")}>
        {sourceText(h, w)}
      </td>
      <td data-label={t("col.basis")}>
        <span className="fs-basis sup">{t("supersededWord")}</span>
      </td>
      <td className="num fs-since" data-label={t("col.since")}>
        {fmtDay(h.observed_at, undefined, w.locale)}
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
  const t = useTranslations("factsheet");
  const w = useFsWords();
  return (
    <table className="fs-table">
      <caption className="sr-only">{t("caption", { section: s.label })}</caption>
      <thead>
        <tr>
          <th scope="col">{t("col.fact")}</th>
          <th scope="col" className="num">
            {t("col.value")}
          </th>
          <th scope="col">{t("col.source")}</th>
          <th scope="col">{t("col.basis")}</th>
          <th scope="col" className="num">
            {t("col.since")}
          </th>
        </tr>
      </thead>
      <tbody>
        {s.facts.map((d) => {
          const v = valueView(d.fact, w);
          const b = basisWord(d.fact, w);
          const past = showSuperseded ? (history[d.key] ?? []) : [];
          return [
            <tr key={d.key} id={`fact-${d.key}`} className={v.gap ? "fs-gap" : undefined}>
              <th scope="row">
                {d.label}
                {d.fact.note !== null && d.fact.value !== null && (
                  <span className="fs-sub">{t("noted", { note: d.fact.note })}</span>
                )}
              </th>
              <td className={`num${v.figure ? "" : " fs-words"}`} data-label={t("col.value")}>
                {changed.has(d.key) ? <span className="marked">{v.text}</span> : v.text}
              </td>
              <td className="fs-src" data-label={t("col.source")}>
                {sourceText(d.fact, w)}
              </td>
              <td data-label={t("col.basis")}>
                <span className={`fs-basis ${b.tone}`}>{b.word}</span>
              </td>
              <td className="num fs-since" data-label={t("col.since")}>
                {fmtDay(d.fact.observed_at, undefined, w.locale)}
              </td>
            </tr>,
            ...past.map((h, i) => (
              <SupersededRow
                key={`${d.key}~${h.superseded_at}~${i}`}
                label={d.label}
                h={h}
                by={newerKind(successorKind(past, i, d.fact.source_kind))}
              />
            )),
          ];
        })}
      </tbody>
    </table>
  );
}

const PRIORITIES = new Set(["core", "important", "deep", "optional"]);

function OpenQuestions({ gaps }: { gaps: GapRow[] }) {
  const t = useTranslations("factsheet");
  const { locale } = useFsWords();
  const rw = useTr("reportWords").tr;
  const [all, setAll] = useState(false);
  const shown = all ? gaps : gaps.slice(0, 6);
  return (
    <>
      <ul className="fs-gaps">
        {shown.map((g) => (
          <li key={g.question_id}>
            <div>
              <p className="fs-gap-head">
                <span className="fs-sub">
                  {PRIORITIES.has(g.priority) ? t(`priority.${g.priority}`) : g.priority}
                </span>
                {g.blocking && <span className="word drift">{t("blocking")}</span>}
              </p>
              <p className="fs-gap-q">{g.prompt}</p>
              <p className="fs-sub">{gapBuysWords(g.buys, g.priority, rw, locale)}</p>
            </div>
            <Link className="fs-btn" href={`/intake?ask=${encodeURIComponent(g.question_id)}`}>
              {t("answerNow")}
            </Link>
          </li>
        ))}
      </ul>
      {gaps.length > 6 && (
        <button className="fs-btn fs-more" onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? t("showFewer") : t("showAll", { count: num(gaps.length, 0, locale) })}
        </button>
      )}
    </>
  );
}

export function FactSheetScreen() {
  const t = useTranslations("factsheet");
  const w = useFsWords();
  const n = (x: number) => num(x, 0, w.locale);
  const [sheet, setSheet] = useState<FactSheet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("all");
  const [showSuperseded, setShowSuperseded] = useState(true);
  const [active, setActive] = useState<string>("");
  const pane = useRef<HTMLDivElement>(null);
  const businessNoun = useBusinessNoun();
  // "your salon" is English's own table (lib/core/business-noun); another language says "your business".
  const noun = w.locale === "en" ? businessNoun : t("yourBusiness");

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

  const sections = useMemo(() => (sheet ? displaySections(sheet, w) : []), [sheet, w]);
  const changed = useMemo(() => new Set(sheet?.changed ?? []), [sheet]);
  const history = useMemo(() => sheet?.history ?? {}, [sheet]);
  const visible = useMemo(
    () => filterSections(sections, { mode, query, changed }, w),
    [sections, mode, query, changed, w],
  );
  const allFacts = useMemo(() => sections.flatMap((s) => s.facts.map((d) => d.fact)), [sections]);
  const counts = useMemo(() => basisCounts(allFacts), [allFacts]);
  const segs = useMemo(() => basisSegs(allFacts, w), [allFacts, w]);
  const supersededCount = useMemo(
    () => Object.values(history).reduce((x, l) => x + l.length, 0),
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
        <PageHead kicker={t("kicker")} title={t("titleEmpty")} />
        <section className="fs-card fs-msg">
          {error === "no-session" ? (
            <p>
              {t.rich("noSession", {
                a: (chunks) => <Link href="/intake">{chunks}</Link>,
              })}
            </p>
          ) : error !== null ? (
            <p role="alert">{t("failed")}</p>
          ) : (
            <p role="status">{t("reading")}</p>
          )}
        </section>
      </main>
    );
  }

  const filters: { m: Mode; label: string }[] = [
    { m: "all", label: t("filter.all") },
    { m: "assumed", label: t("filter.assumed", { count: n(counts.assumed) }) },
    { m: "changed", label: t("filter.changed", { count: n(changed.size) }) },
  ];
  const b = (chunks: ReactNode) => <b>{chunks}</b>;

  return (
    <main className="screen fs">
      <PageHead
        kicker={t("kicker")}
        title={t("title", { count: allFacts.length, noun })}
        aside={
          // Idea 49: the money facts for whoever keeps the books. Signed-in owners only.
          <p className="fs-export">
            <a href="/api/profile/export?part=current" download>
              {t("export.current")}
            </a>
            <a href="/api/profile/export?part=history" download>
              {t("export.history")}
            </a>
          </p>
        }
      >
        {segs.length > 0 && (
          <div className="fs-mix">
            <SegBar bare segs={segs} label={t("title", { count: allFacts.length, noun })} />
          </div>
        )}
        <p className="fs-counts">
          <span>{t.rich("counts.observed", { count: counts.observed, b })}</span>
          <span>{t.rich("counts.derived", { count: counts.derived, b })}</span>
          <span>{t.rich("counts.fromYou", { count: counts.fromYou, b })}</span>
          <span>{t.rich("counts.assumed", { count: counts.assumed, b })}</span>
          {counts.gaps > 0 && <span>{t.rich("counts.gaps", { count: counts.gaps, b })}</span>}
        </p>
      </PageHead>

      <ChartsPanel />

      <section className="fs-card" aria-label={t("recordLabel")}>
        <div className="fs-top">
          <div className="fs-search">
            <label className="fs-label" htmlFor="fs-q">
              {t("search")}
            </label>
            <input
              id="fs-q"
              type="search"
              className="fs-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="fs-filters" role="group" aria-label={t("filterLabel")}>
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
              title={t("supersededCount", { count: supersededCount })}
            >
              {t("showSuperseded")}
            </button>
          </div>
        </div>

        <div className="fs-body">
          <nav className="fs-nav" aria-label={t("sectionsLabel")}>
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
                    <span className="fs-nav-n">{n(s.facts.length)}</span>
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
                    <span>{t("stillOpen")}</span>
                    <span className="fs-nav-n">{n(gaps.length)}</span>
                  </button>
                </li>
              )}
            </ul>
          </nav>

          <div className="fs-pane" ref={pane}>
            {visible.length === 0 && (
              <p className="fs-empty" role="status">
                {query.trim() !== ""
                  ? t("empty.query", { query: query.trim() })
                  : mode === "assumed"
                    ? t("empty.assumed")
                    : mode === "changed"
                      ? t("empty.changed")
                      : t("empty.none")}
              </p>
            )}
            {visible.map((s) => {
              const c = changedIn(s, changed);
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
                    {c > 0 && <span className="fs-meta">{t("sectionChanged", { count: c })}</span>}
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
                  <h2 id="fs-comp-h">{t("section.competitors")}</h2>
                  <span className="fs-meta">{t("noneRecorded")}</span>
                </header>
                <CompetitorFinder onChanged={load} />
              </section>
            )}
            {!filtering && gaps.length > 0 && (
              <section id={GAPS} data-sec className="fs-sec" aria-labelledby={`${GAPS}-h`}>
                <header className="fs-sec-head">
                  <h2 id={`${GAPS}-h`}>{t("stillOpen")}</h2>
                  <span className="fs-meta">{t("openMeta", { count: gaps.length })}</span>
                </header>
                <OpenQuestions gaps={gaps} />
              </section>
            )}
          </div>
        </div>

        <footer className="fs-foot">
          <WhyFold>
            {t("foot", {
              id: sheet.snapshot_id.slice(0, 8),
              date: fmtDay(sheet.taken_at, undefined, w.locale),
            })}
          </WhyFold>
        </footer>
      </section>
    </main>
  );
}
