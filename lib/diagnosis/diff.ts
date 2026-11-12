// Re-diagnosis as a diff — the v1 build spec §6.4, §6.6 (P7-53).
//
// "Re-diagnosis produces a diff against the previous version, not a fresh
// document." Each report after the first carries what moved since the one
// before it: findings that are new, findings that went away (fixed, or no
// longer true), findings still open, the Diagnosis Grade's move, and the
// economics figures that changed — so the artifact has a version 2, 3, 4.
// Pure: two reports' frozen content in, the diff out.

import type { Grade } from "../core/grade";

export interface DiffableFinding {
  /** Stable across versions: the finding's own key, else its title. */
  key: string;
  title: string;
  severity: string;
}

export interface DiffableReport {
  id: string;
  generated_at: string;
  grade: Grade | null;
  findings: readonly DiffableFinding[];
  /** Named figures (economics), as display-free values: minor units or numbers. */
  figures: Readonly<Record<string, number | null>>;
}

export interface ReportDiff {
  from: { id: string; generated_at: string };
  version: number;
  grade: { from: Grade | null; to: Grade | null; moved: "up" | "down" | "same" };
  new_findings: DiffableFinding[];
  resolved_findings: DiffableFinding[];
  still_open: DiffableFinding[];
  changed_figures: { key: string; from: number | null; to: number | null }[];
}

const ORDER: readonly (Grade | null)[] = [null, "D", "C", "B", "A"];

export function diffReports(
  prev: DiffableReport,
  next: DiffableReport,
  version: number,
): ReportDiff {
  const before = new Map(prev.findings.map((f) => [f.key, f]));
  const after = new Map(next.findings.map((f) => [f.key, f]));
  const from = ORDER.indexOf(prev.grade);
  const to = ORDER.indexOf(next.grade);
  const keys = new Set([...Object.keys(prev.figures), ...Object.keys(next.figures)]);
  return {
    from: { id: prev.id, generated_at: prev.generated_at },
    version,
    grade: {
      from: prev.grade,
      to: next.grade,
      moved: to > from ? "up" : to < from ? "down" : "same",
    },
    new_findings: next.findings.filter((f) => !before.has(f.key)),
    resolved_findings: prev.findings.filter((f) => !after.has(f.key)),
    still_open: next.findings.filter((f) => before.has(f.key)),
    changed_figures: [...keys]
      .map((key) => ({ key, from: prev.figures[key] ?? null, to: next.figures[key] ?? null }))
      .filter((c) => c.from !== c.to),
  };
}
