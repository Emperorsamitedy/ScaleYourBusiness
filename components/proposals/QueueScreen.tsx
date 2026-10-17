"use client";

// The approval queue — Phase 3 Session A (P3-05/07), ux-spec §2 + §8.
//
// Every proposal is one paper sheet, read top to bottom in a fixed order:
// the change, the expected effect (a range, never a point), the evidence
// with its sources printed, whether it can be undone, and what declining
// does. Then the two answers — Approve and Decline, the same size, the
// same ink, physically apart, neither pre-selected. Declining is one
// action; a reason chip or a sentence satisfies the API's "declining asks
// why" without a second confirm step.
//
// After a decision the sheet stays where it was, collapsed to a thin
// stamp ("APPROVED 14:02 · ref …"), and focus advances to the next
// pending proposal. J / K move between pending proposals.
//
// Below the queue: the restraint view (rule 14) — proposals the system
// wrote and then blocked against the owner's own 13.5 limits — then
// decided and expired history, never conflated (expired is silence,
// rejected is a decision). Nothing here executes anything (rule 12):
// it records a human answer; the engine acts only on approved rows.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { EmergencyStop } from "../execution/EmergencyStop";
import {
  REASON_CHIPS,
  type ReasonChip,
  type Stamp,
  activeChip,
  applyReasonChip,
  changeOf,
  clockWord,
  dayWord,
  effectRange,
  executeNotBefore,
  isTypingTarget,
  moveFocus,
  nextAfterDecision,
  reversibilityLabel,
  stampText,
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
}

interface Proposal {
  id: string;
  module: string;
  status: string;
  action: {
    kind: string;
    summary: string;
    detail?: {
      rationale?: string;
      manual_limits?: string[];
      publish_at?: string;
      before?: unknown;
      after?: unknown;
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
  execute_not_before: string | null;
}

interface Queue {
  pending: Proposal[];
  blocked: Proposal[];
  decided: Proposal[];
  expired: Proposal[];
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
const BULK = "__bulk__";

function scheduleOptions(publishAt: string | undefined): { key: ScheduleKey; label: string }[] {
  const planned =
    publishAt && !Number.isNaN(Date.parse(publishAt))
      ? `at its planned time, ${dayWord(publishAt)} ${clockWord(publishAt)}`
      : "as soon as it can";
  return [
    { key: "now", label: planned },
    { key: "tomorrow", label: "no earlier than tomorrow" },
    { key: "next_week", label: "no earlier than next week" },
  ];
}

const HISTORY_WORD: Record<string, string> = {
  approved: "APPROVED",
  executed: "EXECUTED",
  rejected: "DECLINED",
};

async function fetchQueue(): Promise<Queue | "signedout"> {
  const res = await fetch("/api/proposals");
  if (res.status === 401) return "signedout";
  return (await res.json()) as Queue;
}

export function QueueScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Per proposal, keyed by id (and BULK for the bulk bar): one card's
  // choice never leaks into another's.
  const [schedules, setSchedules] = useState<Record<string, ScheduleKey>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [bulkSchedule, setBulkSchedule] = useState<ScheduleKey | "">("");
  const [needs, setNeeds] = useState<Record<string, "reason" | "schedule">>({});
  const [stamps, setStamps] = useState<Record<string, Stamp>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  const cardRefs = useRef(new Map<string, HTMLElement>());
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

  // The sheets on screen: everything pending, plus what was decided here
  // this visit (shown in place as a stamp). Server order — newest first —
  // so a decided sheet never jumps.
  const sheets = useMemo(() => {
    if (!queue) return [];
    const stamped = queue.decided.filter((p) => stamps[p.id]);
    return [...queue.pending, ...stamped].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [queue, stamps]);
  const pendingIds = useMemo(() => (queue ? queue.pending.map((p) => p.id) : []), [queue]);
  const rovingId = activeId && pendingIds.includes(activeId) ? activeId : (pendingIds[0] ?? null);

  const focusCard = useCallback((id: string) => {
    const el = cardRefs.current.get(id);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "start", behavior: "instant" });
  }, []);

  // Approve-and-advance: once the reloaded queue has rendered, move focus.
  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget === "__empty__") emptyRef.current?.focus({ preventScroll: false });
    else focusCard(focusTarget);
    setFocusTarget(null);
  }, [focusTarget, focusCard, sheets]);

  // J / K roving focus. Never while typing in a field.
  const keyState = useRef({ pendingIds, rovingId });
  useEffect(() => {
    keyState.current = { pendingIds, rovingId };
  }, [pendingIds, rovingId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target as HTMLElement | null)) return;
      const k = e.key.toLowerCase();
      if (k !== "j" && k !== "k") return;
      const { pendingIds: ids, rovingId: roving } = keyState.current;
      const inCard = (document.activeElement as HTMLElement | null)
        ?.closest<HTMLElement>("[data-proposal-id]")
        ?.getAttribute("data-proposal-id");
      // From outside the cards, the first press lands on the remembered
      // card (or the first / last) rather than skipping past it.
      const next =
        inCard && ids.includes(inCard)
          ? moveFocus(ids, inCard, k === "j" ? 1 : -1)
          : roving && ids.includes(roving)
            ? roving
            : moveFocus(ids, null, k === "j" ? 1 : -1);
      if (!next) return;
      e.preventDefault();
      setActiveId(next);
      focusCard(next);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [focusCard]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading the queue…</p>
      </main>
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

  const setNeed = (key: string, need: "reason" | "schedule" | null) =>
    setNeeds((cur) => {
      const next = { ...cur };
      if (need) next[key] = need;
      else delete next[key];
      return next;
    });

  const decide = async (
    ids: string[],
    decision: "approve" | "reject",
    opts: { reason?: string; executeNotBefore?: string | null; bulk?: boolean },
  ) => {
    if (ids.length === 0) return;
    setState({ ...state, busy: true, notice: null });
    const res = await fetch("/api/proposals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids,
        decision,
        ...(decision === "reject" ? { reason: opts.reason } : {}),
        ...(decision === "approve" && opts.executeNotBefore
          ? { execute_not_before: opts.executeNotBefore }
          : {}),
      }),
    });
    const clientAt = new Date().toISOString();
    const j = (await res.json().catch(() => ({}))) as DecideResult;
    if (res.status === 401 || res.status === 422 || (!res.ok && !j.decided)) {
      setState({ ...state, busy: false, notice: j.error ?? "that decision wasn't recorded" });
      return;
    }
    const decided = j.decided ?? [];
    const failed = j.failed ?? [];

    const fresh = await fetchQueue();
    if (fresh === "signedout") return setState({ phase: "signedout" });

    const newStamps: Record<string, Stamp> = {};
    for (const id of decided) {
      const row = fresh.decided.find((p) => p.id === id);
      newStamps[id] = row?.decided_at
        ? {
            decision: decision === "approve" ? "approved" : "rejected",
            at: row.decided_at,
            clientTime: false,
          }
        : {
            decision: decision === "approve" ? "approved" : "rejected",
            at: clientAt,
            clientTime: true,
          };
    }
    const order = sheets.map((p) => p.id);
    const stillPending = new Set(fresh.pending.map((p) => p.id));
    // Advance past what was recorded; if nothing was, stay on what was tried.
    const next =
      decided.length === 0
        ? (ids.find((id) => stillPending.has(id)) ?? fresh.pending[0]?.id ?? null)
        : (nextAfterDecision(order, decided, stillPending) ?? fresh.pending[0]?.id ?? null);

    setStamps((cur) => ({ ...cur, ...newStamps }));
    setSelected((cur) => new Set([...cur].filter((id) => stillPending.has(id))));
    setNeeds({});
    if (opts.bulk) {
      // A bulk answer is stated afresh every time — nothing carries over.
      setBulkSchedule("");
      setReasons((cur) => ({ ...cur, [BULK]: "" }));
    }
    setActiveId(next);
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
          : `${decided.length} proposals ${firstStamp.decision === "approved" ? "approved" : "declined"}`
        : "Nothing was recorded";
    const nextTitle = next ? fresh.pending.find((p) => p.id === next)?.action.summary : null;
    setAnnounce(
      `${said}.${failNote ? ` ${failNote}` : ""}${nextTitle ? ` Next: ${nextTitle}` : " Nothing else needs a decision."}`,
    );
  };

  const generate = async () => {
    setState({ ...state, busy: true });
    await fetch("/api/proposals", { method: "POST" });
    const fresh = await fetchQueue();
    if (fresh === "signedout") return setState({ phase: "signedout" });
    setState({ phase: "ready", queue: fresh, busy: false, notice: null });
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const chipFocus = (key: string) => document.getElementById(`chip0-${key}`)?.focus();

  /** Decline is one action: with a reason it records; without, it points at the chips. */
  const declineFor = (key: string, ids: string[]) => {
    const reason = (reasons[key] ?? "").trim();
    if (reason === "") {
      setNeed(key, "reason");
      chipFocus(key);
      return;
    }
    void decide(ids, "reject", { reason, bulk: key === BULK });
  };

  const reasonBox = (key: string, count: number) => {
    const reason = reasons[key] ?? "";
    const chip = activeChip(reason);
    const setReason = (v: string) => {
      setReasons((cur) => ({ ...cur, [key]: v }));
      if (v.trim() !== "" && needs[key] === "reason") setNeed(key, null);
    };
    return (
      <div className="q-why">
        <p className="label q-label" id={`why-${key}`}>
          why not{count > 1 ? `, for all ${count}` : ""}? one tap is enough
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
          className="prop-reason q-reason"
          placeholder="Or say it in a sentence — I learn from it."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {needs[key] === "reason" && (
          <p className="q-need" role="alert">
            Pick a reason first — declining asks why, and the record keeps your answer.
          </p>
        )}
      </div>
    );
  };

  const decideRow = (onApprove: () => void, onDecline: () => void, count = 1) => (
    <div className="q-decide">
      <button type="button" className="prop-btn q-btn" disabled={busy} onClick={onApprove}>
        Approve{count > 1 ? ` ${count}` : ""} <span aria-hidden="true">→</span>
      </button>
      <button type="button" className="prop-btn q-btn" disabled={busy} onClick={onDecline}>
        Decline{count > 1 ? ` ${count}` : ""} <span aria-hidden="true">→</span>
      </button>
    </div>
  );

  const history = [...q.decided.filter((p) => !stamps[p.id]), ...q.expired];

  return (
    <main className="ops-shell q-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">proposals · your decision · {q.pending.length} waiting</span>
      </header>

      <EmergencyStop />

      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {notice && (
        <section className="card ops-card q-notice" role="alert">
          <p className="auth-copy">{notice}</p>
        </section>
      )}

      {q.pending.length > 0 && <p className="label q-keys">J / K to move between proposals</p>}

      {q.pending.length === 0 && (
        <section className="card ops-card q-card">
          <h1 className="auth-title q-empty" tabIndex={-1} ref={emptyRef}>
            Nothing needs a decision.
          </h1>
          <p className="auth-copy q-prose">
            Proposals come from your latest diagnosis report, from changes the watching loop spots
            in your numbers, from goals that slip, from ad and content reviews, and from things you
            ask for in chat. Each one lands here first — what will happen, what it rests on, and
            what declining means. Nothing runs without your yes.
          </p>
          <button
            type="button"
            className="next q-cta"
            disabled={busy}
            onClick={() => void generate()}
          >
            Check the latest report for proposals <span aria-hidden="true">→</span>
          </button>
        </section>
      )}

      {q.pending.length > 1 && (
        <section className="card ops-card q-bulk" aria-label="Decide several together">
          <p className="label q-label">
            {selected.size > 0
              ? `${selected.size} selected`
              : "Select several with their boxes to decide them together"}
          </p>
          {selected.size > 0 && (
            <>
              <div className="prop-schedule q-schedule">
                <label className="conn-note" htmlFor="sched-bulk">
                  If approved, all {selected.size} run
                </label>
                <select
                  id="sched-bulk"
                  className="prop-select q-select"
                  value={bulkSchedule}
                  onChange={(e) => {
                    setBulkSchedule(e.target.value as ScheduleKey | "");
                    if (e.target.value) setNeed(BULK, null);
                  }}
                >
                  <option value="">— choose when —</option>
                  {scheduleOptions(undefined).map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.key === "now"
                        ? "as soon as each can — a planned post keeps its time"
                        : s.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="conn-note q-tight">
                This one choice applies to every selected proposal, whatever each sheet says.
              </p>
              {needs[BULK] === "schedule" && (
                <p className="q-need" role="alert">
                  Choose when they run first — a bulk approval states its schedule.
                </p>
              )}
              {reasonBox(BULK, selected.size)}
              {decideRow(
                () => {
                  if (bulkSchedule === "") {
                    setNeed(BULK, "schedule");
                    document.getElementById("sched-bulk")?.focus();
                    return;
                  }
                  void decide([...selected], "approve", {
                    executeNotBefore: executeNotBefore(bulkSchedule, Date.now()),
                    bulk: true,
                  });
                },
                () => declineFor(BULK, [...selected]),
                selected.size,
              )}
            </>
          )}
        </section>
      )}

      {sheets.map((p) => {
        const stamp = stamps[p.id];
        const titleId = `t-${p.id}`;
        if (stamp) {
          return (
            <section
              key={p.id}
              className="card ops-card q-card q-decided"
              aria-labelledby={titleId}
              data-stamped={stamp.decision}
            >
              <p className="label q-label">{p.module}</p>
              <h2 id={titleId} className="prop-title small q-title">
                {p.action.summary}
              </h2>
              <p className="q-stamp label">{stampText(p.id, stamp)}</p>
              {stamp.decision === "rejected" && p.rejection_reason && (
                <p className="conn-note q-tight">You said: “{p.rejection_reason}”</p>
              )}
              {stamp.decision === "approved" && (
                <p className="conn-note q-tight">
                  {p.execute_not_before
                    ? `Runs no earlier than ${dayWord(p.execute_not_before)}, ${clockWord(p.execute_not_before)}.`
                    : "Approved and waiting to run; the emergency stop above can still halt it."}
                </p>
              )}
            </section>
          );
        }

        const detail = p.action.detail;
        const change = changeOf(detail);
        const range = effectRange(p.scenario.downside_case, p.scenario.upside_case);
        const rev = reversibilityLabel(p.reversibility);
        const cases: { name: string; statement: string }[] = (
          [
            ["downside", p.scenario.downside_case],
            ["base", p.scenario.base_case],
            ["upside", p.scenario.upside_case],
          ] as const
        ).flatMap(([name, c]) => (c?.statement ? [{ name, statement: c.statement }] : []));
        const schedule = schedules[p.id] ?? "now";

        return (
          <section
            key={p.id}
            ref={(el) => {
              if (el) cardRefs.current.set(p.id, el);
              else cardRefs.current.delete(p.id);
            }}
            className="card ops-card q-card"
            data-proposal-id={p.id}
            tabIndex={rovingId === p.id ? 0 : -1}
            aria-labelledby={titleId}
            onFocus={() => setActiveId(p.id)}
          >
            <div className="q-head">
              <p className="label q-label">
                {p.module} · decide by {dayWord(p.expires_at)}
              </p>
              {q.pending.length > 1 && (
                <label className="q-pick">
                  <input
                    type="checkbox"
                    className="prop-check"
                    checked={selected.has(p.id)}
                    onChange={() => toggle(p.id)}
                  />
                  <span className="label">Select</span>
                </label>
              )}
            </div>
            <p className="conn-note q-tight">
              Unanswered by then, it expires: not approved — nothing ran.
            </p>

            {/* (1) the change */}
            <h2 id={titleId} className="prop-title q-title">
              {p.action.summary}
            </h2>
            {change && (
              <p className="q-change fig">
                <span className="sr-only">Changes from </span>
                {change.before} <span aria-hidden="true">→</span>
                <span className="sr-only"> to </span> {change.after}
              </p>
            )}
            {detail?.rationale && <p className="auth-copy q-prose">{detail.rationale}</p>}

            {/* (2) the expected effect */}
            <div className="q-block">
              <p className="label q-label">expected effect{range ? " · profit a month" : ""}</p>
              {range && (
                <p className="q-range fig">
                  {range.text}
                  <span className="label q-range-unit"> a month, downside to upside</span>
                </p>
              )}
              {cases.length > 0 && (
                <dl className="q-cases">
                  {cases.map((c) => (
                    <div key={c.name} className="q-case">
                      <dt className="label">{c.name}</dt>
                      <dd>{c.statement}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            {/* (3) the evidence */}
            <div className="q-block">
              <p className="label q-label">what it rests on</p>
              <ul className="q-evidence">
                {p.scenario.assumptions.map((a) => (
                  <li key={a.statement}>
                    <span className="q-ev-text">{a.statement}</span>
                    <span className="label q-src">
                      source{" "}
                      {a.source_field
                        ? a.source_field
                        : "none — an assumption, not a recorded fact"}
                      {a.sensitivity === "high" ? " · the conclusion leans hard on this" : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="label q-label q-sub">breakeven</p>
              <p className="auth-copy q-prose">{p.scenario.breakeven_condition}</p>
              {(detail?.manual_limits?.length ?? 0) > 0 && (
                <p className="prop-manual">
                  You told me: “{detail?.manual_limits?.join("” · “")}” — weigh this against that
                  yourself; I can&rsquo;t check it for you.
                </p>
              )}
            </div>

            {/* (4) can it be undone */}
            <div className="q-block">
              <p className={`flag q-rev${rev.reversible ? "" : " q-irrev"}`}>{rev.word}</p>
              <p className="auth-copy q-prose">{rev.note}</p>
            </div>

            {/* (5) if you decline */}
            <div className="q-block">
              <p className="label q-label">if you decline</p>
              <p className="auth-copy q-prose">
                Nothing runs and nothing changes. Declining is a real answer — I record it with your
                reason and don&rsquo;t act on it.
              </p>
              {reasonBox(p.id, 1)}
            </div>

            <div className="prop-schedule q-schedule">
              <label className="conn-note" htmlFor={`sched-${p.id}`}>
                If approved, run
              </label>
              <select
                id={`sched-${p.id}`}
                className="prop-select q-select"
                value={schedule}
                onChange={(e) =>
                  setSchedules((cur) => ({ ...cur, [p.id]: e.target.value as ScheduleKey }))
                }
              >
                {scheduleOptions(detail?.publish_at).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            {decideRow(
              () =>
                void decide([p.id], "approve", {
                  executeNotBefore: executeNotBefore(schedule, Date.now()),
                }),
              () => declineFor(p.id, [p.id]),
            )}
          </section>
        );
      })}

      {q.blocked.length > 0 && (
        <section className="card ops-card q-card">
          <p className="label q-label">held back, on your instruction</p>
          <ul className="q-held">
            {q.blocked.map((p) => (
              <li key={p.id}>
                <p className="flag q-rev">held back · will not be proposed</p>
                <h3 className="prop-title small q-title">{p.action.summary}</h3>
                <p className="conn-note q-tight">
                  I wrote this up and then blocked it myself — you said “
                  {p.blocked_by_limit?.replace(/^13\.5:\s*/, "")}”.
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section className="card ops-card q-card">
          <p className="label q-label">already handled</p>
          <ul className="q-log">
            {history.map((p) => (
              <li key={p.id}>
                <span className="flag q-log-flag">
                  {p.status === "expired" ? "expired" : (HISTORY_WORD[p.status] ?? p.status)}
                </span>
                <span className="q-log-title">{p.action.summary}</span>
                {p.status === "expired" && (
                  <span className="conn-note">
                    {" "}
                    — not approved, nothing ran. It ran out of time undecided; that is not a no.
                  </span>
                )}
                {p.rejection_reason && <span className="conn-note"> — “{p.rejection_reason}”</span>}
                {p.status === "approved" && p.execute_not_before && (
                  <span className="conn-note">
                    {" "}
                    — runs {dayWord(p.execute_not_before)} at the earliest
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="conn-note q-foot">
        Nothing on this screen runs without your yes, and everything decided here is recorded with
        your name and your words.
      </p>
    </main>
  );
}
