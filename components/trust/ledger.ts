// The history ledger's rows — pure, so the screen and its CSV export read
// the same lines (the owner's History design, 2026-10-17).
//
// Every line is a dated thing that happened, taken from the record: a
// proposal raised, the owner's decision, an execution, the measured
// verdict, a fact superseded. Nothing is generated and nothing is dated
// by guesswork — a line whose moment is only known to the day says so
// (time: null), and the measured verdict, which is arithmetic over the
// days measured so far, is dated "now" because that is when it was read.

export type LedgerKind =
  "proposed" | "withheld" | "approved" | "declined" | "expired" | "ran" | "measured" | "superseded";

export type LedgerFilter = "everything" | "decisions" | "ran" | "measured" | "facts";

export type Verdict = "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";

export interface LedgerProposal {
  id: string;
  status: string;
  module: string;
  created_at: string;
  decided_at: string | null;
  expires_at?: string | null;
  execute_not_before?: string | null;
  rejection_reason: string | null;
  blocked_by_limit: string | null;
  action: { summary: string };
}

export interface LedgerOutcome {
  verdict: Verdict;
  arithmetic: string;
  delta_pct: number | null;
  executed_on: string | null;
}

export interface LedgerFact {
  id: string;
  key: string;
  label: string;
  from: string | null;
  to: string | null;
  at: string;
  by: string;
}

export interface LedgerRow {
  key: string;
  kind: LedgerKind;
  /** Epoch ms, for ordering and grouping. */
  at: number;
  /** False when the record holds only the day. */
  timed: boolean;
  title: string;
  ref: string;
  /** Extra line under the title (a reason, the arithmetic). */
  detail: string | null;
  actor: string;
  note: string;
  /** Colour for the note when it is a verdict. */
  tone: "ok" | "drift" | "alarm" | "low" | null;
}

/** Postgres prints "2026-10-17 15:20:35.26+00"; make it ISO before parsing. */
export function parseTs(s: string): number {
  const iso = s
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(s) : ms;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** The proposal's short reference: its module and the first block of its id. */
export const refOf = (p: Pick<LedgerProposal, "id" | "module">): string =>
  `${p.module} · ${p.id.slice(0, 8)}`;

const VERDICT: Record<Verdict, { word: string; tone: LedgerRow["tone"] }> = {
  helped: { word: "helped", tone: "ok" },
  did_nothing: { word: "did nothing", tone: "low" },
  backfired: { word: "backfired", tone: "alarm" },
  too_early: { word: "too early to say", tone: "low" },
  unmeasured: { word: "unmeasured", tone: "low" },
};

const SOURCE_WORD: Record<string, string> = {
  owner_input: "you",
  conversation: "you",
  connector: "measured",
  inferred: "Ledgerline",
  web_research: "Ledgerline",
  system_default: "Ledgerline",
};

/** Every line one proposal has put on the record. */
export function proposalRows(
  p: LedgerProposal,
  outcome: LedgerOutcome | null,
  now: number,
): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const ref = refOf(p);
  const title = p.action.summary;
  const created = parseTs(p.created_at);

  if (p.status === "blocked") {
    rows.push({
      key: `${p.id}:withheld`,
      kind: "withheld",
      at: created,
      timed: true,
      title,
      ref,
      detail: p.blocked_by_limit ? p.blocked_by_limit.replace(/^13\.5:\s*/, "") : null,
      actor: "Ledgerline",
      note: "withheld by your limit",
      tone: null,
    });
    return rows;
  }

  rows.push({
    key: `${p.id}:proposed`,
    kind: "proposed",
    at: created,
    timed: true,
    title,
    ref,
    detail: null,
    actor: "Ledgerline",
    note: p.status === "pending" ? "waiting for you" : "",
    tone: null,
  });

  if (p.status === "expired") {
    const at = p.expires_at ? parseTs(p.expires_at) : p.decided_at ? parseTs(p.decided_at) : null;
    if (at !== null) {
      rows.push({
        key: `${p.id}:expired`,
        kind: "expired",
        at,
        timed: true,
        title,
        ref,
        detail: null,
        actor: "no answer",
        note: "lapsed · never ran",
        tone: null,
      });
    }
    return rows;
  }

  if (p.decided_at && (p.status === "approved" || p.status === "executed")) {
    const runs = p.execute_not_before ? parseTs(p.execute_not_before) : null;
    rows.push({
      key: `${p.id}:approved`,
      kind: "approved",
      at: parseTs(p.decided_at),
      timed: true,
      title,
      ref,
      detail: null,
      actor: "you",
      note: p.status === "approved" && runs !== null && runs > now ? `runs ${clock(runs)}` : "",
      tone: null,
    });
  }

  if (p.decided_at && p.status === "rejected") {
    rows.push({
      key: `${p.id}:declined`,
      kind: "declined",
      at: parseTs(p.decided_at),
      timed: true,
      title,
      ref,
      detail: p.rejection_reason ? `reason: ${p.rejection_reason}` : null,
      actor: "you",
      note: "",
      tone: null,
    });
  }

  if (p.status === "executed") {
    const on = outcome?.executed_on ?? null;
    const at = on ? parseTs(DAY_ONLY.test(on) ? `${on}T12:00:00Z` : on) : null;
    if (at !== null) {
      rows.push({
        key: `${p.id}:ran`,
        kind: "ran",
        at,
        timed: on !== null && !DAY_ONLY.test(on),
        title,
        ref,
        detail: null,
        actor: p.module === "hours" ? "you" : "Ledgerline",
        note: "done",
        tone: null,
      });
    }
  }

  if (outcome && outcome.verdict !== "unmeasured") {
    const v = VERDICT[outcome.verdict];
    const delta =
      outcome.delta_pct !== null
        ? `${outcome.delta_pct >= 0 ? "+" : ""}${outcome.delta_pct}% · `
        : "";
    rows.push({
      key: `${p.id}:measured`,
      kind: "measured",
      at: now,
      timed: true,
      title,
      ref,
      detail: outcome.arithmetic,
      actor: "Ledgerline",
      note: `${delta}${v.word}`,
      tone: v.tone,
    });
  }

  return rows;
}

/** A structured value (a schedule, a list of objects) has no one-line form. */
const structured = (v: string | null) => v !== null && /^[[{]/.test(v.trim());

function changeTitle(f: LedgerFact): string {
  if (structured(f.from) || structured(f.to)) return `${f.label}: updated`;
  if (f.from === f.to) return `${f.label}: re-recorded, same value`;
  return `${f.label}: ${f.from ?? "not known"} → ${f.to ?? "not known"}`;
}

export function factRow(f: LedgerFact): LedgerRow {
  return {
    key: `fact:${f.id}`,
    kind: "superseded",
    at: parseTs(f.at),
    timed: true,
    title: changeTitle(f),
    ref: `fact ${f.id.slice(0, 8)}`,
    detail: null,
    actor: SOURCE_WORD[f.by] ?? f.by.replace(/_/g, " "),
    note: "kept in record",
    tone: null,
  };
}

const IN_FILTER: Record<LedgerFilter, readonly LedgerKind[] | null> = {
  everything: null,
  decisions: ["proposed", "withheld", "approved", "declined", "expired"],
  ran: ["ran"],
  measured: ["measured"],
  facts: ["superseded"],
};

/** Newest first, narrowed to one tab. */
export function filterRows(rows: readonly LedgerRow[], filter: LedgerFilter): LedgerRow[] {
  const kinds = IN_FILTER[filter];
  return rows.filter((r) => kinds === null || kinds.includes(r.kind)).sort((a, b) => b.at - a.at);
}

/** Rows grouped by local calendar day, newest day first. */
export function byDay(
  rows: readonly LedgerRow[],
): { day: string; at: number; rows: LedgerRow[] }[] {
  const groups: { day: string; at: number; rows: LedgerRow[] }[] = [];
  for (const r of rows) {
    const d = new Date(r.at);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else groups.push({ day, at: r.at, rows: [r] });
  }
  return groups;
}

const cell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The visible rows as CSV — what the owner sees, nothing more. */
export function toCsv(rows: readonly LedgerRow[]): string {
  const head = ["when", "kind", "entry", "reference", "detail", "by", "note"];
  const lines = rows.map((r) =>
    [
      r.timed ? new Date(r.at).toISOString() : new Date(r.at).toISOString().slice(0, 10),
      r.kind,
      r.title,
      r.ref,
      r.detail ?? "",
      r.actor,
      r.note,
    ]
      .map(cell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n");
}
