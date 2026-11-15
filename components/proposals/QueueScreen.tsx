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
import { useTranslations } from "next-intl";
import { EmergencyStop } from "../execution/EmergencyStop";
import { RangeBar } from "../sheet/RangeBar";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import type { Basis, BasisInput } from "../report/basis";
import { BASES, basisName } from "../report/basis";
import {
  REASON_CHIPS,
  chipLabel,
  adFacts,
  effectSpan,
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
  shortReversibility,
  signedMoney,
  stampText,
  lapsedSentence,
} from "./queue-model";
import "../../app/queue.css";
import { useRole } from "../auth/RoleContext";
import { Fold } from "../sheet/Fold";
import { Logo } from "../brand/Mark";
import { rollbackThresholdMs } from "../../lib/site/health-rule";
import { basisCounts, valueScaleTop, wordChange } from "./chart-model";
import {
  ChangeSize,
  DecisionTree,
  EvidenceRing,
  MastRing,
  Reactor,
  RingKey,
  RollbackBars,
  ValueBar,
  WayBack,
  type RingSlice,
} from "./QueueCharts";

/** Each basis's colour on the evidence ring, strongest (measured) to weakest. */
const BASIS_COLOR: Record<string, string> = {
  OBSERVED: "#cdeeff",
  DERIVED: "#5fc7b0",
  ESTIMATED: "#8aa7ff",
  STATED: "#3d6bff",
  ASSUMED: "#e2b26b",
  "NOT RECORDED": "#7a8a83",
};

/** A site change's load at proposal time, when the proposal carries one (lib/site/changes.ts). */
function baselineMsOf(p: { action: { detail?: Record<string, unknown> } }): number | null {
  const v = p.action.detail?.health_baseline_ms;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

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

const HISTORY_STATUSES = new Set([
  "approved",
  "executed",
  "rejected",
  "changes_requested",
  "expired",
]);

function scheduleOptions(
  w: QWords,
  publishAt: string | undefined,
  onApproval = false,
): { key: ScheduleKey; label: string }[] {
  const planned =
    publishAt && !Number.isNaN(Date.parse(publishAt))
      ? w.tr("schedule.planned", {
          day: dayWord(publishAt, undefined, w.locale),
          clock: clockWord(publishAt, undefined, w.locale),
        })
      : onApproval
        ? w.tr("schedule.nextRun")
        : w.tr("schedule.noTime");
  return [
    { key: "now", label: planned },
    { key: "tomorrow", label: w.tr("schedule.tomorrow") },
    { key: "next_week", label: w.tr("schedule.nextWeek") },
  ];
}

/** The queue's words and the reader's locale. */
interface QWords {
  tr: Tr;
  locale: AppLocale;
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

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function historyStamp(p: Proposal, w: QWords): string {
  const word = HISTORY_STATUSES.has(p.status)
    ? w.tr(`history.${p.status}`)
    : p.status.toUpperCase();
  const at = p.decided_at ? ` ${clockWord(p.decided_at, undefined, w.locale)}` : "";
  // 2026-11-15: no proposal code on the page; the record keeps the id.
  return `${word}${at}`;
}

function effectOf(p: Proposal) {
  return effectRange(p.scenario.downside_case, p.scenario.upside_case);
}

export function QueueScreen() {
  const t = useTranslations("proposals");
  const { tr, locale } = useTr("proposals");
  const w: QWords = { tr, locale };
  const st = useTr("sheet").tr;
  const qw = useTr("queueWords");
  const moduleWord = (m: string) => t("module", { module: m });
  const evidenceBasis = (b: string) =>
    (BASES as readonly string[]).includes(b)
      ? basisName(b as Basis, st)
      : t("evidence.notRecorded");
  const narrow = useNarrow();
  // Idea 52: a viewer reads the queue; deciding is an owner's or a manager's.
  const role = useRole();
  const mayDecide = role.can("proposals.decide");
  const decideWhy = role.why("proposals.decide");
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
      setState({ ...ready, busy: false, notice: j.error ?? t("notRecorded") });
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
        ? t("failNote", { count: failed.length, errors: failed.map((f) => f.error).join("; ") })
        : null;
    setState({ phase: "ready", queue: fresh, busy: false, notice: failNote });

    const first = decided[0];
    const firstStamp = first ? newStamps[first] : undefined;
    const said =
      first && firstStamp
        ? decided.length === 1
          ? stampText(first, firstStamp, undefined, tr, locale)
          : verdict === "approved"
            ? t("announce.approved", { count: decided.length })
            : t("announce.declined", { count: decided.length })
        : t("announce.nothing");
    const nextTitle = next ? fresh.pending.find((p) => p.id === next)?.action.summary : null;
    setAnnounce(
      `${said}.${failNote ? ` ${failNote}` : ""} ${nextTitle ? t("announce.next", { title: nextTitle }) : t("announce.none")}`,
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
      if (bulk || !current || !mayDecide) return;
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
        <p className="q-loading">{t("loading")}</p>
      </div>
    );
  }

  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">
            <Logo onDark />
          </span>
          <section className="card auth-card">
            <span className="auth-eyebrow">{t("signedOut.eyebrow")}</span>
            <h1 className="auth-title">{t("signedOut.title")}</h1>
            <p className="auth-copy">{t("signedOut.copy")}</p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/login">
              {t("signedOut.signIn")}
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
  // The side ring: the queue's mix, counted from the same lists the side prints.
  const ringSlices: RingSlice[] = [
    { key: "needs", label: t("chart.queue.needs"), count: pendingIds.length, color: "#cdeeff" },
    { key: "today", label: t("chart.queue.today"), count: decidedToday.length, color: "#ff9d92" },
    { key: "held", label: t("chart.queue.held"), count: q.blocked.length, color: "#e2b26b" },
    { key: "earlier", label: t("chart.queue.earlier"), count: earlier.length, color: "#4fa08a" },
  ];
  const ringTotal = ringSlices.reduce((a, s) => a + s.count, 0);
  // The value bars share one scale, and only when every money range is in one currency.
  const waitingRanges = q.pending.flatMap((p) => {
    const r = effectOf(p);
    return r ? [r] : [];
  });
  const valueCurrencies = new Set(waitingRanges.map((r) => r.high.currency));
  const valueCurrency = valueCurrencies.size === 1 ? [...valueCurrencies][0] : undefined;
  const valueTop =
    valueCurrencies.size > 1
      ? undefined
      : valueScaleTop(waitingRanges.map((r) => Math.max(r.low.amount_minor, r.high.amount_minor)));

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
    const chip = activeChip(reason, tr);
    const setReason = (v: string) => {
      setReasons((cur) => ({ ...cur, [key]: v }));
      if (v.trim() !== "" && needs[key] === "reason") setNeed(key, null);
    };
    return (
      <div className="q-panel">
        <p className="q-panel-label" id={`why-${key}`}>
          {count > 1 ? t("reason.whyAll", { count }) : t("reason.why")}
        </p>
        <div className="q-chips" role="group" aria-labelledby={`why-${key}`}>
          {REASON_CHIPS.map((c: ReasonChip, i) => (
            <button
              key={c}
              id={i === 0 ? `chip0-${key}` : undefined}
              type="button"
              className="q-chip"
              aria-pressed={chip === c}
              onClick={() => setReason(applyReasonChip(reason, c, tr))}
            >
              {chipLabel(c, tr)}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor={`reason-${key}`}>
          {t("reason.label")}
        </label>
        <textarea
          id={`reason-${key}`}
          className="q-text"
          placeholder={t("reason.placeholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {needs[key] === "reason" && (
          <p className="q-need" role="alert">
            {t("reason.need")}
          </p>
        )}
        <p className="q-panel-foot">{t("reason.foot")}</p>
        <button
          type="button"
          className="q-btn q-btn-inline"
          disabled={busy || !mayDecide || reason.trim() === ""}
          onClick={() => (key === BULK ? declineFor(BULK, [...picked]) : declineFor(key, [key]))}
        >
          {count > 1 ? t("reason.recordAll", { count }) : t("reason.record")}{" "}
          <span aria-hidden="true">→</span>
        </button>
      </div>
    );
  };

  const changesBox = (id: string) => {
    const words = changes[id] ?? "";
    return (
      <div className="q-panel">
        <label className="q-panel-label" htmlFor={`changes-${id}`}>
          {t("changes.label")}
        </label>
        <textarea
          id={`changes-${id}`}
          className="q-text"
          placeholder={t("changes.placeholder")}
          value={words}
          onChange={(e) => {
            setChanges((cur) => ({ ...cur, [id]: e.target.value }));
            if (e.target.value.trim() !== "" && needs[id] === "changes") setNeed(id, null);
          }}
        />
        {needs[id] === "changes" && (
          <p className="q-need" role="alert">
            {t("changes.need")}
          </p>
        )}
        <p className="q-panel-foot">{t("changes.foot")}</p>
        <button
          type="button"
          className="q-btn q-btn-inline"
          disabled={busy || !mayDecide || words.trim() === ""}
          onClick={() => changesFor(id)}
        >
          {t("changes.record")} <span aria-hidden="true">→</span>
        </button>
      </div>
    );
  };

  const changeBlock = (p: Proposal, compact: boolean) => {
    const lines = changeLines(p.action, undefined, qw);
    if (!lines) {
      return <p className="q-nolines">{t("change.none", { summary: p.action.summary })}</p>;
    }
    if (compact) {
      return (
        <dl className="q-mlines">
          {lines.map((l) =>
            // Sentences (a page's wording) don't fit a right-aligned figure
            // line: they stack, each side named, so before and after can't run together.
            l.before.length + l.after.length > 48 ? (
              <div key={l.line} className="q-mline q-mline-words">
                <dt>
                  {l.line}
                  {l.sub && <span className="q-line-sub">{l.sub}</span>}
                </dt>
                <dd>
                  <span className="q-mline-side">{t("change.before")}</span>
                  <span className="q-before">{l.before}</span>
                </dd>
                <dd>
                  <span className="q-mline-side">{t("change.after")}</span>
                  <span className="q-after">{l.after}</span>
                </dd>
              </div>
            ) : (
              <div key={l.line} className="q-mline">
                <dt>{l.line}</dt>
                <dd className="fig">
                  {l.before} <span aria-hidden="true">→</span>
                  <span className="sr-only"> {t("change.becomes")} </span> {l.after}
                </dd>
              </div>
            ),
          )}
        </dl>
      );
    }
    return (
      <table className="rt q-lines">
        <thead>
          <tr>
            <th scope="col">{t("change.line")}</th>
            <th scope="col">{t("change.before")}</th>
            <th scope="col">{t("change.after")}</th>
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

  /** P3-54: an ad's budget, duration, audience and what can't be undone. */
  const adBlock = (p: Proposal) => {
    const ad = adFacts(p.action, qw);
    if (!ad) return null;
    return (
      <div className="q-adfacts">
        <dl className="q-cases">
          {ad.facts.map((f, i) => (
            <div key={`${f.label}-${i}`} className="q-case">
              <dt>{f.label}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
        {ad.note && <p className="q-manual">{ad.note}</p>}
      </div>
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
              {signedMoney(range.low, locale)} – {signedMoney(range.high, locale)}
            </p>
            <p className="q-mono-note">
              {t("effect.profit", { span: effectSpan(p.action, qw) })}
              {!compact && base?.statement
                ? ` · ${t("effect.likeliest", { statement: base.statement })}`
                : ""}
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
                {axis.ticks.map((x) => (
                  <span key={x}>{moneyText(x, cur, locale)}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    if (compact) {
      return <p className="q-effect-words">{base?.statement ?? t("effect.none")}</p>;
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
        <p className="q-mono-note">{t("effect.noRange")}</p>
        <dl className="q-cases">
          {cases.map(({ name, c }) => (
            <div key={name} className="q-case">
              <dt>{t(`effect.case.${name}`)}</dt>
              <dd>
                {c.statement}
                {c.formula && (
                  <span className="q-formula">{t("effect.workedOut", { formula: c.formula })}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    );
  };

  /** The size of each wording change (up to three lines), drawn under the change table. */
  const sizeCharts = (p: Proposal) =>
    (changeLines(p.action, undefined, qw) ?? []).slice(0, 3).map((l) => {
      const c = wordChange(l.before, l.after);
      return c ? <ChangeSize key={l.line} change={c} tr={tr} locale={locale} /> : null;
    });
  /** A site change's rollback limit, when the proposal carries the page's load. */
  const rollbackChart = (p: Proposal) => {
    const ms = baselineMsOf(p);
    return ms === null ? null : <RollbackBars baselineMs={ms} tr={tr} locale={locale} />;
  };
  /** The way back, for what can be undone. */
  const wayBack = (p: Proposal, reversible: boolean) => {
    if (!reversible) return null;
    const ms = baselineMsOf(p);
    return (
      <WayBack autoMs={ms === null ? null : rollbackThresholdMs(ms)} tr={tr} locale={locale} />
    );
  };

  const evidenceBlock = (p: Proposal, charts = false) => {
    const lines = evidenceLines(p.scenario.assumptions, facts, qw, st);
    const keys = new Set(
      p.scenario.assumptions.flatMap((a) => (a.source_field ? [a.source_field] : [])),
    );
    const disagree = (q.disagreements ?? []).filter((d) => d.field_keys.some((k) => keys.has(k)));
    const manual = p.action.detail?.manual_limits ?? [];
    return (
      <>
        {lines.length === 0 ? (
          <p className="q-nolines">{t("evidence.none")}</p>
        ) : (
          <ul className="q-evidence">
            {lines.map((l, i) => (
              <li key={`${i}-${l.statement}`}>
                <span className="q-ev-text">
                  {l.statement}
                  {l.leansHard && <span className="q-leans">{t("evidence.leans")}</span>}
                </span>
                <span className="q-ev-src">
                  {l.source} · <b>{evidenceBasis(l.basis)}</b>
                </span>
              </li>
            ))}
          </ul>
        )}
        {disagree.map((d) => (
          <p key={d.finding_id} className="q-disagree">
            <span className="q-disagree-word">
              {t("evidence.disagree", { count: d.field_keys.length })}
            </span>{" "}
            {d.message}
          </p>
        ))}
        <p className="q-breakeven">
          <span className="q-mono-label">{t("evidence.breakEven")}</span>{" "}
          {p.scenario.breakeven_condition}
        </p>
        {manual.length > 0 && (
          <p className="q-manual">{t("evidence.manual", { limits: manual.join("” · “") })}</p>
        )}
        {charts && (
          <div className="q-fig-duo">
            {lines.length > 0 && (
              <EvidenceRing
                slices={basisCounts(BASES, lines).map((c): RingSlice => ({
                  key: c.basis,
                  label: evidenceBasis(c.basis),
                  count: c.count,
                  color: BASIS_COLOR[c.basis] ?? "#7a8a83",
                }))}
                tr={tr}
                locale={locale}
              />
            )}
            <DecisionTree
              facts={lines.map((l) => ({ basisLabel: evidenceBasis(l.basis) }))}
              rules={manual.length}
              disagreements={disagree.length}
              tr={tr}
              locale={locale}
            />
          </div>
        )}
      </>
    );
  };

  const header = (
    <header className="q-mast">
      <div className="q-mast-left">
        <Link href="/watch" className="q-wordmark">
          <Logo onDark />
        </Link>
        <span className="q-mast-meta">
          {q.business ? `${q.business} · ` : ""}
          {t("decisions")}
        </span>
      </div>
      <div className="q-mast-right">
        {stats && (
          <span className="q-mast-stats">
            <MastRing
              approved={stats.approved}
              decided={stats.decided}
              label={t("chart.mast", { approved: stats.approved, decided: stats.decided })}
            />
            {t("stats", {
              median: durationWord(stats.medianMs, qw),
              approved: stats.approved,
              decided: stats.decided,
            })}
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
        {t("empty.title")}
      </h1>
      <Fold>
        <p>{t("empty.lede")}</p>
      </Fold>
      <button
        type="button"
        className="q-btn q-btn-inline"
        disabled={busy || !role.can("proposals.generate")}
        title={role.why("proposals.generate") ?? undefined}
        onClick={() => void generate()}
      >
        {t("empty.check")} <span aria-hidden="true">→</span>
      </button>
    </section>
  );

  const heldBack = q.blocked.length > 0 && (
    <section className="q-side-sec" aria-labelledby="q-held">
      <h2 className="q-side-label" id="q-held">
        {t("held.label", { count: q.blocked.length })}
      </h2>
      <ul className="q-side-list">
        {q.blocked.map((p) => (
          <li key={p.id}>
            <p className="q-side-stamp">{t("held.stamp")}</p>
            <p className="q-side-title">{p.action.summary}</p>
            <p className="q-side-note">
              {t("held.note", {
                // The sentence ends itself: the owner's own full stop would double it ("it.”.").
                limit: (p.blocked_by_limit ?? "")
                  .replace(/^13\.5:\s*/, "")
                  .replace(/[.!]+\s*$/, ""),
              })}
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
          const sp = stamps[p.id] as Stamp;
          return (
            <li key={p.id}>
              <span className="q-stamp-word">{stampText(p.id, sp, undefined, tr, locale)}</span>{" "}
              {p.action.summary}
            </li>
          );
        })}
      </ul>
    );
  };

  const mobileCard = (p: Proposal) => {
    const rev = reversibilityLabel(p.reversibility, p.action.detail, tr);
    const lines = evidenceLines(p.scenario.assumptions, facts, qw, st);
    const shown = evidenceOpen[p.id] === true;
    const range = effectOf(p);
    const runAt = runAtFor(p, schedules[p.id] ?? "now", Date.now());
    const titleId = `mt-${p.id}`;
    return (
      <article className="q-sheet q-mcard" aria-labelledby={titleId}>
        <header className="q-mcard-head">
          <p className="q-ref">{moduleWord(p.module)}</p>
          <h2 id={titleId} className="q-title">
            {p.action.summary}
          </h2>
        </header>
        <section className="q-msec">
          <h3 className="q-mlabel">{t("m.changes")}</h3>
          {changeBlock(p, true)}
          {sizeCharts(p)}
          {adBlock(p)}
        </section>
        <section className="q-msec">
          <h3 className="q-mlabel">
            {range ? t("m.expectedSpan", { span: effectSpan(p.action, qw) }) : t("m.expected")}
          </h3>
          {effectBlock(p, true)}
          {rollbackChart(p)}
        </section>
        <section className="q-msec">
          <div className="q-rev-row">
            <span className={`word boxed q-revword${rev.reversible ? "" : " q-irrev"}`}>
              {rev.reversible ? t("rev.reversibleWord") : rev.word}
            </span>
            <span className="q-rev-note">{rev.note}</span>
          </div>
          {wayBack(p, rev.reversible)}
          <button
            type="button"
            className="q-evtoggle"
            aria-expanded={shown}
            aria-controls={`ev-${p.id}`}
            onClick={() => setEvidenceOpen((cur) => ({ ...cur, [p.id]: !shown }))}
          >
            {t("m.evidence", { count: lines.length })}{" "}
            <span aria-hidden="true">{shown ? "↑" : "→"}</span>
          </button>
          {shown && (
            <div id={`ev-${p.id}`} className="q-mev">
              {evidenceBlock(p, true)}
            </div>
          )}
        </section>
        <section className="q-mdecide" aria-label={t("decide.label")}>
          <button
            type="button"
            className="q-btn q-primary"
            disabled={busy || !mayDecide}
            onClick={() => approveFor(p)}
          >
            <span>{consequence(p.action, tr, locale)}</span> <span aria-hidden="true">→</span>
          </button>
          <div className="q-mpair">
            <button
              type="button"
              className="q-btn"
              disabled={busy || !mayDecide}
              onClick={() => declineFor(p.id, [p.id])}
            >
              {t("decide.decline")}
            </button>
            <button
              type="button"
              className="q-btn"
              disabled={busy || pendingIds.length < 2}
              onClick={later}
            >
              {t("m.later")}
            </button>
          </div>
          <button
            type="button"
            className="q-quiet"
            disabled={busy || !mayDecide}
            onClick={() => changesFor(p.id)}
          >
            {t("m.changesInstead")}
          </button>
          {panels[p.id] === "decline" && reasonBox(p.id, 1)}
          {panels[p.id] === "changes" && changesBox(p.id)}
          <p className="q-approve-note">
            {approvalNote({ runAt, sending: p.action.detail?.sending, tr, locale, qw })}
            {halted && ` ${t("decide.halted")}`}
          </p>
          {decideWhy && (
            <p className="q-role-note" role="note">
              {decideWhy}
            </p>
          )}
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
              <Logo onDark />
            </Link>
            {q.business && <span className="q-mast-meta">{q.business}</span>}
          </div>
          <div className="q-mast-row q-mast-big">
            <h1 className="q-waiting">
              {q.pending.length === 0
                ? t("m.nothingWaiting")
                : t("m.waiting", { count: q.pending.length })}
            </h1>
            {open && (
              <p className="q-pos">
                {t("m.position", { n: idx + 1, of: pendingIds.length })}
                {nextP ? ` · ${t("m.next", { title: clip(nextP.action.summary, 34) })}` : ""}
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
          {heldBack}
        </main>
      </div>
    );
  }

  /* ── desktop: the list and the sheet ── */

  const sheet = (p: Proposal) => {
    const rev = reversibilityLabel(p.reversibility, p.action.detail, tr);
    const titleId = `t-${p.id}`;
    const origin = originWord(p.originating_finding, tr);
    const range = effectOf(p);
    const schedule = schedules[p.id] ?? "now";
    const runAt = runAtFor(p, schedule, Date.now());
    const verb = consequence(p.action, tr, locale);
    const plain = verb === consequence({ summary: "" }, tr, locale);
    const sameDay = isSameDay(p.created_at, now);
    return (
      <article className="q-sheet" aria-labelledby={titleId} key={p.id}>
        <header className="q-sheet-head">
          <p className="q-ref">
            {t("sheet.drafted", {
              when: sameDay
                ? clockWord(p.created_at, undefined, locale)
                : `${dayWord(p.created_at, undefined, locale)} ${clockWord(p.created_at, undefined, locale)}`,
            })}
            {origin ? ` · ${t("sheet.from", { origin })}` : ""}
          </p>
          <h1 id={titleId} className="q-title">
            {p.action.summary}
          </h1>
          <p className="q-deadline">
            {t("sheet.deadline", { day: dayWord(p.expires_at, undefined, locale) })}
          </p>
        </header>

        <section className="q-sec" aria-labelledby={`s1-${p.id}`}>
          <h2 className="q-h" id={`s1-${p.id}`}>
            {t("sheet.s1", { n: 1 })}
          </h2>
          {changeBlock(p, false)}
          {sizeCharts(p)}
          {adBlock(p)}
          {p.action.detail?.rationale && <p className="q-prose">{p.action.detail.rationale}</p>}
        </section>

        <section className="q-sec" aria-labelledby={`s2-${p.id}`}>
          <h2 className="q-h" id={`s2-${p.id}`}>
            {range
              ? t("sheet.s2Span", { n: 2, span: effectSpan(p.action, qw) })
              : t("sheet.s2", { n: 2 })}
          </h2>
          {effectBlock(p, false)}
          {rollbackChart(p)}
        </section>

        <section className="q-sec" aria-labelledby={`s3-${p.id}`}>
          <h2 className="q-h" id={`s3-${p.id}`}>
            {t("sheet.s3", { n: 3 })}
          </h2>
          {evidenceBlock(p, true)}
        </section>

        <section className="q-sec q-sec-rev" aria-labelledby={`s4-${p.id}`}>
          <h2 className="q-h" id={`s4-${p.id}`}>
            {t("sheet.s4", { n: 4 })}
          </h2>
          <span className={`word boxed q-revword${rev.reversible ? "" : " q-irrev"}`}>
            {rev.word}
          </span>
          <p className="q-rev-note">{rev.note}</p>
          {wayBack(p, rev.reversible)}
        </section>

        <section className="q-decide" aria-label={t("decide.label")}>
          <div className="q-schedule">
            <label htmlFor={`sched-${p.id}`}>{t("decide.run")}</label>
            <select
              id={`sched-${p.id}`}
              className="q-select"
              value={schedule}
              onChange={(e) =>
                setSchedules((cur) => ({ ...cur, [p.id]: e.target.value as ScheduleKey }))
              }
            >
              {scheduleOptions(
                w,
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
              disabled={busy || !mayDecide}
              aria-keyshortcuts="A"
              onClick={() => approveFor(p)}
            >
              <span>
                {plain ? verb : t("decide.approveVerb", { verb })} <span aria-hidden="true">→</span>
              </span>
              <kbd aria-hidden="true">A</kbd>
            </button>
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy || !mayDecide}
              aria-keyshortcuts="R"
              aria-expanded={panels[p.id] === "changes"}
              onClick={() => changesFor(p.id)}
            >
              <span>{t("decide.changes")}</span>
              <kbd aria-hidden="true">R</kbd>
            </button>
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy || !mayDecide}
              aria-keyshortcuts="D"
              aria-expanded={panels[p.id] === "decline"}
              onClick={() => declineFor(p.id, [p.id])}
            >
              <span>{t("decide.decline")}</span>
              <kbd aria-hidden="true">D</kbd>
            </button>
          </div>
          {panels[p.id] === "decline" && reasonBox(p.id, 1)}
          {panels[p.id] === "changes" && changesBox(p.id)}
          <p className="q-approve-note">
            {approvalNote({ runAt, sending: p.action.detail?.sending, tr, locale, qw })}
            {halted && ` ${t("decide.halted")}`}
          </p>
          {decideWhy && (
            <p className="q-role-note" role="note">
              {decideWhy}
            </p>
          )}
        </section>
      </article>
    );
  };

  const bulkSheet = (
    <section className="q-sheet q-bulk" aria-label={t("bulk.label")}>
      <header className="q-sheet-head">
        <h1 className="q-title">
          {picked.size > 0 ? t("bulk.selected", { count: picked.size }) : t("bulk.tick")}
        </h1>
      </header>
      {picked.size > 0 && (
        <section className="q-decide">
          <div className="q-schedule">
            <label htmlFor="sched-bulk">{t("bulk.run", { count: picked.size })}</label>
            <select
              id="sched-bulk"
              className="q-select"
              value={bulkSchedule}
              onChange={(e) => {
                setBulkSchedule(e.target.value as ScheduleKey | "");
                if (e.target.value) setNeed(BULK, null);
              }}
            >
              <option value="">{t("bulk.choose")}</option>
              {scheduleOptions(w, undefined).map((s) => (
                <option key={s.key} value={s.key}>
                  {s.key === "now" ? t("bulk.noTime") : s.label}
                </option>
              ))}
            </select>
          </div>
          {needs[BULK] === "schedule" && (
            <p className="q-need" role="alert">
              {t("bulk.need")}
            </p>
          )}
          <div className="q-answers q-answers-2">
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy || !mayDecide}
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
                {t("bulk.approve", { count: picked.size })} <span aria-hidden="true">→</span>
              </span>
            </button>
            <button
              type="button"
              className="q-btn q-answer"
              disabled={busy || !mayDecide}
              onClick={() => declineFor(BULK, [...picked])}
            >
              <span>{t("bulk.decline", { count: picked.size })}</span>
            </button>
          </div>
          {panels[BULK] === "decline" && reasonBox(BULK, picked.size)}
          {decideWhy && (
            <p className="q-role-note" role="note">
              {decideWhy}
            </p>
          )}
        </section>
      )}
    </section>
  );

  return (
    <div className="q-app">
      {header}
      {live}
      <div className="q-body">
        <aside className="q-side" aria-label={t("side.label")}>
          <div className="q-side-head">
            <h2 className="q-side-label q-side-label-ink">
              {t("side.needs", { count: pendingIds.length })}
            </h2>
            {pendingIds.length > 1 && <span className="q-side-keys sr-only">{t("side.keys")}</span>}
          </div>
          {ringTotal > 0 && (
            <div className="q-side-ring">
              <Reactor
                slices={ringSlices}
                center={num(ringTotal, 0, locale)}
                label={t("chart.queue.aria", {
                  needs: ringSlices[0]?.count ?? 0,
                  today: ringSlices[1]?.count ?? 0,
                  held: ringSlices[2]?.count ?? 0,
                  earlier: ringSlices[3]?.count ?? 0,
                })}
              />
              <RingKey slices={ringSlices} locale={locale} />
            </div>
          )}
          {listed.length > 0 && (
            <ol className="q-items">
              {listed.map((p) => {
                const sp = stamps[p.id];
                if (sp) {
                  return (
                    <li key={p.id} className="q-item q-item-stamped">
                      <p className="q-stamp-word">{stampText(p.id, sp, undefined, tr, locale)}</p>
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
                        aria-label={t("side.select", { title: p.action.summary })}
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
                      <span className="q-item-ref">{moduleWord(p.module)}</span>
                      <span className="q-item-title">{p.action.summary}</span>
                      <span className="q-item-meta">
                        {range
                          ? `${t("side.perMonth", {
                              range: `${signedMoney(range.low, locale)}–${signedMoney(range.high, locale)}`,
                            })} · `
                          : ""}
                        {shortReversibility(p.reversibility, tr)}
                      </span>
                      {valueTop !== undefined && (
                        <ValueBar
                          low={range ? range.low.amount_minor : null}
                          high={range ? range.high.amount_minor : null}
                          top={valueTop}
                          label={
                            range
                              ? t("side.perMonth", {
                                  range: `${signedMoney(range.low, locale)}–${signedMoney(range.high, locale)}`,
                                })
                              : t("chart.value.none")
                          }
                          caption={
                            range && valueTop !== null && valueCurrency
                              ? t("chart.value.scale", {
                                  top: moneyText(valueTop, valueCurrency, locale),
                                })
                              : t("chart.value.none")
                          }
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}

          {decidedToday.length > 0 && (
            <section className="q-side-sec" aria-labelledby="q-today">
              <h2 className="q-side-label" id="q-today">
                {t("side.today")}
              </h2>
              <ul className="q-side-list">
                {decidedToday.map((p) => (
                  <li key={p.id}>
                    <p className="q-side-stamp">
                      {historyStamp(p, w)}
                      {p.rejection_reason ? ` · ${p.rejection_reason}` : ""}
                    </p>
                    <p className="q-side-title">{p.action.summary}</p>
                    {p.change_request && (
                      <p className="q-side-note">
                        {t("side.youAsked", { words: p.change_request })}
                      </p>
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
                {t("side.earlier", { count: earlier.length })}
              </h2>
              <ul className="q-side-list">
                {earlier.map((p) => (
                  <li key={p.id}>
                    <p className="q-side-stamp">
                      {historyStamp(p, w)}
                      {p.decided_at ? ` · ${dayWord(p.decided_at, undefined, locale)}` : ""}
                    </p>
                    <p className="q-side-title">{p.action.summary}</p>
                    {p.status === "expired" && (
                      <p className="q-side-note">{lapsedSentence(p, tr) ?? t("side.expired")}</p>
                    )}
                    {p.rejection_reason && (
                      <p className="q-side-note">
                        {t("side.youSaid", { words: p.rejection_reason })}
                      </p>
                    )}
                    {p.change_request && (
                      <p className="q-side-note">
                        {t("side.youAsked", { words: p.change_request })}
                      </p>
                    )}
                    {p.status === "approved" && p.execute_not_before && (
                      <p className="q-side-note">
                        {t("side.runs", {
                          day: dayWord(p.execute_not_before, undefined, locale),
                        })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

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
              {bulk ? t("side.oneAtATime") : t("bulk.label")}
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
