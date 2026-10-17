// The record column's wording — pure, so it is testable without a DOM.
//
// Progress is the record filling up (owner brief, 2026-10-17): never an
// "N / M" fraction, but how much is on record, in words with mono
// figures. Every chip is a fact line with its provenance printed: what
// was recorded, where it came from, and on what basis. "I don't know"
// and "skip" stay distinct (CLAUDE.md rule 5): an unknown is a recorded
// gap with a follow-up; a skip is "Not provided".

import type { IntakeChip, IntakeProgress, IntakeQuestion } from "@/lib/intake/types";

/** What a chip records, read from its server-built provenance line. */
export type FactKind = "stated" | "estimate" | "unknown" | "skipped" | "reopened";

export interface FactLine {
  kind: FactKind;
  /** Mono flag, worded: the meaning never rides on colour. */
  flag: "RECORDED" | "ESTIMATE" | "GAP RECORDED" | "NOT PROVIDED" | "REOPENED";
  /** The question's id in the bank, e.g. "1.4". */
  ref: string;
  /** The recorded value as the owner reads it. */
  value: string;
  /** "Source: you · stated". */
  source: string;
  /** A follow-up note for gaps and skips; null for recorded facts. */
  followUp: string | null;
}

/**
 * The server prints provenance as "<id> · <source> · <basis>"
 * (lib/intake/service.ts): "1.4 · owner · stated", "1.4 · owner ·
 * estimate", "1.4 · gap · will revisit", "1.4 · skipped · will return",
 * "1.4 · reopened". IntakeChip carries no explicit status, so the line
 * is the only signal; anything unrecognised reads as stated.
 */
export function parseProvenance(provenance: string): { ref: string; kind: FactKind } {
  const parts = provenance.split("·").map((p) => p.trim());
  const ref = parts[0] ?? "";
  const second = parts[1] ?? "";
  const third = parts[2] ?? "";
  if (second === "gap") return { ref, kind: "unknown" };
  if (second === "skipped") return { ref, kind: "skipped" };
  if (second === "reopened") return { ref, kind: "reopened" };
  if (third === "estimate") return { ref, kind: "estimate" };
  return { ref, kind: "stated" };
}

const SOURCE_WORD: Record<string, string> = { owner: "you" };

export function factLine(chip: IntakeChip): FactLine {
  const { ref, kind } = parseProvenance(chip.provenance);
  const sourceRaw = chip.provenance.split("·").map((p) => p.trim())[1] ?? "owner";
  const source = SOURCE_WORD[sourceRaw] ?? sourceRaw;
  switch (kind) {
    case "unknown":
      return {
        kind,
        flag: "GAP RECORDED",
        ref,
        value: "Not known",
        source: "Source: you · unknown",
        followUp: "Follow-up: I will ask again once there is more to go on.",
      };
    case "skipped":
      return {
        kind,
        flag: "NOT PROVIDED",
        ref,
        value: "Not provided",
        source: "Source: you · skipped",
        followUp: "Follow-up: I will return to this question.",
      };
    case "reopened":
      return {
        kind,
        flag: "REOPENED",
        ref,
        value: "Reopened",
        source: "Source: you · reopened",
        followUp: null,
      };
    case "estimate":
      return {
        kind,
        flag: "ESTIMATE",
        ref,
        value: chip.display,
        source: `Source: ${source} · estimate`,
        followUp: null,
      };
    case "stated":
      return {
        kind,
        flag: "RECORDED",
        ref,
        value: chip.display,
        source: `Source: ${source} · stated`,
        followUp: null,
      };
  }
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * The whole-record line for the top bar: "6 core facts on record · 6 core
 * questions open". core_done counts answers AND recorded gaps — a gap is
 * a finding, so it is on record too.
 */
export function recordSummary(progress: IntakeProgress): string {
  const done = progress.core_done;
  const open = Math.max(0, progress.core_total - progress.core_done);
  const recorded = `${done} core ${plural(done, "fact", "facts")} on record`;
  if (open === 0) return `${recorded} · no core questions open`;
  return `${recorded} · ${open} core ${plural(open, "question", "questions")} open`;
}

export interface SessionTally {
  recorded: number;
  gaps: number;
  notProvided: number;
}

/** What this session's record column holds, by kind. */
export function sessionTally(chips: readonly IntakeChip[]): SessionTally {
  const tally: SessionTally = { recorded: 0, gaps: 0, notProvided: 0 };
  for (const chip of chips) {
    const { kind } = parseProvenance(chip.provenance);
    if (kind === "unknown") tally.gaps += 1;
    else if (kind === "skipped") tally.notProvided += 1;
    else if (kind === "stated" || kind === "estimate") tally.recorded += 1;
  }
  return tally;
}

/** "4 recorded · 1 gap · 1 not provided" — zero parts are left out. */
export function tallyText(t: SessionTally): string {
  const parts = [`${t.recorded} recorded`];
  if (t.gaps > 0) parts.push(`${t.gaps} ${plural(t.gaps, "gap", "gaps")}`);
  if (t.notProvided > 0) parts.push(`${t.notProvided} not provided`);
  return parts.join(" · ");
}

/**
 * Where a key submits, say so in words (no glyphs): the control type
 * decides the key, not the question's content.
 */
export function keyHint(type: IntakeQuestion["input_type"], isMac: boolean): string | null {
  switch (type) {
    case "long_text":
      return `${isMac ? "Cmd" : "Ctrl"} + Enter to record`;
    case "text":
    case "number":
    case "money":
    case "date":
    case "entity_list":
      return "Enter to record";
    default:
      return null;
  }
}
