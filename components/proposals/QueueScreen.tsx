"use client";

// The approval queue — Phase 3 Session A (P3-05/07), redrawn to the
// owner's desktop and mobile designs (2026-10-17) on ux-spec §2 + §8.
//
// A focused view (components/nav/AppFrame.tsx shows no rail here): its
// own ink masthead — the wordmark back to /watch, "<business> ·
// Decisions", this month's review stats when real decisions support
// them, and the emergency stop (rule 15) — over a cobalt rule.
//
// Desktop: a list of what needs a decision on the desk, and one proposal
// sheet beside it, read top to bottom in the design's order: the change
// before → after, the expected effect as a range on an axis (never a
// point), the evidence with source and basis, whether it can be undone,
// then three equal answers — Approve, Request changes, Decline — with
// their keys. J / K move; A / R / D answer; never while typing.
//
// Mobile (≤600px): one proposal at a time, the primary button stating
// the consequence, Decline and Later (Later moves on without deciding).
//
// After a decision the proposal stays in the list where it was, as a
// stamp ("APPROVED 14:02 · ref …"), announced politely, and the sheet
// advances to the next one. Nothing here executes anything (rule 12):
// it records a human answer; the engine acts only on approved rows.
//
// Everything printed comes from the proposal's own data
// (components/proposals/queue-model.ts). The design's recommendation
// box, per-line INCLUDED toggles and forecast track record have no data
// behind them yet, so they are not drawn.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { EmergencyStop } from "../execution/EmergencyStop";
import { RangeBar } from "../sheet/RangeBar";
import { moneyText } from "../sheet/num";
import type { BasisInput } from "../report/basis";
import {
  REASON_CHIPS,
  type Decision,
  type ReasonChip,
  type Stamp,
  activeChip,
  applyReasonChip,
  approvalNote,
  changeLines,
  clockWord,
  consequence,
  dayWord,
  durationWord,
  effectRange,
  evidenceLines,
  executeNotBefore,
  isSameDay,
  isTypingTarget,
  moveFocus,
  nextAfterDecision,
  originWord,
  rangeAxis,
  reversibilityLabel,
  reviewStats,
  shortRef,
  shortReversibility,
  signedMoney,
  stampText,
  lapsedSentence,
} from "./queue-model";
import "../../app/queue.css";

interface Money {
  amount_minor: number;
  currency: string;
}

interface Assumption {
  statement: string;
  source_field?: string | null;
  sensitivity: "high" | "medium" | "low";
}

interface Outcome {
  statement: string;
  profit_delta_monthly?: Money | null;
  formula?: string | null;
}

interface Proposal {
  id: string;
  module: string;
  status: string;
  originating_finding: string | null;
  action: {
    kind: string;
    summary: string;
    detail?: {
      rationale?: string;
      manual_limits?: string[];
      publish_at?: string;
      /** P3-22b: approving without a time queues it for the next run (the ad changes). */
      execute_on_approval?: boolean;
      sending?: string;
      [k: string]: unknown;
    };
  };
  scenario: {
    assumptions: Assumption[];
    base_case?: Outcome;
    downside_case?: Outcome;
    upside_case?: Outcome;
    breakeven_condition: string;
  };
  reversibility: { level: string; if_you_change_your_mind: string } | null;
  blocked_by_limit: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  rejection_reason: string | null;
  change_request?: string | null;
  execute_not_before: string | null;
  /** Review D #1: an approval that lapsed carries {lapsed, at, sentence} here. */
  execution_result?: unknown;
}

interface Disagreement {
  finding_id: string;
  field_keys: string[];
  message: string;
}

interface Queue {
  pending: Proposal[];
  blocked: Proposal[];
  decided: Proposal[];
  expired: Proposal[];
  business?: string | null;
  facts?: Record<string, BasisInput>;
  disagreements?: Disagreement[];
}

interface DecideResult {
  decided?: string[];
  failed?: { id: string; error: string }[];
  error?: string;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "ready"; queue: Queue; busy: boolean; notice: string | null };

type ScheduleKey = "now" | "tomorrow" | "next_week";
type ApiDecision = "approve" | "reject" | "request_changes";
type Panel = "decline" | "changes";
const BULK = "__bulk__";

const DECISION_OF: Record<ApiDecision, Decision> = {
  approve: "approved",
  reject: "rejected",
  request_changes: "changes_requested",
};

const HISTORY_WORD: Record<string, string> = {
  approved: "APPROVED",
  executed: "EXECUTED",
  rejected: "DECLINED",
  changes_requested: "CHANGES REQUESTED",
  expired: "EXPIRED",
};

function scheduleOptions(
  publishAt: string | undefined,
  onApproval = false,
): { key: ScheduleKey; label: string }[] {
  const planned =
    publishAt && !Number.isNaN(Date.parse(publishAt))
      ? `at its planned time, ${dayWord(publishAt)} ${clockWord(publishAt)}`
      : onApproval
        ? "on the next run after you approve"
        : "with no set time";
  return [
    { key: "now", label: planned },
    { key: "tomorrow", label: "no earlier than tomorrow" },
    { key: "next_week", label: "no earlier than next week" },
  ];
}

/** The execute_not_before an approval would carry: the owner's pick, else the planned time. */
function runAtFor(p: Proposal, key: ScheduleKey, nowMs: number): string | null {
  const picked = executeNotBefore(key, nowMs);
  if (picked) return picked;
  const at = p.action.detail?.publish_at;
  if (typeof at === "string" && !Number.isNaN(Date.parse(at))) return at;
  // P3-22b: the server schedules these for the moment of approval (carriedSchedule).
  return p.action.detail?.execute_on_approval === true ? new Date(nowMs).toISOString() : null;
}

async function fetchQueue(): Promise<Queue | "signedout"> {
  const res = await fetch("/api/proposals");
  if (res.status === 401) return "signedout";
  return (await res.json()) as Queue;
}

/* ── the phone layout switch: ≤600px, read on the client only ── */

const NARROW = "(max-width: 600px)";
function subscribeNarrow(cb: () => void) {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

const moduleWord = (m: string) => m.replace(/_/g, " ");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function historyStamp(p: Proposal): string {
  const word = HISTORY_WORD[p.status] ?? p.status.toUpperCase();
  const at = p.decided_at ? ` ${clockWord(p.decided_at)}` : "";
  return `${word}${at} · ref ${shortRef(p.id)}`;
}

function effectOf(p: Proposal) {
  return effectRange(p.scenario.downside_case, p.scenario.upside_case);
}

export function QueueScreen() {
  const narrow = useNarrow();
  const [state, setState] = useState<State>({ phase: "loading" });
  // Per proposal, keyed by id (and BULK for the bulk sheet): one sheet's
  // choice never leaks into another's.
  const [schedules, setSchedules] = useState<Record<string, ScheduleKey>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [panels, setPanels] = useState<Record<string, Panel>>({});
  const [needs, setNeeds] = useState<Record<string, "reason" | "changes" | "schedule">>({});
  const [stamps, setStamps] = useState<Record<string, Stamp>>({});
  const [evidenceOpen, setEvidenceOpen] = useState<Record<string, boolean>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const [halted, setHalted] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkSchedule, setBulkSchedule] = useState<ScheduleKey | "">("");

  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const emptyRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    void fetchQueue().then((q) => {
      if (!live) return;
      setState(
        q === "signedout"
          ? { phase: "signedout" }
          : { phase: "ready", queue: q, busy: false, notice: null },
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const queue = state.phase === "ready" ? state.queue : null;

  // The list: everything pending, plus what was decided here this visit
  // (kept in place as a stamp). Server order — newest first — so a
  // decided row never jumps.
  const listed = useMemo(() => {
    if (!queue) return [];
    const stamped = queue.decided.filter((p) => stamps[p.id]);
    return [...queue.pending, ...stamped].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [queue, stamps]);
  const pendingIds = useMemo(
    () => listed.filter((p) => !stamps[p.id]).map((p) => p.id),
    [listed, stamps],
  );
  const current = currentId && pendingIds.includes(currentId) ? currentId : (pendingIds[0] ?? null);

  const focusItem = useCallback((id: string) => {
    const el = itemRefs.current.get(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", behavior: "instant" });
  }, []);

  // Approve-and-advance: once the reloaded queue has rendered, move focus.
  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget === "__empty__") emptyRef.current?.focus({ preventScroll: false });
    else focusItem(focusTarget);
    setFocusTarget(null);
  }, [focusTarget, focusItem, listed]);

  const onHaltState = useCallback((h: boolean) => setHalted(h), []);

  const setNeed = (key: string, need: "reason" | "changes" | "schedule" | null) =>
    setNeeds((cur) => {
      const next = { ...cur };
      if (need) next[key] = need;
      else delete next[key];
      return next;
    });
  const openPanel = (key: string, panel: Panel | null) =>
    setPanels((cur) => {
      const next = { ...cur };
      if (panel) next[key] = panel;
      else delete next[key];
      return next;
    });

  const decide = async (
    ids: string[],
    decision: ApiDecision,
    opts: { reason?: string; changes?: string; executeNotBefore?: string | null; bulk?: boolean },
  ) => {
    if (ids.length === 0 || state.phase !== "ready") return;
    const ready = state;
    setState({ ...ready, busy: true, notice: null });
    const res = await fetch("/api/proposals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids,
        decision,
        ...(decision === "reject" ? { reason: opts.reason } : {}),
        ...(decision === "request_changes" ? { changes: opts.changes } : {}),
        ...(decision === "approve" && opts.executeNotBefore
          ? { execute_not_before: opts.executeNotBefore }
          : {}),
      }),
    });
    const clientAt = new Date().toISOString();
    const j = (await res.json().catch(() => ({}))) as DecideResult;
    if (res.status === 401 || res.status === 422 || (!res.ok && !j.decided)) {
      setState({ ...ready, busy: false, notice: j.error ?? "that decision wasn't recorded" });
      return;
    }
    const decided = j.decided ?? [];
    const failed = j.failed ?? [];

    const fresh = await fetchQueue();
    if (fresh === "signedout") return setState({ phase: "signedout" });

    const verdict = DECISION_OF[decision];
    const newStamps: Record<string, Stamp> = {};
    for (const id of decided) {
      const row = fresh.decided.find((p) => p.id === id);
      newStamps[id] = row?.decided_at
        ? { decision: verdict, at: row.decided_at, clientTime: false }
        : { decision: verdict, at: clientAt, clientTime: true };
    }
    const order = listed.map((p) => p.id);
    const stillPending = new Set(fresh.pending.map((p) => p.id));
    // Advance past what was recorded; if nothing was, stay on what was tried.
    const next =
      decided.length === 0
        ? (ids.find((id) => stillPending.has(id)) ?? fresh.pending[0]?.id ?? null)
        : (nextAfterDecision(order, decided, stillPending) ?? fresh.pending[0]?.id ?? null);

    setStamps((cur) => ({ ...cur, ...newStamps }));
    setPicked((cur) => new Set([...cur].filter((id) => stillPending.has(id))));
    setNeeds({});
    for (const id of decided) openPanel(id, null);
    if (opts.bulk) {
      // A bulk answer is stated afresh every time — nothing carries over.
      setBulkSchedule("");
      setReasons((cur) => ({ ...cur, [BULK]: "" }));
      openPanel(BULK, null);
    }
    setCurrentId(next);
    setFocusTarget(next ?? "__empty__");

    const failNote =
      failed.length > 0
        ? `${failed.length} not recorded: ${failed.map((f) => f.error).join("; ")}.`
        : null;
    setState({ phase: "ready", queue: fresh, busy: false, notice: failNote });

    const first = decided[0];
    const firstStamp = first ? newStamps[first] : undefined;
    const said =
      first && firstStamp
        ? decided.length === 1
          ? stampText(first, firstStamp)
          : `${decided.length} proposals ${verdict === "approved" ? "approved" : "declined"}`
        : "Nothing was recorded";
    const nextTitle = next ? fresh.pending.find((p) => p.id === next)?.action.summary : null;
    setAnnounce(
      `${said}.${failNote ? ` ${failNote}` : ""}${nextTitle ? ` Next: ${nextTitle}` : " Nothing else needs a decision."}`,
    );
  };

  /** Decline is one action: with a reason it records; without, it opens the reasons. */
  const declineFor = (key: string, ids: string[]) => {
    const reason = (reasons[key] ?? "").trim();
    if (reason === "") {
      openPanel(key, "decline");
      setNeed(key, panels[key] === "decline" ? "reason" : null);
      requestAnimationFrame(() => document.getElementById(`chip0-${key}`)?.focus());
      return;
    }
    void decide(ids, "reject", { reason, bulk: key === BULK });
  };

  /** Request changes: with words it records; without, it opens the box for them. */
  const changesFor = (id: string) => {
    const words = (changes[id] ?? "").trim();
    if (words === "") {
      openPanel(id, "changes");
      setNeed(id, panels[id] === "changes" ? "changes" : null);
      requestAnimationFrame(() => document.getElementById(`changes-${id}`)?.focus());
      return;
    }
    void decide([id], "request_changes", { changes: words });
  };

  const approveFor = (p: Proposal) =>
    void decide([p.id], "approve", {
      executeNotBefore: executeNotBefore(schedules[p.id] ?? "now", Date.now()),
    });

  const later = () => {
    if (!current || pendingIds.length < 2) return;
    const i = pendingIds.indexOf(current);
    const next = pendingIds[(i + 1) % pendingIds.length] ?? null;
    setCurrentId(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  };

  // Keys: J / K move, A / R / D answer the open proposal. Never while
  // typing in a field, never with a modifier, never in bulk mode.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    keyHandler.current = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      if (state.phase !== "ready" || state.busy) return;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        const next = moveFocus(pendingIds, current, k === "j" ? 1 : -1);
        if (!next) return;
        e.preventDefault();
        setCurrentId(next);
        focusItem(next);
        return;
      }
      if (bulk || !current) return;
      const p = state.queue.pending.find((x) => x.id === current);
      if (!p) return;
      if (k === "a") {
        e.preventDefault();
        approveFor(p);
      } else if (k === "r") {
        e.preventDefault();
        changesFor(p.id);
      } else if (k === "d") {
        e.preventDefault();
        declineFor(p.id, [p.id]);
      }
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (state.phase === "loading") {
    return (
      <div className="q-app">
        <p className="q-loading">Reading the queue…</p>
      </div>
    );
  }

  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">proposals</span>
            <h1 className="auth-title">Sign in to decide.</h1>
            <p className="auth-copy">
              Approving or declining a proposal is recorded with your name on it — that needs you
              signed in, not just this browser.
            </p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/login">
              Sign in
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const { busy, notice } = state;
  const q = state.queue;
  const now = new Date();
  const stats = reviewStats(q.decided, now);
  const facts = q.facts ?? {};
  const open = current ? (q.pending.find((p) => p.id === current) ?? null) : null;
  const decidedToday = q.decided.filter(
    (p) => !stamps[p.id] && p.decided_at && isSameDay(p.decided_at, now),
  );
  const earlier = [
    ...q.decided.filter((p) => !stamps[p.id] && !(p.decided_at && isSameDay(p.decided_at, now))),
    ...q.expired,
  ];

  const generate = async () => {
    setState({ ...state, busy: true });
    await fetch("/api/proposals", { method: "POST" });
    const fresh = await fetchQueue();
    if (fresh === "signedout") return setState({ phase: "signedout" });
    setState({ phase: "ready", queue: fresh, busy: false, notice: null });
  };

  /* ── shared pieces ── */

  const reasonBox = (key: string, count: number) => {
    const reason = reasons[key] ?? "";
    const chip = activeChip(reason);
    const setReason = (v: string) => {
      setReasons((cur) => ({ ...cur, [key]: v }));
      if (v.trim() !== "" && needs[key] === "reason") setNeed(key, null);
    };
    return (
      <div className="q-panel">
        <p className="q-panel-label" id={`why-${key}`}>
          Why not{count > 1 ? `, for all ${count}` : ""}? One tap is enough
        </p>
        <div className="q-chips" role="group" aria-labelledby={`why-${key}`}>
          {REASON_CHIPS.map((c: ReasonChip, i) => (
            <button
              key={c}
              id={i === 0 ? `chip0-${key}` : undefined}
              type="button"
              className="q-chip"
              aria-pressed={chip === c}
              onClick={() => setReason(applyReasonChip(reason, c))}
            >
              {c}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor={`reason-${key}`}>
          Your reason, in your words
        </label>
        <textarea
          id={`reason-${key}`}
          className="q-text"
          placeholder="Or say it in a sentence — I learn from it."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {needs[key] === "reason" && (
          <p className="q-need" role="alert">
            Pick a reason first — declining asks why, and the record keeps your answer.
          </p>
        )}
        <p className="q-panel-foot">
          Declining: nothing runs and nothing changes. I record it with your reason and don&rsquo;t
          act on it.
        </p>
        <button
          type="button"
          className="q-btn q-btn-inline"
          disabled={busy || reason.trim() === ""}
          onClick={() => (key === BULK ? declineFor(BULK, [...picked]) : declineFor(key, [key]))}
        >
          Record the decline{count > 1 ? ` for ${count}` : ""} <span aria-hidden="true">→</span>
        </button>
      </div>
    );
  };

  const changesBox = (id: string) => {
    const words = changes[id] ?? "";
    return (
      <div className="q-panel">
        <label className="q-panel-label" htmlFor={`changes-${id}`}>
          What should be different?
        </label>
        <textarea
          id={`changes-${id}`}
          className="q-text"
          placeholder="e.g. only last year's customers, and no discount."
          value={words}
          onChange={(e) => {
            setChanges((cur) => ({ ...cur, [id]: e.target.value }));
            if (e.target.value.trim() !== "" && needs[id] === "changes") setNeed(id, null);
          }}
        />
        {needs[id] === "changes" && (
          <p className="q-need" role="alert">
            Say what should change first — the record keeps your words.
          </p>
        )}
        <p className="q-panel-foot">
          Not approved, and not a no: nothing runs. Your words go on the record with your name. A
          redraft isn&rsquo;t automatic yet.
        </p>
        <button
          type="button"
          className="q-btn q-btn-inline"
          disabled={busy || words.trim() === ""}
          onClick={() => changesFor(id)}
        >
          Record the request <span aria-hidden="true">→</span>
        </button>
      </div>
    );
  };

  const changeBlock = (p: Proposal, compact: boolean) => {
    const lines = changeLines(p.action);
    if (!lines) {
      return (
        <p className="q-nolines">
          This proposal states no before and after. The change, in its own words: “
          {p.action.summary}”.
        </p>
      );
    }
    if (compact) {
      return (
        <dl className="q-mlines">
          {lines.map((l) => (
            <div key={l.line} className="q-mline">
              <dt>{l.line}</dt>
              <dd className="fig">
                {l.before} <span aria-hidden="true">→</span>
                <span className="sr-only"> becomes </span> {l.after}
              </dd>
            </div>
          ))}
        </dl>
      );
    }
    return (
      <table className="rt q-lines">
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.line}>
              <th scope="row">
                {l.line}
                {l.sub && <span className="q-line-sub">{l.sub}</span>}
              </th>
              <td className="q-before">{l.before}</td>
              <td className="q-after">
                <span aria-hidden="true">→ </span>
                {l.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const effectBlock = (p: Proposal, compact: boolean) => {
    const range = effectOf(p);
    const base = p.scenario.base_case;
    if (range) {
      const axis = rangeAxis(range.low.amount_minor, range.high.amount_minor);
      const cur = range.low.currency;
      return (
        <div className={compact ? "q-effect q-effect-m" : "q-effect"}>
          <div className="q-effect-fig">
            <p className="q-fig fig">
              {signedMoney(range.low)} – {signedMoney(range.high)}
            </p>
            <p className="q-mono-note">
              profit a month, downside to upside
              {!compact && base?.statement ? ` · likeliest: ${base.statement}` : ""}
            </p>
          </div>
          <div className="q-axis">
            <RangeBar
              scale={axis.scale}
              value={null}
              band={[range.low.amount_minor, range.high.amount_minor]}
            />
            {!compact && (
              <div className="q-ticks" aria-hidden="true">
                {axis.ticks.map((t) => (
                  <span key={t}>{moneyText(t, cur)}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    if (compact) {
      return (
        <p className="q-effect-words">
          {base?.statement ?? "No money effect was forecast for this one."}
        </p>
      );
    }
    const cases = (
      [
        ["downside", p.scenario.downside_case],
        ["likeliest", p.scenario.base_case],
        ["upside", p.scenario.upside_case],
      ] as const
    ).flatMap(([name, c]) => (c?.statement ? [{ name, c }] : []));
    return (
      <div className="q-effect-none">
        <p className="q-mono-note">
          No money range was forecast for this one — the cases, in words:
        </p>
        <dl className="q-cases">
          {cases.map(({ name, c }) => (
            <div key={name} className="q-case">
              <dt>{name}</dt>
              <dd>
                {c.statement}
                {c.formula && <span className="q-formula">worked out as {c.formula}</span>}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  };

  const evidenceBlock = (p: Proposal) => {
    const lines = evidenceLines(p.scenario.assumptions, facts);
    const keys = new Set(
      p.scenario.assumptions.flatMap((a) => (a.source_field ? [a.source_field] : [])),
    );
    const disagree = (q.disagreements ?? []).filter((d) => d.field_keys.some((k) => keys.has(k)));
    const manual = p.action.detail?.manual_limits ?? [];
    return (
      <>
        {lines.length === 0 ? (
          <p className="q-nolines">This proposal lists no assumptions.</p>
        ) : (
          <ul className="q-evidence">
            {lines.map((l, i) => (
              <li key={`${i}-${l.statement}`}>
                <span className="q-ev-text">
                  {l.statement}
                  {l.leansHard && (
                    <span className="q-leans">the conclusion leans hard on this</span>
                  )}
                </span>
                <span className="q-ev-src">
                  {l.source} · <b>{l.basis}</b>
                </span>
              </li>
            ))}
          </ul>
        )}
        {disagree.map((d) => (
          <p key={d.finding_id} className="q-disagree">
            <span className="q-disagree-word">{d.field_keys.length} sources disagree</span>{" "}
            {d.message}
          </p>
        ))}
        <p className="q-breakeven">
          <span className="q-mono-label">Breakeven</span> {p.scenario.breakeven_condition}
        </p>
        {manual.length > 0 && (
          <p className="q-manual">
            You told me: “{manual.join("” · “")}” — weigh this against that yourself; I can&rsquo;t
            check it for you.
          </p>
        )}
      </>
    );
  };

  const header = (
    <header className="q-mast">
      <div className="q-mast-left">
        <Link href="/watch" className="q-wordmark">
          Ledgerline
        </Link>
        <span className="q-mast-meta">{q.business ? `${q.business} · ` : ""}Decisions</span>
      </div>
      <div className="q-mast-right">
        {stats && (
          <span className="q-mast-stats">
            Median time from draft to decision this month: {durationWord(stats.medianMs)} · approved{" "}
            {stats.approved} of {stats.decided}
          </span>
        )}
        <EmergencyStop variant="masthead" onState={onHaltState} />
      </div>
    </header>
  );

  const live = (
    <p className="sr-only" role="status" aria-live="polite">
      {announce}
    </p>
  );

  const noticeBox = notice && (
    <p className="q-notice" role="alert">
      {notice}
    </p>
  );

  const emptySheet = (
    <section className="q-sheet q-empty">
      <h1 className="q-title" tabIndex={-1} ref={emptyRef}>
        Nothing needs a decision.
      </h1>
      <p className="q-prose">
        Proposals come from your latest diagnosis report, from changes the watching loop spots in
        your numbers, from goals that slip, from ad and content reviews, and from things you ask for
        in chat. Each one lands here first — what will happen, what it rests on, and what declining
        means. Nothing runs without your yes.
      </p>
      <button
        type="button"
        className="q-btn q-btn-inline"
        disabled={busy}
        onClick={() => void generate()}
      >
        Check the latest report for proposals <span aria-hidden="true">→</span>
      </button>
    </section>
  );

  const heldBack = q.blocked.length > 0 && (
    <section className="q-side-sec" aria-labelledby="q-held">
      <h2 className="q-side-label" id="q-held">
        Held back on your instruction · {q.blocked.length}
      </h2>
      <ul className="q-side-list">
        {q.blocked.map((p) => (
          <li key={p.id}>
            <p className="q-side-stamp">HELD BACK · will not be proposed</p>
            <p className="q-side-title">{p.action.summary}</p>
            <p className="q-side-note">
              I wrote this up and then blocked it myself — you said “
              {p.blocked_by_limit?.replace(/^13\.5:\s*/, "")}”.
            </p>
          </li>
        ))}
      </ul>
    </section>
  );

  /* ── mobile pieces ── */

  const stampedNotes = () => {
    const mine = listed.filter((p) => stamps[p.id]);
    if (mine.length === 0) return null;
    return (
      <ul className="q-m-stamps">
        {mine.map((p) => {
          const st = stamps[p.id] as Stamp;
          return (
            <li key={p.id}>
              <span className="q-stamp-word">{stampText(p.id, st)}</span> {p.action.summary}
            </li>
          );
        })}
      </ul>
    );
  };

  const mobileCard = (p: Proposal) => {
    const rev = reversibilityLabel(p.reversibility);
    const lines = evidenceLines(p.scenario.assumptions, facts);
    const shown = evidenceOpen[p.id] === true;
    const range = effectOf(p);
    const runAt = runAtFor(p, schedules[p.id] ?? "now", Date.now());
    const titleId = `mt-${p.id}`;
    return (
      <article className="q-sheet q-mcard" aria-labelledby={titleId}>
        <header className="q-mcard-head">
          <p className="q-ref">
            {shortRef(p.id)} · {moduleWord(p.module)}
          </p>
          <h2 id={titleId} className="q-title">
            {p.action.summary}
          </h2>
        </header>
        <section className="q-msec">
          <h3 className="q-mlabel">What changes</h3>
          {changeBlock(p, true)}
        </section>
        <section className="q-msec">
          <h3 className="q-mlabel">Expected{range ? ", a month" : ""} · estimated</h3>
          {effectBlock(p, true)}
        </section>
        <section className="q-msec">
          <div className="q-rev-row">
            <span className={`word boxed q-revword${rev.reversible ? "" : " q-irrev"}`}>
              {rev.reversible ? "REVERSIBLE" : "IRREVERSIBLE"}
            </span>
            <span className="q-rev-note">{rev.note}</span>
          </div>
          <button
            type="button"
            className="q-evtoggle"
            aria-expanded={shown}
            aria-controls={`ev-${p.id}`}
            onClick={() => setEvidenceOpen((cur) => ({ ...cur, [p.id]: !shown }))}
          >
            Full evidence · {lines.length} line{lines.length === 1 ? "" : "s"}{" "}
            <span aria-hidden="true">{shown ? "↑" : "→"}</span>
          </button>
          {shown && (
            <div id={`ev-${p.id}`} className="q-mev">
              {evidenceBlock(p)}
            </div>
          )}
        </section>
        <section className="q-mdecide" aria-label="Your decision">
          <button
            type="button"
            className="q-btn q-primary"
            disabled={busy}
            onClick={() => approveFor(p)}
          >
            <span>{consequence(p.action)}</span> <span aria-hidden="true">→</span>
          </button>
          <div className="q-mpair">
            <button
              type="button"
              className="q-btn"
              disabled={busy}
              onClick={() => declineFor(p.id, [p.id])}
            >
              Decline
            </button>
            <button
              type="button"
              className="q-btn"
              disabled={busy || pendingIds.length < 2}
              onClick={later}
            >
              Later
            </button>
          </div>
          <button
            type="button"
            className="q-quiet"
            disabled={busy}
            onClick={() => changesFor(p.id)}
          >
            Request changes instead
          </button>
          {panels[p.id] === "decline" && reasonBox(p.id, 1)}
          {panels[p.id] === "changes" && changesBox(p.id)}
          <p className="q-approve-note">
            {approvalNote({ runAt, sending: p.action.detail?.sending })}
            {halted && " Everything is stopped right now: nothing runs until you start again."}
          </p>
        </section>
      </article>
    );
  };

  /* ── mobile: one proposal at a time ── */

  if (narrow) {
    const idx = open ? pendingIds.indexOf(open.id) : -1;
    const nextId =
      idx >= 0 && pendingIds.length > 1 ? pendingIds[(idx + 1) % pendingIds.length] : null;
    const nextP = nextId ? q.pending.find((p) => p.id === nextId) : null;
    return (
      <div className="q-app q-m">
        <header className="q-mast q-mast-m">
          <div className="q-mast-row">
            <Link href="/watch" className="q-wordmark">
              Ledgerline
            </Link>
            {q.business && <span className="q-mast-meta">{q.business}</span>}
          </div>
          <div className="q-mast-row q-mast-big">
            <h1 className="q-waiting">
              {q.pending.length === 0
                ? "Nothing waiting"
                : `${q.pending.length} decision${q.pending.length === 1 ? "" : "s"} waiting`}
            </h1>
            {open && (
              <p className="q-pos">
                {idx + 1} of {pendingIds.length}
                {nextP ? ` · next: ${clip(nextP.action.summary, 34)}` : ""}
              </p>
            )}
          </div>
          <div className="q-mast-row">
            <EmergencyStop variant="masthead" onState={onHaltState} />
          </div>
        </header>
        {live}
        <main className="q-m-main">
          {noticeBox}
          {stampedNotes()}
          {open ? mobileCard(open) : emptySheet}
          <p className="q-m-foot">Nothing runs until you approve it.</p>
          {heldBack}
        </main>
      </div>
    );
  }

  /* ── desktop: the list and the sheet ── */

  const sheet = (p: Proposal) => {
    const rev = reversibilityLabel(p.reversibility);
    const titleId = `t-${p.id}`;
    const origin = originWord(p.originating_finding);
    const range = effectOf(p);
    const schedule = schedules[p.id] ?? "now";
    const runAt = runAtFor(p, schedule, Date.now());
    const verb = consequence(p.action);
    const sameDay = isSameDay(p.created_at, now);
    return (
      <article className="q-sheet" aria-labelledby={titleId} key={p.id}>
        <header className="q-sheet-head">
          <p className="q-ref">
            Proposal {shortRef(p.id)} · drafted{" "}
            {sameDay
              ? clockWord(p.created_at)
              : `${dayWord(p.created_at)} ${clockWord(p.created_at)}`}
            {origin ? ` · from ${origin}` : ""}
          </p>
          <h1 id={titleId} className="q-title">
            {p.action.summary}
          </h1>
          <p className="q-deadline">
            Decide by {dayWord(p.expires_at)}. Unanswered by then, it expires: not approved —
            nothing ran.
          </p>
        </header>

        <section className="q-sec" aria-labelledby={`s1-${p.id}`}>
          <h2 className="q-h" id={`s1-${p.id}`}>
            1 · What changes — before → after
          </h2>
          {changeBlock(p, false)}
          {p.action.detail?.rationale && <p className="q-prose">{p.action.detail.rationale}</p>}
        </section>

        <section className="q-sec" aria-labelledby={`s2-${p.id}`}>
          <h2 className="q-h" id={`s2-${p.id}`}>
            2 · Expected effect{range ? ", a month" : ""} · estimated
          </h2>
          {effectBlock(p, false)}
        </section>

        <section className="q-sec" aria-labelledby={`s3-${p.id}`}>
          <h2 className="q-h" id={`s3-${p.id}`}>
            3 · Evidence — every line with its source
          </h2>
          {evidenceBlock(p)}
        </section>

        <section className="q-sec q-sec-rev" aria-labelledby={`s4-${p.id}`}>
          <h2 className="q-h" id={`s4-${p.id}`}>
            4 · Reversibility
          </h2>
          <span className={`word boxed q-revword${rev.reversible ? "" : " q-irrev"}`}>
            {rev.word}
          </span>
          <p className="q-rev-note">{rev.note}</p>
        </section>

        <section className="q-decide" aria-label="Your decision">
          <div className="q-schedule">
            <label htmlFor={`sched-${p.id}`}>If approved, run</label>
            <select
              id={`sched-${p.id}`}
              className="q-select"
              value={schedule}
              onChange={(e) =>
                setSchedules((cur) => ({ ...cur, [p.id]: e.target.value as ScheduleKey }))
              }
            >
              {scheduleOptions(
                p.action.detail?.publish_at,
                p.action.detail?.execute_on_approval === true,
              ).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="q-answers">
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy}
              aria-keyshortcuts="A"
              onClick={() => approveFor(p)}
            >
              <span>
                {verb === "Approve" ? "Approve" : `Approve — ${verb}`}{" "}
                <span aria-hidden="true">→</span>
              </span>
              <kbd aria-hidden="true">A</kbd>
            </button>
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy}
              aria-keyshortcuts="R"
              aria-expanded={panels[p.id] === "changes"}
              onClick={() => changesFor(p.id)}
            >
              <span>Request changes</span>
              <kbd aria-hidden="true">R</kbd>
            </button>
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy}
              aria-keyshortcuts="D"
              aria-expanded={panels[p.id] === "decline"}
              onClick={() => declineFor(p.id, [p.id])}
            >
              <span>Decline</span>
              <kbd aria-hidden="true">D</kbd>
            </button>
          </div>
          {panels[p.id] === "decline" && reasonBox(p.id, 1)}
          {panels[p.id] === "changes" && changesBox(p.id)}
          <p className="q-approve-note">
            {approvalNote({ runAt, sending: p.action.detail?.sending })}
            {halted && " Everything is stopped right now: nothing runs until you start again."}
          </p>
        </section>
      </article>
    );
  };

  const bulkSheet = (
    <section className="q-sheet q-bulk" aria-label="Decide several together">
      <header className="q-sheet-head">
        <p className="q-ref">Bulk review · every proposal keeps its own record</p>
        <h1 className="q-title">
          {picked.size > 0 ? `${picked.size} selected` : "Tick proposals in the list"}
        </h1>
        <p className="q-deadline">
          Each one is still decided separately in the record, with its own entry — this only saves
          you the clicks.
        </p>
      </header>
      {picked.size > 0 && (
        <section className="q-decide">
          <div className="q-schedule">
            <label htmlFor="sched-bulk">If approved, all {picked.size} run</label>
            <select
              id="sched-bulk"
              className="q-select"
              value={bulkSchedule}
              onChange={(e) => {
                setBulkSchedule(e.target.value as ScheduleKey | "");
                if (e.target.value) setNeed(BULK, null);
              }}
            >
              <option value="">— choose when —</option>
              {scheduleOptions(undefined).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key === "now" ? "with no set time — a planned post keeps its time" : s.label}
                </option>
              ))}
            </select>
          </div>
          {needs[BULK] === "schedule" && (
            <p className="q-need" role="alert">
              Choose when they run first — a bulk approval states its schedule.
            </p>
          )}
          <div className="q-answers q-answers-2">
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy}
              onClick={() => {
                if (bulkSchedule === "") {
                  setNeed(BULK, "schedule");
                  document.getElementById("sched-bulk")?.focus();
                  return;
                }
                void decide([...picked], "approve", {
                  executeNotBefore: executeNotBefore(bulkSchedule, Date.now()),
                  bulk: true,
                });
              }}
            >
              <span>
                Approve {picked.size} <span aria-hidden="true">→</span>
              </span>
            </button>
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy}
              onClick={() => declineFor(BULK, [...picked])}
            >
              <span>Decline {picked.size}</span>
            </button>
          </div>
          {panels[BULK] === "decline" && reasonBox(BULK, picked.size)}
        </section>
      )}
    </section>
  );

  return (
    <div className="q-app">
      {header}
      {live}
      <div className="q-body">
        <aside className="q-side" aria-label="Proposals">
          <div className="q-side-head">
            <h2 className="q-side-label q-side-label-ink">
              Needs a decision · {pendingIds.length}
            </h2>
            {pendingIds.length > 1 && <span className="q-side-keys">J / K to move</span>}
          </div>
          {listed.length > 0 && (
            <ol className="q-items">
              {listed.map((p) => {
                const st = stamps[p.id];
                if (st) {
                  return (
                    <li key={p.id} className="q-item q-item-stamped">
                      <p className="q-stamp-word">{stampText(p.id, st)}</p>
                      <p className="q-side-title-s">{p.action.summary}</p>
                    </li>
                  );
                }
                const range = effectOf(p);
                const on = !bulk && current === p.id;
                return (
                  <li key={p.id} className={`q-item${on ? " on" : ""}`}>
                    {bulk && (
                      <input
                        type="checkbox"
                        className="q-pick"
                        aria-label={`Select: ${p.action.summary}`}
                        checked={picked.has(p.id)}
                        onChange={() =>
                          setPicked((cur) => {
                            const next = new Set(cur);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                      />
                    )}
                    <button
                      type="button"
                      className="q-item-btn"
                      ref={(el) => {
                        if (el) itemRefs.current.set(p.id, el);
                        else itemRefs.current.delete(p.id);
                      }}
                      aria-current={on ? "true" : undefined}
                      tabIndex={current === p.id ? 0 : -1}
                      onClick={() => {
                        setCurrentId(p.id);
                        if (bulk) setBulk(false);
                      }}
                    >
                      <span className="q-item-ref">
                        {shortRef(p.id)} · {moduleWord(p.module)}
                      </span>
                      <span className="q-item-title">{p.action.summary}</span>
                      <span className="q-item-meta">
                        {range
                          ? `${signedMoney(range.low)}–${signedMoney(range.high)} a month · `
                          : ""}
                        {shortReversibility(p.reversibility)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {decidedToday.length > 0 && (
            <section className="q-side-sec" aria-labelledby="q-today">
              <h2 className="q-side-label" id="q-today">
                Decided today
              </h2>
              <ul className="q-side-list">
                {decidedToday.map((p) => (
                  <li key={p.id}>
                    <p className="q-side-stamp">
                      {historyStamp(p)}
                      {p.rejection_reason ? ` · ${p.rejection_reason}` : ""}
                    </p>
                    <p className="q-side-title">{p.action.summary}</p>
                    {p.change_request && (
                      <p className="q-side-note">You asked: “{p.change_request}”</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {heldBack}

          {earlier.length > 0 && (
            <section className="q-side-sec" aria-labelledby="q-earlier">
              <h2 className="q-side-label" id="q-earlier">
                Earlier · {earlier.length}
              </h2>
              <ul className="q-side-list">
                {earlier.map((p) => (
                  <li key={p.id}>
                    <p className="q-side-stamp">
                      {historyStamp(p)}
                      {p.decided_at ? ` · ${dayWord(p.decided_at)}` : ""}
                    </p>
                    <p className="q-side-title">{p.action.summary}</p>
                    {p.status === "expired" && (
                      <p className="q-side-note">
                        {lapsedSentence(p) ??
                          "Not approved — nothing ran. It ran out of time undecided; that is not a no."}
                      </p>
                    )}
                    {p.rejection_reason && (
                      <p className="q-side-note">You said: “{p.rejection_reason}”</p>
                    )}
                    {p.change_request && (
                      <p className="q-side-note">You asked: “{p.change_request}”</p>
                    )}
                    {p.status === "approved" && p.execute_not_before && (
                      <p className="q-side-note">
                        Runs {dayWord(p.execute_not_before)} at the earliest.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="q-side-foot">
            Unanswered proposals expire on their decide-by date as “not approved — nothing ran”.
          </p>
          {pendingIds.length > 1 && (
            <button
              type="button"
              className="q-quiet q-quiet-desk"
              aria-pressed={bulk}
              onClick={() => {
                setBulk(!bulk);
                setPicked(new Set());
              }}
            >
              {bulk ? "Back to one at a time" : "Decide several together"}
            </button>
          )}
        </aside>

        <main className="q-main">
          {noticeBox}
          {bulk ? bulkSheet : open ? sheet(open) : emptySheet}
        </main>
      </div>
    </div>
  );
}
