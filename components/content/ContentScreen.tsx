"use client";

// The content queue — Phase 3 Session C. What the owner sees: their
// goals with one-click add; the two proposal buttons (calendar, shot
// list) that put PROPOSALS in the approval queue rather than doing
// anything; approved plans waiting to be drafted; and the scheduled
// queue itself, grouped by date, every item wearing its disclosure and
// able to say why it reads the way it reads. The honesty line is
// structural: this queue has nowhere to publish yet, and says so.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { EmergencyStop } from "../execution/EmergencyStop";

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

function dateWord(iso: string | null): string {
  if (!iso) return "anytime";
  // The date is a calendar day, not an instant — render it in UTC so a
  // negative-offset timezone doesn't show Monday's slot as Sunday.
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export function ContentScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });

  const load = useCallback(async () => {
    const [contentRes, goalsRes] = await Promise.all([fetch("/api/content"), fetch("/api/goals")]);
    if (contentRes.status === 401 || goalsRes.status === 401) {
      return setState({ phase: "signedout" });
    }
    const content = (await contentRes.json()) as { items: ContentItem[]; producible: Producible[] };
    const goals = (await goalsRes.json()) as { goals: Goal[]; suggestions: Suggestion[] };
    setState({
      phase: "ready",
      goals: goals.goals,
      suggestions: goals.suggestions,
      items: content.items,
      producible: content.producible,
      busy: false,
      notice: null,
      newGoal: "",
      open: null,
    });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="auth-stage">
        <p className="auth-copy">Reading the content queue…</p>
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

  const byDate = new Map<string, ContentItem[]>();
  for (const item of s.items) {
    const key = item.scheduled_for ?? "anytime";
    byDate.set(key, [...(byDate.get(key) ?? []), item]);
  }

  return (
    <main className="ops-shell">
      <header className="ops-head">
        <span className="wordmark">Ledgerline</span>
        <span className="ops-meta">
          content · {s.items.length} in the queue · publishes nowhere yet
        </span>
      </header>

      <EmergencyStop />

      {s.notice && (
        <section className="card ops-card">
          <p className="auth-copy" aria-live="polite">
            {s.notice}
          </p>
        </section>
      )}

      <section className="card ops-card">
        <span className="auth-eyebrow">goals — what the content serves</span>
        {s.goals.length === 0 && (
          <p className="auth-copy">
            No goals yet. State one, or take a suggestion — every planned piece will name the goal
            it serves.
          </p>
        )}
        <ul className="ct-goals">
          {s.goals.map((g) => (
            <li key={g.goal_id}>
              <span className="ct-goal-statement">{g.statement ?? "—"}</span>
              {g.horizon && (
                <span className="prop-tag">{HORIZON_WORD[g.horizon] ?? g.horizon}</span>
              )}
              {g.target_value && <span className="conn-note"> target: {g.target_value}</span>}
            </li>
          ))}
        </ul>
        {s.suggestions.length > 0 && (
          <div className="ct-suggestions">
            {s.suggestions.map((sug) => (
              <button
                key={sug.source}
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
          className="ct-goal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addGoal(s.newGoal);
          }}
        >
          <input
            className="ct-input"
            placeholder="A goal in your own words — dated and measurable beats grand"
            value={s.newGoal}
            onChange={(e) => setState({ ...s, newGoal: e.target.value })}
          />
          <button className="prop-btn" disabled={s.busy || s.newGoal.trim() === ""}>
            Add goal
          </button>
        </form>
      </section>

      <section className="card ops-card">
        <span className="auth-eyebrow">propose — nothing is made until you approve</span>
        <p className="auth-copy">
          Both of these create a proposal in your <Link href="/proposals">approval queue</Link>. Not
          a single word is drafted before you say yes there.
        </p>
        <div className="prop-actions">
          <button
            className="prop-btn"
            disabled={s.busy}
            onClick={() => void act({ action: "plan" }, "The calendar is in your approval queue.")}
          >
            Propose a content calendar
          </button>
          <button
            className="prop-btn"
            disabled={s.busy}
            onClick={() =>
              void act({ action: "shotlist" }, "The shot list is in your approval queue.")
            }
          >
            Propose a shot list
          </button>
        </div>
      </section>

      {s.producible.length > 0 && (
        <section className="card ops-card">
          <span className="auth-eyebrow">approved — ready to draft</span>
          {s.producible.map((p) => (
            <div key={p.id} className="ct-producible">
              <span>{p.summary}</span>
              <button
                className="prop-btn signal"
                disabled={s.busy}
                onClick={() =>
                  void act(
                    { action: "produce", proposal_id: p.id },
                    "Drafted. Every item below carries its disclosure and its sources.",
                  )
                }
              >
                Draft it
              </button>
            </div>
          ))}
        </section>
      )}

      {[...byDate.entries()].map(([date, items]) => (
        <section key={date} className="card ops-card">
          <span className="auth-eyebrow">{dateWord(date === "anytime" ? null : date)}</span>
          {items.map((item) => (
            <article key={item.id} className="ct-item">
              <div className="ct-item-head">
                <span className={`prop-tag ct-${item.kind}`}>{KIND_WORD[item.kind]}</span>
                <span className="ct-item-title">{item.title}</span>
                <button
                  className="prop-btn quiet"
                  onClick={() => setState({ ...s, open: s.open === item.id ? null : item.id })}
                >
                  {s.open === item.id ? "Close" : "Read"}
                </button>
              </div>
              {s.open === item.id && <pre className="ct-body">{item.body}</pre>}
              <p className="ct-disclosure">{item.disclosure}</p>
            </article>
          ))}
        </section>
      ))}

      <p className="conn-note">
        This queue has nowhere to publish yet — that is Session D, behind its own consent, after the
        measurement layer has proven itself. Until then every draft waits here, yours to keep or
        discard. <Link href="/proposals">Proposals</Link> · <Link href="/report">Report</Link> ·{" "}
        <Link href="/watch">Watching</Link>
      </p>
    </main>
  );
}
