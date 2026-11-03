// The history ledger's rows — pure, so the screen and its CSV export read
// the same lines (the owner's History design, 2026-10-17).
//
// Every line is a dated thing that happened, taken from the record: a
// proposal raised, the owner's decision, an execution, the measured
// verdict, a fact superseded. Nothing is generated and nothing is dated
// by guesswork — a line whose moment is only known to the day says so
// (time: null), and the measured verdict, which is arithmetic over the
// days measured so far, is dated "now" because that is when it was read.
//
// L-4a (TASKS-LANGUAGES.md): the ledger's own words — actors, notes,
// verdicts, "Judged on …", a fact's change line, the approval rate's
// arithmetic and the revenue readback's — come from the "ledgerWords"
// catalogue in the reader's language, English by default and word for word
// as before. A proposal's summary (its title), a limit's caption, a lapse's
// sentence and a decline's reason are stored as they were written and
// print as they are (rule 4).

import { intlMoney, intlNumber, dayMonthYear } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import { plainValue, readStored } from "../../lib/i18n/stored";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

export interface LedgerWords {
  /** A translator over "ledgerWords". */
  tr: Tr;
  locale: AppLocale;
}
const LW = (): LedgerWords => ({ tr: englishTr("ledgerWords"), locale: "en" });

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
  /** Review D #1: a lapsed approval carries {lapsed, at, sentence}. */
  execution_result?: unknown;
}

export interface LedgerOutcome {
  verdict: Verdict;
  /** P3-23b: what it was judged on; absent or "revenue" reads as before. */
  judged_on?: "revenue" | "post" | "campaign" | "email";
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

const clock = (ms: number, locale: AppLocale = "en") =>
  new Date(ms).toLocaleTimeString(locale === "en" ? "en-GB" : intlTag(locale), {
    hour: "2-digit",
    minute: "2-digit",
  });

/** The proposal's short reference: its module and the first block of its id. */
export const refOf = (p: Pick<LedgerProposal, "id" | "module">): string =>
  `${p.module} · ${p.id.slice(0, 8)}`;

const TONE: Record<Verdict, LedgerRow["tone"]> = {
  helped: "ok",
  did_nothing: "low",
  backfired: "alarm",
  too_early: "low",
  unmeasured: "low",
};

/** "you", "measured" or "SYB": who a fact's source makes its author (ledgerWords.actor). */
const SOURCE_ACTOR: Record<string, "you" | "measured" | "syb"> = {
  owner_input: "you",
  conversation: "you",
  connector: "measured",
  inferred: "syb",
  web_research: "syb",
  system_default: "syb",
};

/** A signed percent as the readback writes it ("+3.2", "-5"), the reader's way. */
function signedFigure(raw: string, locale: AppLocale): string {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!m) return raw;
  const body = intlNumber(Number(`${m[2]}.${m[3] ?? "0"}`), m[3]?.length ?? 0, locale);
  return `${m[1] === "-" ? "−" : m[1]}${body}`;
}

/**
 * Pure: a readback's arithmetic in the reader's language. The revenue
 * readback's own lines are read back (lib/trust/readback); the post, campaign
 * and email readbacks' lines print as written.
 */
export function arithmeticWords(text: string, w: LedgerWords = LW()): string {
  const { tr, locale } = w;
  if (locale === "en") return text;
  return readStored(
    text,
    "ledgerWords.arith",
    (k, v) => tr(`arith.${k}`, v),
    (name, raw) => {
      if (name === "day") return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? dayMonthYear(raw, locale) : raw;
      if (name === "after" || name === "before") {
        const m = /^(-?\d+\.\d{2}) ([A-Z]{3})$/.exec(raw);
        return m ? intlMoney(Number(m[1]), m[2]!, 2, locale) : raw;
      }
      if (name === "delta" || name === "helped" || name === "backfired")
        return signedFigure(raw, locale);
      return plainValue(name, raw);
    },
  );
}

/** Pure: the approval rate's arithmetic, from the scorecard's own counts. */
export function rateArithmetic(
  s: {
    rejected: number;
    expired: number;
    blocked: number;
    approval_rate: { numerator: number; denominator: number; value: number | null };
  },
  w: LedgerWords = LW(),
): string {
  const { tr, locale } = w;
  const r = s.approval_rate;
  if (r.denominator <= 0 || r.value === null) return tr("rate.none");
  const fig = (n: number, d = 0) => (locale === "en" ? String(n) : intlNumber(n, d, locale));
  return tr("rate.some", {
    approved: fig(r.numerator),
    concluded: fig(r.denominator),
    declined: fig(s.rejected),
    lapsed: fig(s.expired),
    withheld: fig(s.blocked),
    rate:
      locale === "en"
        ? String(r.value)
        : intlNumber(r.value, Number.isInteger(r.value) ? 0 : 1, locale),
  });
}

/** Every line one proposal has put on the record. */
export function proposalRows(
  p: LedgerProposal,
  outcome: LedgerOutcome | null,
  now: number,
  w: LedgerWords = LW(),
): LedgerRow[] {
  const { tr, locale } = w;
  const SYB = tr("actor.syb");
  const YOU = tr("actor.you");
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
      actor: SYB,
      note: tr("note.withheld"),
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
    actor: SYB,
    note: p.status === "pending" ? tr("note.waiting") : "",
    tone: null,
  });

  // Review 2026-10-23 (Session D #1): approved, then lapsed before it could
  // run — the approval stays on the record, and the lapse is SYB's.
  const lapse = p.execution_result as { lapsed?: unknown; at?: unknown; sentence?: unknown } | null;
  if (p.status === "expired" && p.decided_at && lapse?.lapsed === true) {
    rows.push({
      key: `${p.id}:approved`,
      kind: "approved",
      at: parseTs(p.decided_at),
      timed: true,
      title,
      ref,
      detail: null,
      actor: YOU,
      note: "",
      tone: null,
    });
    const at = typeof lapse.at === "string" ? parseTs(lapse.at) : null;
    if (at !== null) {
      rows.push({
        key: `${p.id}:expired`,
        kind: "expired",
        at,
        timed: true,
        title,
        ref,
        detail: typeof lapse.sentence === "string" ? lapse.sentence : null,
        actor: SYB,
        note: tr("note.lapsedApproved"),
        tone: null,
      });
    }
    return rows;
  }

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
        actor: tr("actor.noAnswer"),
        note: tr("note.lapsed"),
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
      actor: YOU,
      note:
        p.status === "approved" && runs !== null && runs > now
          ? tr("note.runs", { clock: clock(runs, locale) })
          : "",
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
      detail: p.rejection_reason ? tr("reason", { reason: p.rejection_reason }) : null,
      actor: YOU,
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
        actor: p.module === "hours" ? YOU : SYB,
        note: tr("note.done"),
        tone: null,
      });
    }
  }

  if (outcome && outcome.verdict !== "unmeasured") {
    const verdict = tr(`verdict.${outcome.verdict}`);
    const d = outcome.delta_pct;
    const delta =
      d === null
        ? null
        : locale === "en"
          ? `${d >= 0 ? "+" : ""}${d}`
          : signedFigure(`${d >= 0 ? "+" : ""}${d}`, locale);
    const arithmetic = arithmeticWords(outcome.arithmetic, w);
    rows.push({
      key: `${p.id}:measured`,
      kind: "measured",
      at: now,
      timed: true,
      title,
      ref,
      detail:
        outcome.judged_on && outcome.judged_on !== "revenue"
          ? tr("judgedOn.detail", { judged: tr(`judgedOn.${outcome.judged_on}`), arithmetic })
          : arithmetic,
      actor: SYB,
      note: delta === null ? verdict : tr("note.delta", { delta, verdict }),
      tone: TONE[outcome.verdict],
    });
  }

  return rows;
}

/** A structured value (a schedule, a list of objects) has no one-line form. */
const structured = (v: string | null) => v !== null && /^[[{]/.test(v.trim());

function changeTitle(f: LedgerFact, tr: Tr): string {
  if (structured(f.from) || structured(f.to)) return tr("change.updated", { label: f.label });
  if (f.from === f.to) return tr("change.same", { label: f.label });
  const notKnown = tr("change.notKnown");
  return tr("change.moved", { label: f.label, from: f.from ?? notKnown, to: f.to ?? notKnown });
}

export function factRow(f: LedgerFact, w: LedgerWords = LW()): LedgerRow {
  const { tr } = w;
  const actor = SOURCE_ACTOR[f.by];
  return {
    key: `fact:${f.id}`,
    kind: "superseded",
    at: parseTs(f.at),
    timed: true,
    title: changeTitle(f, tr),
    ref: tr("ref.fact", { id: f.id.slice(0, 8) }),
    detail: null,
    actor: actor ? tr(`actor.${actor}`) : f.by.replace(/_/g, " "),
    note: tr("note.kept"),
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

/** The CSV's columns, as exports.history in messages/<locale>.json names them. */
export const CSV_COLUMNS = ["when", "kind", "entry", "reference", "detail", "by", "note"] as const;

/**
 * The visible rows as CSV — what the owner sees, nothing more. L-6: the
 * header in the reader's language (`heading`, exports.history); the times
 * stay ISO 8601 and the kind its code, so the file stays machine-readable.
 */
export function toCsv(
  rows: readonly LedgerRow[],
  heading: (column: (typeof CSV_COLUMNS)[number]) => string = (c) => c,
): string {
  const head = CSV_COLUMNS.map((c) => cell(heading(c)));
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
