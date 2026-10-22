"use client";

// Insights · Goals — the owner's Goals design (2026-10-17) on goal
// progress and alert mode (Session J, P3-42..47). Per goal: where the
// last 28 days put it, where the path says it should be, the target, the
// weekly candles of its measured series (read on the server, ./page), the
// latest weekly verdict with its arithmetic and — when a goal reached
// alert — what the review found and whether a person now has the case.
// A goal that can't be measured yet carries the form that makes it so.

import "../../app/goals.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { minorUnitExponent } from "../../lib/core/money";
import type { GoalChart } from "../../lib/care/charts";
import type { GoalWord } from "../../lib/care/chart-view";
import { goalWord, onPath } from "../../lib/care/chart-view";
import { CandleChart } from "./CandleChart";

interface Measure {
  metric: "revenue" | "orders" | "sessions";
  direction: "increase" | "decrease";
  target_per_30d: number;
  currency: string | null;
  deadline: string;
  set_on: string;
}
interface Baseline {
  per_30d: number;
  currency: string | null;
  from: string;
  to: string;
}
interface Cause {
  category: string;
  statement: string;
  evidence: string[];
}
interface Suggestion {
  kind: string;
  title: string;
  rationale: string;
  proposal_id: string | null;
  note: string | null;
}
interface CareGoal {
  goal_id: string;
  statement: string | null;
  horizon: string | null;
  area: string | null;
  measurable: boolean;
  measure: Measure | null;
  baseline: Baseline | null;
  latest_check: { at: string; detail: string; verdict: string; alert?: boolean } | null;
  review: {
    at: string;
    outcome: string;
    review: { summary: string; causes: Cause[]; suggestions: Suggestion[] } | null;
    with_a_person: boolean;
    escalation_reason: string | null;
  } | null;
}
interface CareView {
  care: { day_zero: string; watch_ends_at: string | null } | null;
  goals: CareGoal[];
}

const METRIC_WORD: Record<Measure["metric"], string> = {
  revenue: "revenue",
  orders: "number of sales",
  sessions: "website visits",
};

const WORD: Record<GoalWord | "unchecked" | "unmeasurable", { text: string; cls: string }> = {
  reached: { text: "Reached", cls: "ok" },
  on_path: { text: "On path", cls: "ok" },
  behind: { text: "Behind path", cls: "drift" },
  off_path: { text: "Off path", cls: "alarm" },
  too_early: { text: "Too early", cls: "low" },
  unmeasured: { text: "Not measured", cls: "low" },
  unchecked: { text: "Not checked yet", cls: "low" },
  unmeasurable: { text: "Not measurable", cls: "low" },
};

const CAUSE_WORD: Record<string, string> = {
  our_advice_was_wrong: "Our advice was wrong",
  goal_unrealistic: "The goal asks too much for the time",
  owner_declined_key_actions: "Key steps were declined",
  approved_actions_not_executed: "Approved steps never ran",
  execution_failed: "Something failed when it ran",
  data_incomplete: "We're missing data",
  external_change: "Something outside changed",
  other: "Something else",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree. */
function dayText(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A per-30-days figure: whole currency units, or a whole count. */
function per30(value: number, currency: string | null): string {
  if (currency === null) return num(Math.round(value));
  const exp = minorUnitExponent(currency);
  return moneyText(Math.round(value / 10 ** exp) * 10 ** exp, currency);
}

function MeasureForm({ goal, onSaved }: { goal: CareGoal; onSaved: () => Promise<void> }) {
  const [metric, setMetric] = useState<Measure["metric"]>("revenue");
  const [direction, setDirection] = useState<Measure["direction"]>("increase");
  const [target, setTarget] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    const value = Number(target.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return setMessage("Enter a target above zero.");
    const cur = currency.trim().toUpperCase();
    const target_per_30d =
      metric === "revenue" ? Math.round(value * 10 ** minorUnitExponent(cur)) : Math.round(value);
    setBusy(true);
    setMessage(null);
    const res = await fetch("/api/goals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        goal_id: goal.goal_id,
        measure: {
          metric,
          direction,
          target_per_30d,
          currency: metric === "revenue" ? cur : null,
          deadline: deadline || null,
        },
      }),
    });
    const body = (await res.json()) as { error?: string; baseline_note?: string | null };
    setBusy(false);
    if (!res.ok) return setMessage(body.error ?? "That didn't save.");
    if (body.baseline_note) setMessage(`Saved. No starting value yet: ${body.baseline_note}.`);
    await onSaved();
  };

  return (
    <form
      className="gl-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <select
        aria-label="raise or lower"
        value={direction}
        onChange={(e) => setDirection(e.target.value as Measure["direction"])}
      >
        <option value="increase">Raise</option>
        <option value="decrease">Lower</option>
      </select>
      <select
        aria-label="what to measure"
        value={metric}
        onChange={(e) => setMetric(e.target.value as Measure["metric"])}
      >
        <option value="revenue">revenue</option>
        <option value="orders">number of sales</option>
        <option value="sessions">website visits</option>
      </select>
      <span className="gl-word">to</span>
      <input
        aria-label="target"
        style={{ width: 120 }}
        inputMode="decimal"
        placeholder={metric === "revenue" ? "3600" : "120"}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      />
      {metric === "revenue" && (
        <input
          aria-label="currency"
          style={{ width: 70 }}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        />
      )}
      <span className="gl-word">per 30 days, by</span>
      <input
        type="date"
        aria-label="deadline"
        value={deadline}
        onChange={(e) => setDeadline(e.target.value)}
      />
      <button className="act" disabled={busy || target.trim() === ""}>
        Make it measurable
      </button>
      {message && <p className="gl-note">{message}</p>}
      {!deadline && goal.horizon && (
        <p className="gl-note">Leave the date empty and the goal&apos;s own horizon sets it.</p>
      )}
    </form>
  );
}

function Review({ review }: { review: NonNullable<CareGoal["review"]> }) {
  return (
    <div className="gl-review">
      <h3>
        Alert review · {dayText(review.at)}
        {review.with_a_person && " · a person at Ledgerline has this now"}
      </h3>
      {review.with_a_person && (
        <p>
          The automatic review has done what it can
          {review.escalation_reason ? ` (${review.escalation_reason})` : ""}. Someone from our team
          is looking at this goal and will be in touch.
        </p>
      )}
      {review.review?.summary && <p>{review.review.summary}</p>}
      {review.review && review.review.causes.length > 0 && (
        <ul>
          {review.review.causes.map((c) => (
            <li key={`${c.category}-${c.statement}`}>
              <strong>{CAUSE_WORD[c.category] ?? c.category}:</strong> {c.statement} (
              {c.evidence.length} piece{c.evidence.length === 1 ? "" : "s"} of evidence)
            </li>
          ))}
        </ul>
      )}
      {review.review && review.review.suggestions.length > 0 && (
        <ul>
          {review.review.suggestions.map((s) => (
            <li key={`${s.kind}-${s.title}`}>
              {s.title}
              {s.proposal_id
                ? ` — waiting for you${s.note ? ` (${s.note})` : ""}`
                : ` — ${s.note ?? "yours to decide"}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function footFor(goal: CareGoal, chart: GoalChart | undefined): { text: string; link: ReactNode } {
  const waiting = goal.review?.review?.suggestions.some((s) => s.proposal_id !== null);
  const link = waiting ? (
    <Link href="/proposals">Waiting for you</Link>
  ) : chart?.unconnected ? (
    <Link href="/connections">Connections</Link>
  ) : (
    <Link href="/history">History</Link>
  );
  if (goal.latest_check) return { text: goal.latest_check.detail, link };
  if (chart?.unconnected) {
    return {
      text: `No connection measures ${METRIC_WORD[goal.measure!.metric]} yet. Connect one and its history fills the chart and the starting point.`,
      link,
    };
  }
  return { text: "Not checked yet. The weekly check reads every measurable goal on Monday.", link };
}

function GoalCard({
  goal,
  chart,
  onSaved,
}: {
  goal: CareGoal;
  chart: GoalChart | undefined;
  onSaved: () => Promise<void>;
}) {
  const m = goal.measure;
  const label = m
    ? `${METRIC_WORD[m.metric]} · by ${dayText(m.deadline)}`
    : goal.area
      ? goal.area.replace(/_/g, " ")
      : "Goal";
  const word = !m ? WORD.unmeasurable : WORD[goalWord(goal.latest_check?.verdict) ?? "unchecked"];

  if (!m) {
    return (
      <SheetCard
        className="gl-card"
        id={`goal-${goal.goal_id}`}
        label={label}
        title={goal.statement ?? "A goal without words yet"}
        meta={<span className={`word ${word.cls}`}>{word.text}</span>}
      >
        <p className="gl-copy">
          This goal isn&apos;t measurable yet, so I can&apos;t tell you whether it&apos;s on its
          path. Name the number it should move:
        </p>
        <MeasureForm goal={goal} onSaved={onSaved} />
      </SheetCard>
    );
  }

  const foot = footFor(goal, chart);
  const nowValue = chart?.now?.per_30d ?? null;
  const pathValue = chart?.path_now_per_30d ?? null;
  return (
    <SheetCard
      className="gl-card"
      id={`goal-${goal.goal_id}`}
      label={label}
      title={
        goal.statement ??
        `${m.direction === "increase" ? "Raise" : "Lower"} ${METRIC_WORD[m.metric]}`
      }
      meta={<span className={`word ${word.cls}`}>{word.text}</span>}
      foot={
        <div className="gl-foot">
          <p>{foot.text}</p>
          {foot.link}
        </div>
      }
    >
      <dl className="gl-stats">
        <div className="gl-now">
          <dt>Now</dt>
          <dd>{nowValue === null ? "—" : per30(nowValue, m.currency)}</dd>
        </div>
        <div>
          <dt>Path says</dt>
          <dd>{pathValue === null ? "—" : per30(pathValue, m.currency)}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{per30(m.target_per_30d, m.currency)}</dd>
        </div>
      </dl>
      <p className="gl-per">
        per 30 days · now = the last 28 days
        {chart?.now ? ` (${chart.now.days_measured} measured)` : ""}
        {goal.baseline
          ? ` · started at ${per30(goal.baseline.per_30d, m.currency)} on ${dayText(m.set_on)}`
          : " · no measured starting point yet, so no path"}
      </p>
      {chart ? (
        <CandleChart chart={chart} label={METRIC_WORD[m.metric]} />
      ) : (
        <div className="gl-chart">
          <p className="gl-nochart">The chart couldn&apos;t be read just now.</p>
        </div>
      )}
      {goal.review && <Review review={goal.review} />}
    </SheetCard>
  );
}

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="screen gl-screen">
      <PageHead kicker="Insights · Goals" title={title} aside={aside} />
      {children}
    </main>
  );
}

export function ProgressScreen({ charts }: { charts: GoalChart[] | null }) {
  const router = useRouter();
  const [view, setView] = useState<CareView | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/care");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setView((await res.json()) as CareView);
    } catch {
      setFailed("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="gl-wait">
          <Link href="/intake">Start with the interview</Link>, then set the goals it should move.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Your goals didn't load.">
        <p className="gl-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) {
    return <Frame title="Reading your goals…" />;
  }

  const n = view.goals.length;
  const checked = view.goals.filter((g) => g.latest_check !== null);
  const on = checked.filter((g) => onPath(g.latest_check?.verdict)).length;
  const goalsWord = `${n} goal${n === 1 ? "" : "s"}.`;
  const title =
    n === 0
      ? "No goals yet."
      : checked.length === 0
        ? `${goalsWord} None checked against a path yet.`
        : on === 0
          ? `${goalsWord} None on its path.`
          : `${goalsWord} ${on} on ${on === 1 ? "its" : "their"} path.`;

  const aside = (
    <div className="gl-aside">
      {n > 0 && <span>1 candle = 1 week · blue line = the path to your target</span>}
      <Link className="act" href="/content">
        {n === 0 ? "Set a goal →" : "Set a new goal →"}
      </Link>
    </div>
  );

  const byGoal = new Map((charts ?? []).map((c) => [c.goal_id, c]));
  return (
    <Frame title={title} aside={aside}>
      {n === 0 ? (
        <SheetCard label="How goals work" title="State one goal, in your own words">
          <p className="gl-copy">
            Goals are set on Content, where every planned piece names the goal it serves. Make one
            measurable (revenue, number of sales or website visits, by a date) and each week it is
            checked against a straight path from where it started to where you want it. Nothing is
            judged in the first eight weeks or while I&apos;m still watching.
          </p>
        </SheetCard>
      ) : (
        <div className="gl-grid">
          {view.goals.map((g) => (
            <GoalCard
              key={g.goal_id}
              goal={g}
              chart={byGoal.get(g.goal_id)}
              onSaved={async () => {
                await load();
                router.refresh(); // the charts are read on the server
              }}
            />
          ))}
        </div>
      )}
    </Frame>
  );
}
