// The fact sheet's model — pure, so its rules are unit tested
// (components/profile/model.test.ts). It turns GET /api/profile into the
// owner's fact-sheet design (2026-10-17): sections with counts, one row
// per fact with value · source · basis · since, the superseded values
// struck through beneath the fact they used to be (rule 3), and the
// filters the design offers — all, assumed, changed this month, show
// superseded — over a free-text search.

import type { Basis, BasisInput } from "../report/basis";
import { basisOf, gapWord } from "../report/basis";
import { isFigureText, keyWords, refigureNumber } from "../report/figures";

/* ── the API's shapes (lib/profile/factsheet.ts) ── */

export interface FactRow extends BasisInput {
  key: string;
  value: string | null;
  status: string;
  confidence: number;
  source_kind: string;
  source_detail: string | null;
  observed_at: string;
  recorded_at?: string;
  note: string | null;
}
export interface EntityGroup {
  id: string;
  spine: string;
  name: string | null;
  facts: FactRow[];
}
export interface GapRow {
  question_id: string;
  prompt: string;
  section: string;
  priority: "core" | "important" | "deep" | "optional";
  buys: string;
  blocking: boolean;
}
export interface SupersededFact {
  key: string;
  value: string | null;
  status: string;
  source_kind: string;
  source_detail: string | null;
  observed_at: string;
  recorded_at: string;
  superseded_at: string;
  note: string | null;
}
export interface FactSheet {
  profile_id: string;
  snapshot_id: string;
  taken_at: string;
  fact_count: number;
  completeness: { overall: number; core_complete: boolean };
  provenance: { kind: string; count: number }[];
  sections: { section: string; facts: FactRow[] }[];
  entities: EntityGroup[];
  gaps: GapRow[];
  /** Absent from a server older than the history view. */
  history?: Record<string, SupersededFact[]>;
  changed_since?: string;
  changed?: string[];
}

/* ── sections, in the data model's order, in the owner's words ── */

export const SECTION_LABEL: Record<string, string> = {
  identity: "Who you are",
  presence: "Where you trade",
  offers: "What you sell",
  revenue: "Revenue",
  costs: "Costs",
  customers: "Customers",
  channels: "Channels",
  marketing: "Marketing",
  operations: "Operations",
  tooling: "Tools",
  legal: "Legal & tax",
  competitors: "Competitors",
  goals: "Your targets",
  assets: "Files",
};
const ORDER = Object.keys(SECTION_LABEL);

/** Where an entity's facts are filed — data-model §5.1, the entity spines. */
const SPINE_SECTION: Record<string, string> = {
  offers: "offers",
  suppliers: "offers",
  competitors: "competitors",
  channels: "channels",
  staff_roles: "operations",
  locations: "presence",
};
const SPINE_NOUN: Record<string, string> = {
  offers: "Product",
  suppliers: "Supplier",
  competitors: "Competitor",
  channels: "Channel",
  staff_roles: "Role",
  locations: "Location",
};

export interface DisplayFact {
  /** The full field_key — what history and "changed" are keyed by. */
  key: string;
  label: string;
  fact: FactRow;
}
export interface DisplaySection {
  section: string;
  label: string;
  facts: DisplayFact[];
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Every fact, scalar and entity, filed under its section, sections in order. */
export function displaySections(sheet: FactSheet): DisplaySection[] {
  const by = new Map<string, DisplayFact[]>();
  const add = (section: string, f: DisplayFact) => by.set(section, [...(by.get(section) ?? []), f]);

  for (const s of sheet.sections) {
    for (const f of s.facts)
      add(s.section, { key: f.key, label: sentence(keyWords(f.key)), fact: f });
  }
  for (const g of sheet.entities) {
    const section = SPINE_SECTION[g.spine] ?? g.spine;
    const noun = SPINE_NOUN[g.spine] ?? sentence(g.spine.replace(/_/g, " "));
    // A channel has no name field; its platform or type says which one it is.
    const named =
      g.name ??
      g.facts.find((f) => f.key === "platform")?.value ??
      g.facts.find((f) => f.key === "type")?.value ??
      null;
    for (const f of g.facts) {
      const field = keyWords(f.key, false);
      const label =
        f.key === "name" ? `${noun} name` : `${named !== null ? sentence(named) : noun} · ${field}`;
      add(section, { key: `${g.id}.${f.key}`, label, fact: f });
    }
  }
  return [...by.entries()]
    .map(([section, facts]) => ({
      section,
      label: SECTION_LABEL[section] ?? sentence(section),
      facts,
    }))
    .sort((a, b) => rank(a.section) - rank(b.section));
}

const rank = (s: string) => {
  const i = ORDER.indexOf(s);
  return i < 0 ? ORDER.length : i;
};

/* ── the basis word the design prints, and its tint ── */

export type BasisTone = "ink" | "you" | "drift" | "low";

export interface BasisWord {
  word: string;
  tone: BasisTone;
  basis: Basis | null;
}

/**
 * The design's basis column: OBSERVED, DERIVED, FROM YOU, ASSUMED. The
 * owner's own answers (basis STATED or ESTIMATED) read FROM YOU; an
 * estimate says so in the word, so it is never shown as exact. A fact
 * with no value prints its gap status instead (rule 5).
 */
export function basisWord(f: BasisInput): BasisWord {
  const basis = basisOf(f);
  switch (basis) {
    case "OBSERVED":
    case "DERIVED":
      return { word: basis, tone: "ink", basis };
    case "STATED":
      return { word: "FROM YOU", tone: "you", basis };
    case "ESTIMATED":
      return { word: "FROM YOU · EST.", tone: "you", basis };
    case "ASSUMED":
      return { word: "ASSUMED", tone: "drift", basis };
    default:
      return { word: gapWord(f.status), tone: "low", basis: null };
  }
}

/** The header line: "118 observed · 41 derived · 37 from you · 16 assumed". */
export function basisCounts(facts: readonly BasisInput[]): {
  observed: number;
  derived: number;
  fromYou: number;
  assumed: number;
  gaps: number;
} {
  const out = { observed: 0, derived: 0, fromYou: 0, assumed: 0, gaps: 0 };
  for (const f of facts) {
    const b = basisOf(f);
    if (b === "OBSERVED") out.observed += 1;
    else if (b === "DERIVED") out.derived += 1;
    else if (b === "STATED" || b === "ESTIMATED") out.fromYou += 1;
    else if (b === "ASSUMED") out.assumed += 1;
    else out.gaps += 1;
  }
  return out;
}

/* ── the source column ── */

const tidyUrl = (d: string) => d.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/** "you · interview", "measured · stripe charges", "computed · price − cost" … */
export function sourceText(f: { source_kind: string; source_detail: string | null }): string {
  const d = f.source_detail;
  switch (f.source_kind) {
    case "owner_input":
      return "you · interview";
    case "conversation":
      return "you · conversation";
    case "connector":
      return d ? `measured · ${d}` : "measured · connected account";
    case "web_research":
      return d ? `researched · ${tidyUrl(d)}` : "researched";
    case "inferred":
      return d ? `computed · ${d}` : "computed";
    case "document":
      return "from a document";
    case "system_default":
      return "default until you confirm";
    default:
      return f.source_kind.replace(/_/g, " ");
  }
}

/* ── values ── */

export interface ValueView {
  text: string;
  /** A figure (money or a number) — set in mono. */
  figure: boolean;
  /** No value: the gap as what it is (rule 5). */
  gap: boolean;
}

export function valueView(f: {
  value: string | null;
  status: string;
  source_kind: string;
}): ValueView {
  if (f.value === null) {
    const text =
      f.status === "unknown"
        ? f.source_kind === "web_research"
          ? "their pages didn't say"
          : "you didn't know — recorded"
        : f.status === "skipped"
          ? "skipped for now"
          : f.status === "not_applicable"
            ? "doesn't apply"
            : "not asked yet";
    return { text, figure: false, gap: true };
  }
  if (isFigureText(f.value)) return { text: refigureNumber(f.value), figure: true, gap: false };
  return { text: f.value, figure: false, gap: false };
}

/* ── filters ── */

export type Mode = "all" | "assumed" | "changed";

/**
 * The visible sections under the design's filters: ASSUMED keeps facts
 * whose basis is ASSUMED; CHANGED keeps facts replaced since the month
 * began; the query matches a fact's label, value, source, basis word or
 * its section's name. Sections left empty drop out.
 */
export function filterSections(
  sections: readonly DisplaySection[],
  opts: { mode: Mode; query: string; changed: ReadonlySet<string> },
): DisplaySection[] {
  const q = opts.query.trim().toLowerCase();
  return sections
    .map((s) => ({
      ...s,
      facts: s.facts.filter((d) => {
        if (opts.mode === "assumed" && basisOf(d.fact) !== "ASSUMED") return false;
        if (opts.mode === "changed" && !opts.changed.has(d.key)) return false;
        if (q === "") return true;
        const hay = [
          d.label,
          d.fact.value ?? "",
          sourceText(d.fact),
          basisWord(d.fact).word,
          s.label,
          d.key,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      }),
    }))
    .filter((s) => s.facts.length > 0);
}

/** How many facts of a section changed since the month began. */
export const changedIn = (s: DisplaySection, changed: ReadonlySet<string>): number =>
  s.facts.filter((d) => changed.has(d.key)).length;
