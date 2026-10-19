"use client";

// The content queue — Phase 3 Session C, in the owner's instrument
// design (2026-10-17). Top to bottom: one sentence counted from the
// queue; a strip per channel (planned vs posted, from the queue itself —
// no invented targets); the draft queue as a ruled table beside the open
// draft's record (caption, what it was written from, its disclosure);
// then the goals the content serves and the two proposal buttons, which
// put PROPOSALS in the approval queue rather than doing anything.
//
// P3-21e: it is also the publishing queue — each item's state on its way
// out, the platform's link once it is live, and Withdraw, which runs the
// stored undo through the engine. Nothing is ever published FROM this
// screen: an item goes out after its own yes in the queue, at its time,
// through the runner. While the Session D real-write gate is off the
// screen says so plainly.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import "../../app/content.css";
import { EmergencyStop } from "../execution/EmergencyStop";
import { PageHead, SheetCard } from "../sheet/PageHead";
import {
  type ContentStatus,
  type PerformanceLike,
  channelStrips,
  contentHeadline,
  performanceLine,
  platformWord,
  publishLine,
  shortId,
  stateWord,
} from "./content-view";

interface Goal {
  goal_id: string;
  statement: string | null;
  horizon: string | null;
  target_value: string | null;
}

interface Suggestion {
  statement: string;
  source: string;
}

interface ContentItem {
  id: string;
  kind: "post" | "email" | "shot_list" | "video";
  channel_label: string;
  scheduled_for: string | null;
  title: string;
  body: string;
  disclosure: string;
  goal_id: string | null;
  media_path: string | null;
  provenance: { evidence?: string[] } | null;
  /* P3-20d — the publish state, straight from the row. */
  status: ContentStatus;
  platform: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  published_at: string | null;
  publish_proposal_id: string | null;
  last_error: string | null;
}

interface Producible {
  id: string;
  summary: string;
}

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | {
      phase: "ready";
      goals: Goal[];
      suggestions: Suggestion[];
      items: ContentItem[];
      producible: Producible[];
      /** P3-21a: item id → why it isn't headed for publishing. */
      publishNotes: Record<string, string>;
      /** The Session D real-write gate: false until the two-week test completes. */
      realWrites: boolean;
      /** P3-23b: item id → its measured figures and verdict, published items only. */
      performance: Record<string, PerformanceLike>;
      /** The item whose Withdraw is waiting on a second click. */
      confirmWithdraw: string | null;
      busy: boolean;
      notice: string | null;
      newGoal: string;
      open: string | null;
    };

const KIND_WORD: Record<ContentItem["kind"], string> = {
  post: "post",
  email: "email",
  shot_list: "film this",
  video: "video",
};

const HORIZON_WORD: Record<string, string> = {
  "3_months": "3 months",
  "6_months": "6 months",
  "12_months": "12 months",
};

/** A calendar day, not an instant — rendered in UTC so a negative offset doesn't shift it. */
function dayWord(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function shortDay(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The id that produced a "channels.<id>.type" style key, if any. */
const EVIDENCE = /^(channels|goals)\.([0-9a-f-]{36})\.(\w+)$/;

export function ContentScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const detailRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    const [contentRes, goalsRes] = await Promise.all([fetch("/api/content"), fetch("/api/goals")]);
    if (contentRes.status === 401 || goalsRes.status === 401) {
      return setState({ phase: "signedout" });
    }
    const content = (await contentRes.json()) as {
      items: ContentItem[];
      producible: Producible[];
      publish_notes?: Record<string, string>;
      real_writes?: boolean;
      performance?: Record<string, PerformanceLike>;
    };
    const goals = (await goalsRes.json()) as { goals: Goal[]; suggestions: Suggestion[] };
    setState((cur) => ({
      phase: "ready",
      goals: goals.goals,
      suggestions: goals.suggestions,
      items: content.items,
      producible: content.producible,
      publishNotes: content.publish_notes ?? {},
      realWrites: content.real_writes === true,
      performance: content.performance ?? {},
      confirmWithdraw: null,
      busy: false,
      notice: null,
      newGoal: "",
      open: cur.phase === "ready" ? cur.open : null,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="screen ct-screen">
        <PageHead kicker="Grow · Content" title="Reading the content queue…" />
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">Ledgerline</span>
          <section className="card auth-card">
            <span className="auth-eyebrow">content</span>
            <h1 className="auth-title">Start with the intake.</h1>
            <p className="auth-copy">
              Content is planned from your profile — channels, goals, offers. Twelve questions and
              there is something real to plan with.
            </p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/intake">
              Begin
            </Link>
          </section>
        </div>
      </main>
    );
  }

  const s = state;
  const act = async (payload: Record<string, unknown>, doneNotice: string) => {
    setState({ ...s, busy: true, notice: null });
    const res = await fetch("/api/content", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = (await res.json()) as { error?: string };
    if (!res.ok) {
      setState({ ...s, busy: false, notice: j.error ?? "that didn't work" });
      return;
    }
    await load();
    setState((cur) => (cur.phase === "ready" ? { ...cur, notice: doneNotice } : cur));
  };

  const addGoal = async (statement: string) => {
    if (statement.trim() === "") return;
    setState({ ...s, busy: true });
    await fetch("/api/goals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statement }),
    });
    await load();
  };

  const today = todayIso();
  const strips = channelStrips(s.items, today);
  const goalById = new Map(s.goals.map((g) => [g.goal_id, g]));
  const nextDate =
    s.items
      .filter((i) => i.status === "drafted" || i.status === "queued")
      .map((i) => i.scheduled_for)
      .filter((d): d is string => d !== null && d >= today)
      .sort()[0] ?? null;
  const headline = contentHeadline({
    items: s.items,
    producible: s.producible.length,
    blocked: Object.keys(s.publishNotes).length,
    nextDate: nextDate ? dayWord(nextDate) : null,
  });

  // The open draft: the owner's pick, else the first one waiting on them, else the first draft.
  const open =
    s.items.find((i) => i.id === s.open) ??
    s.items.find((i) => i.status === "drafted" && i.publish_proposal_id !== null) ??
    s.items.find((i) => i.status === "drafted") ??
    s.items[0] ??
    null;

  const stripTitle = (channel: string, planned: number): string => {
    const kinds = new Set(
      s.items
        .filter((i) => i.channel_label === channel && i.status !== "withdrawn")
        .map((i) => i.kind),
    );
    const only = kinds.size === 1 ? [...kinds][0] : undefined;
    const word = only ? (only === "shot_list" ? "shot list" : KIND_WORD[only]) : "piece";
    return `${planned} ${word}${planned === 1 ? "" : "s"}`;
  };

  const pick = (id: string) => {
    setState({ ...s, open: id });
    if (window.matchMedia("(max-width: 1099px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
    }
  };

  const evidenceLine = (key: string, item: ContentItem): string => {
    const m = EVIDENCE.exec(key);
    if (m?.[1] === "channels") return `Channel: ${item.channel_label} · from your profile`;
    if (m?.[1] === "goals") {
      const g = m[2] ? goalById.get(m[2]) : undefined;
      return `Goal: ${g?.statement ?? "a goal you set"}`;
    }
    return key;
  };

  return (
    <main className="screen ct-screen">
      <PageHead
        kicker="Grow · Content"
        title={headline}
        aside={
          <a className="ghost ct-aside" href="#ct-goals">
            Change content goals <span aria-hidden="true">→</span>
          </a>
        }
      />

      <div className="ct-stop">
        <EmergencyStop />
      </div>

      {s.notice && (
        <p className="ct-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      {strips.length > 0 && (
        <ul className="ct-strips" aria-label="Each channel's queue">
          {strips.map((st) => {
            const pct = st.planned === 0 ? 0 : Math.round((st.posted / st.planned) * 100);
            const span =
              st.first && st.last
                ? st.first === st.last
                  ? shortDay(st.first)
                  : `${shortDay(st.first)} – ${shortDay(st.last)}`
                : "undated";
            return (
              <li key={st.channel} className="ct-strip">
                <p className="ct-strip-label">
                  {st.channel} · {span}
                </p>
                <p className="ct-strip-row">
                  <span className="ct-strip-title">{stripTitle(st.channel, st.planned)}</span>
                  <span className="ct-strip-fig">
                    {st.posted} / {st.planned}
                  </span>
                </p>
                <span
                  className={`ct-bar ${st.state}`}
                  role="img"
                  aria-label={`${st.posted} of ${st.planned} posted`}
                >
                  <span className="ct-bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <p className="ct-strip-state">
                  {st.state === "behind"
                    ? `Behind · ${st.overdue} past its date`
                    : st.state === "done"
                      ? "All posted"
                      : st.next
                        ? `Next ${dayWord(st.next)}`
                        : "On pace"}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <div className="ct-grid">
        <SheetCard
          label="Queue"
          title={
            s.realWrites
              ? "Written, scheduled, posted"
              : "Written and scheduled — publishing is off"
          }
          className="ct-queue"
        >
          {s.items.length === 0 ? (
            <p className="ct-empty">
              The queue is empty. Propose a calendar below — once you approve it in the queue, I
              draft it here.
            </p>
          ) : (
            <table className="rt ct-table">
              <thead>
                <tr>
                  <th scope="col">Draft</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Serves goal</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((item) => {
                  const w = stateWord(item, shortDay);
                  const goal = item.goal_id ? goalById.get(item.goal_id) : undefined;
                  return (
                    <tr key={item.id} className={open?.id === item.id ? "on" : undefined}>
                      <th scope="row" data-label="Draft">
                        <button
                          type="button"
                          className="ct-pick"
                          aria-pressed={open?.id === item.id}
                          onClick={() => pick(item.id)}
                        >
                          {item.title}
                        </button>
                        <span className="src ct-sub">
                          {shortId("C", item.id)} · {KIND_WORD[item.kind]}
                        </span>
                      </th>
                      <td data-label="Channel" className="ct-mono">
                        {item.channel_label}
                      </td>
                      <td data-label="Serves goal">{goal?.statement ?? "—"}</td>
                      <td data-label="State">
                        <span className={`word boxed ${w.tone}`}>{w.word}</span>
                      </td>
                      <td data-label="Date" className="num">
                        {item.scheduled_for ? shortDay(item.scheduled_for) : "anytime"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </SheetCard>

        {open && (
          <section
            className="cs ct-detail"
            ref={detailRef}
            aria-label={`Draft ${shortId("C", open.id)}`}
          >
            <header className="cs-head">
              <div>
                <p className="cs-label">
                  {shortId("C", open.id)} · {open.channel_label} {KIND_WORD[open.kind]} ·{" "}
                  {open.scheduled_for ? dayWord(open.scheduled_for) : "anytime"}
                </p>
                <h2 className="cs-title">{open.title}</h2>
              </div>
              <div className="cs-meta">
                <span className={`word boxed ${stateWord(open, shortDay).tone}`}>
                  {stateWord(open, shortDay).word}
                </span>
              </div>
            </header>
            <div className="cs-body ct-detail-body">
              {open.media_path && (
                <div className="ct-media">
                  <span>Media · your footage</span>
                  <span className="ct-media-path">{open.media_path.split("/").pop()}</span>
                </div>
              )}
              <div className="ct-detail-text">
                <p className="cs-label">{open.kind === "email" ? "Email" : "Caption"}</p>
                <p className="ct-caption">{open.body}</p>
                <p className="cs-label ct-gap">Written from</p>
                <ul className="ct-from">
                  {(open.provenance?.evidence ?? []).map((key) => (
                    <li key={key}>{evidenceLine(key, open)}</li>
                  ))}
                  {open.goal_id && goalById.get(open.goal_id)?.statement && (
                    <li>Serves: {goalById.get(open.goal_id)?.statement}</li>
                  )}
                  <li>Disclosure: {open.disclosure}</li>
                </ul>
              </div>
            </div>
            <footer className="ct-detail-foot">
              {s.publishNotes[open.id] && (
                <p className="ct-why">Not publishing: {s.publishNotes[open.id]}.</p>
              )}
              {open.status === "failed" && open.last_error && (
                <p className="ct-why">
                  <span className="word alarm">failed</span> {open.last_error}
                </p>
              )}
              {publishLine(open, s.realWrites) && (
                <p className="ct-why">
                  {open.status === "publishing" && open.last_error && (
                    <>
                      <span className="word drift">unconfirmed</span>{" "}
                    </>
                  )}
                  {publishLine(open, s.realWrites)}
                  {(open.status === "published" || open.status === "withdrawn") &&
                    open.platform_post_id && (
                      <span className="src ct-sub">
                        {platformWord(open.platform)} id {open.platform_post_id}
                        {open.published_at && ` · posted ${dayWord(open.published_at)}`}
                      </span>
                    )}
                </p>
              )}
              {(() => {
                const perf = performanceLine(s.performance[open.id]);
                if (!perf) return null;
                return (
                  <p className="ct-why">
                    Measured <span className={`word boxed ${perf.tone}`}>{perf.word}</span>
                    {perf.figures && ` ${perf.figures}`}
                    <span className="src ct-sub">{perf.arithmetic}</span>
                  </p>
                );
              })()}
              {open.status === "published" && s.confirmWithdraw === open.id && (
                <p className="ct-why">
                  Withdraw it? This deletes the post on {platformWord(open.platform)}. The record
                  stays here; the post can&apos;t be put back.
                </p>
              )}
              <div className="ct-actions">
                {open.status === "published" && open.platform_url && (
                  <a
                    className="prop-btn"
                    href={open.platform_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open on {platformWord(open.platform)} <span aria-hidden="true">→</span>
                  </a>
                )}
                {open.status === "published" &&
                  (s.confirmWithdraw === open.id ? (
                    <>
                      <button
                        type="button"
                        className="prop-btn"
                        disabled={s.busy}
                        onClick={() =>
                          void act(
                            { action: "withdraw", item_id: open.id },
                            `Withdrawn from ${platformWord(open.platform)}.`,
                          )
                        }
                      >
                        Yes, withdraw it
                      </button>
                      <button
                        type="button"
                        className="prop-btn quiet"
                        disabled={s.busy}
                        onClick={() => setState({ ...s, confirmWithdraw: null })}
                      >
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="prop-btn"
                      disabled={s.busy}
                      onClick={() => setState({ ...s, confirmWithdraw: open.id })}
                    >
                      Withdraw
                    </button>
                  ))}
                {open.publish_proposal_id !== null && open.status === "drafted" && (
                  <Link className="prop-btn ct-wide" href="/proposals">
                    Decide in the queue <span aria-hidden="true">→</span>
                  </Link>
                )}
                {s.publishNotes[open.id]?.includes("Connections") && (
                  <Link className="prop-btn" href="/connections">
                    Connections <span aria-hidden="true">→</span>
                  </Link>
                )}
              </div>
              <p className="ct-fine">
                {s.realWrites
                  ? "Nothing is published from this screen. An item goes out only after its own yes in the queue, at its time, through the runner; the emergency stop halts it, and Withdraw deletes it again."
                  : "Publishing is switched off until the two-week unattended test completes. Approved posts wait here, scheduled; nothing is sent to Meta until it is switched on."}
              </p>
            </footer>
          </section>
        )}
      </div>

      <div className="ct-lower">
        <SheetCard label="Goals" title="What the content serves" id="ct-goals">
          {s.goals.length === 0 ? (
            <p className="ct-empty">
              No goals yet. State one, or take a suggestion — every planned piece will name the goal
              it serves.
            </p>
          ) : (
            <ul className="ct-goal-list">
              {s.goals.map((g) => (
                <li key={g.goal_id}>
                  <span>{g.statement ?? "—"}</span>
                  <span className="ct-goal-meta">
                    {g.horizon ? (HORIZON_WORD[g.horizon] ?? g.horizon) : ""}
                    {g.target_value ? ` · target ${g.target_value}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.suggestions.length > 0 && (
            <div className="ct-suggest">
              {s.suggestions.map((sug) => (
                <button
                  key={sug.source}
                  type="button"
                  className="prop-btn quiet"
                  disabled={s.busy}
                  onClick={() => void addGoal(sug.statement)}
                >
                  + {sug.statement}
                </button>
              ))}
            </div>
          )}
          <form
            className="ct-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addGoal(s.newGoal);
            }}
          >
            <label className="cs-label" htmlFor="ct-new-goal">
              A goal in your own words
            </label>
            <input
              id="ct-new-goal"
              className="ct-input"
              placeholder="dated and measurable beats grand"
              value={s.newGoal}
              onChange={(e) => setState({ ...s, newGoal: e.target.value })}
            />
            <button className="prop-btn" disabled={s.busy || s.newGoal.trim() === ""}>
              Add goal
            </button>
          </form>
        </SheetCard>

        <SheetCard label="Propose" title="Nothing is made until you approve">
          <p className="ct-prose">
            Both of these create a proposal in your <Link href="/proposals">approval queue</Link>.
            Not a single word is drafted before you say yes there.
          </p>
          <div className="ct-actions">
            <button
              type="button"
              className="prop-btn"
              disabled={s.busy}
              onClick={() =>
                void act({ action: "plan" }, "The calendar is in your approval queue.")
              }
            >
              Propose a content calendar
            </button>
            <button
              type="button"
              className="prop-btn"
              disabled={s.busy}
              onClick={() =>
                void act({ action: "shotlist" }, "The shot list is in your approval queue.")
              }
            >
              Propose a shot list
            </button>
          </div>
          {s.producible.length > 0 && (
            <>
              <p className="cs-label ct-gap">Approved — ready to draft</p>
              <ul className="ct-producible">
                {s.producible.map((p) => (
                  <li key={p.id}>
                    <span>{p.summary}</span>
                    <button
                      type="button"
                      className="next"
                      disabled={s.busy}
                      onClick={() =>
                        void act(
                          { action: "produce", proposal_id: p.id },
                          "Drafted. Every item carries its disclosure and its sources.",
                        )
                      }
                    >
                      Draft it <span aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </SheetCard>
      </div>
    </main>
  );
}
