"use client";

// Insights · Goals — the owner's Goals design (2026-10-17) on goal
// progress and alert mode (Session J, P3-42..47). Per goal: where the
// last 28 days put it, where the path says it should be, the target, the
// weekly candles of its measured series (read on the server, ./page), the
// latest weekly verdict with its arithmetic and — when a goal reached
// alert — what the review found and whether a person now has the case.
// A goal that can't be measured yet carries the form that makes it so.
//
// L-3b (TASKS-LANGUAGES.md): the screen's own words are the "goals"
// catalogue, its figures and dates in the reader's locale with the goal's
// own currency. The weekly check's detail and a baseline note arrive in the
// reader's language (L-4b, "goalsWords"), and a goal's area is worded from
// its code. What the alert review wrote (summary, causes, suggestions) and
// the server's refusals are shown as written — stages L-5 and L-4a.

import "../../app/goals.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { shortDate } from "../../lib/charts/model";
import { minorUnitExponent } from "../../lib/core/money";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import type { GoalChart } from "../../lib/care/charts";
import type { GoalWord } from "../../lib/care/chart-view";
import { goalWord, onPath } from "../../lib/care/chart-view";
import { CandleChart } from "./CandleChart";
import { WhyFold } from "../report/WhyFold";

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

/** A goal's metric in words ("goals.metric"): revenue, number of sales, website visits. */
const metricWord = (metric: Measure["metric"], tr: Tr) => tr(`metric.${metric}`);

/** The focus_area codes a goal's area is worded from ("goalsWords.area.<code>"); another shows as its code. */
const AREAS: ReadonlySet<string> = new Set([
  "launch",
  "first_customers",
  "increase_revenue",
  "reduce_costs",
  "automate_work",
  "improve_marketing",
  "hire_people",
  "expand_locations",
  "improve_profit",
  "other",
]);

/** A goal's area in words, from its code. */
export function areaWords(area: string, tr: Tr): string {
  return AREAS.has(area) ? tr(`area.${area}`) : area.replace(/_/g, " ");
}

/** Each verdict's tint; its word is "goals.word.<key>". */
const WORD_CLASS: Record<GoalWord | "unchecked" | "unmeasurable", string> = {
  reached: "ok",
  on_path: "ok",
  behind: "drift",
  off_path: "alarm",
  too_early: "low",
  unmeasured: "low",
  unchecked: "low",
  unmeasurable: "low",
};

/** The alert review's cause categories, each "goals.cause.<key>"; another shows as its code. */
const CAUSES: ReadonlySet<string> = new Set([
  "our_advice_was_wrong",
  "goal_unrealistic",
  "owner_declined_key_actions",
  "approved_actions_not_executed",
  "execution_failed",
  "data_incomplete",
  "external_change",
  "other",
]);

/** "26 Oct", in UTC so server and browser agree; the language's own outside English. */
function dayText(iso: string, locale: AppLocale): string {
  return shortDate(iso.slice(0, 10), locale);
}

/** A per-30-days figure: whole currency units, or a whole count. */
function per30(value: number, currency: string | null, locale: AppLocale): string {
  if (currency === null) return num(Math.round(value), 0, locale);
  const exp = minorUnitExponent(currency);
  return moneyText(Math.round(value / 10 ** exp) * 10 ** exp, currency, locale);
}

function MeasureForm({ goal, onSaved }: { goal: CareGoal; onSaved: () => Promise<void> }) {
  const { tr, locale } = useTr("goals");
  const [metric, setMetric] = useState<Measure["metric"]>("revenue");
  const [direction, setDirection] = useState<Measure["direction"]>("increase");
  const [target, setTarget] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    const value = Number(target.replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) return setMessage(tr("form.aboveZero"));
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
    if (!res.ok) return setMessage(body.error ?? tr("form.notSaved"));
    if (body.baseline_note) setMessage(tr("form.savedNoBaseline", { note: body.baseline_note }));
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
        aria-label={tr("form.directionLabel")}
        value={direction}
        onChange={(e) => setDirection(e.target.value as Measure["direction"])}
      >
        <option value="increase">{tr("form.raise")}</option>
        <option value="decrease">{tr("form.lower")}</option>
      </select>
      <select
        aria-label={tr("form.metricLabel")}
        value={metric}
        onChange={(e) => setMetric(e.target.value as Measure["metric"])}
      >
        <option value="revenue">{metricWord("revenue", tr)}</option>
        <option value="orders">{metricWord("orders", tr)}</option>
        <option value="sessions">{metricWord("sessions", tr)}</option>
      </select>
      <span className="gl-word">{tr("form.to")}</span>
      <input
        aria-label={tr("form.targetLabel")}
        style={{ width: 120 }}
        inputMode="decimal"
        placeholder={metric === "revenue" ? "3600" : "120"}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
      />
      {metric === "revenue" && (
        <input
          aria-label={tr("form.currencyLabel")}
          style={{ width: 70 }}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        />
      )}
      <span className="gl-word">{tr("form.perBy", { days: num(30, 0, locale) })}</span>
      <input
        type="date"
        aria-label={tr("form.deadlineLabel")}
        value={deadline}
        onChange={(e) => setDeadline(e.target.value)}
      />
      <button className="act" disabled={busy || target.trim() === ""}>
        {tr("form.submit")}
      </button>
      {message && <p className="gl-note">{message}</p>}
      {!deadline && goal.horizon && <p className="gl-note">{tr("form.horizon")}</p>}
    </form>
  );
}

function Review({ review }: { review: NonNullable<CareGoal["review"]> }) {
  const words = useTranslations("goals.review");
  const { tr, locale } = useTr("goals");
  const day = dayText(review.at, locale);
  return (
    <div className="gl-review">
      <h3>{tr(review.with_a_person ? "review.headPerson" : "review.head", { day })}</h3>
      {review.with_a_person && (
        <p>
          {review.escalation_reason
            ? tr("review.escalatedWhy", { reason: review.escalation_reason })
            : tr("review.escalated")}
        </p>
      )}
      {review.review?.summary && <p>{review.review.summary}</p>}
      {review.review && review.review.causes.length > 0 && (
        <ul>
          {review.review.causes.map((c) => (
            <li key={`${c.category}-${c.statement}`}>
              {words.rich("cause", {
                cause: CAUSES.has(c.category) ? tr(`cause.${c.category}`) : c.category,
                statement: c.statement,
                count: c.evidence.length,
                strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
              })}
            </li>
          ))}
        </ul>
      )}
      {review.review && review.review.suggestions.length > 0 && (
        <ul>
          {review.review.suggestions.map((s) => (
            <li key={`${s.kind}-${s.title}`}>
              {s.proposal_id
                ? s.note
                  ? tr("review.waitingNote", { title: s.title, note: s.note })
                  : tr("review.waiting", { title: s.title })
                : s.note !== null
                  ? `${s.title} — ${s.note}`
                  : tr("review.yours", { title: s.title })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function footFor(
  goal: CareGoal,
  chart: GoalChart | undefined,
  tr: Tr,
): { text: string; link: ReactNode } {
  const waiting = goal.review?.review?.suggestions.some((s) => s.proposal_id !== null);
  const link = waiting ? (
    <Link href="/proposals">{tr("foot.waiting")}</Link>
  ) : chart?.unconnected ? (
    <Link href="/connections">{tr("foot.connections")}</Link>
  ) : (
    <Link href="/history">{tr("foot.history")}</Link>
  );
  if (goal.latest_check) return { text: goal.latest_check.detail, link };
  if (chart?.unconnected) {
    return {
      text: tr("foot.unconnected", { metric: metricWord(goal.measure!.metric, tr) }),
      link,
    };
  }
  return { text: tr("foot.unchecked"), link };
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
  const { tr, locale } = useTr("goals");
  const { tr: goalTr } = useTr("goalsWords");
  const m = goal.measure;
  const label = m
    ? tr("card.label", { metric: metricWord(m.metric, tr), day: dayText(m.deadline, locale) })
    : goal.area
      ? areaWords(goal.area, goalTr)
      : tr("card.goal");
  const wordKey = !m ? "unmeasurable" : (goalWord(goal.latest_check?.verdict) ?? "unchecked");
  const word = { text: tr(`word.${wordKey}`), cls: WORD_CLASS[wordKey] };

  if (!m) {
    return (
      <SheetCard
        className="gl-card"
        id={`goal-${goal.goal_id}`}
        label={label}
        title={goal.statement ?? tr("card.untitled")}
        meta={<span className={`word ${word.cls}`}>{word.text}</span>}
      >
        <p className="gl-copy">{tr("card.notMeasurable")}</p>
        <MeasureForm goal={goal} onSaved={onSaved} />
      </SheetCard>
    );
  }

  const foot = footFor(goal, chart, tr);
  const nowValue = chart?.now?.per_30d ?? null;
  const pathValue = chart?.path_now_per_30d ?? null;
  return (
    <SheetCard
      className="gl-card"
      id={`goal-${goal.goal_id}`}
      label={label}
      title={
        goal.statement ??
        tr(m.direction === "increase" ? "card.raise" : "card.lower", {
          metric: metricWord(m.metric, tr),
        })
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
          <dt>{tr("card.now")}</dt>
          <dd>{nowValue === null ? "—" : per30(nowValue, m.currency, locale)}</dd>
        </div>
        <div>
          <dt>{tr("card.pathSays")}</dt>
          <dd>{pathValue === null ? "—" : per30(pathValue, m.currency, locale)}</dd>
        </div>
        <div>
          <dt>{tr("card.target")}</dt>
          <dd>{per30(m.target_per_30d, m.currency, locale)}</dd>
        </div>
      </dl>
      <p className="gl-per">
        {tr("card.per", { days: num(30, 0, locale), recent: num(28, 0, locale) })}
        {chart?.now
          ? ` ${tr("card.measured", { count: num(chart.now.days_measured, 0, locale) })}`
          : ""}
        {` · ${
          goal.baseline
            ? tr("card.startedAt", {
                value: per30(goal.baseline.per_30d, m.currency, locale),
                day: dayText(m.set_on, locale),
              })
            : tr("card.noStart")
        }`}
      </p>
      {chart ? (
        <CandleChart chart={chart} label={metricWord(m.metric, tr)} />
      ) : (
        <div className="gl-chart">
          <p className="gl-nochart">{tr("card.chartFailed")}</p>
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
  const { tr } = useTr("goals");
  return (
    <main className="screen gl-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
    </main>
  );
}

export function ProgressScreen({ charts }: { charts: GoalChart[] | null }) {
  const words = useTranslations("goals.frame");
  const { tr, locale } = useTr("goals");
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
      <Frame title={tr("frame.signedOutTitle")}>
        <p className="gl-wait">
          {words.rich("signedOut", {
            link: (chunks: ReactNode) => <Link href="/intake">{chunks}</Link>,
          })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("frame.failedTitle")}>
        <p className="gl-wait">{tr("frame.failed")}</p>
      </Frame>
    );
  }
  if (!view) {
    return <Frame title={tr("frame.reading")} />;
  }

  const n = view.goals.length;
  // A check that says "too early" or "can't measure yet" hasn't judged the
  // goal against its path: counting it made "none on its path" sound like
  // every goal was failing on the day the watch began.
  const checked = view.goals.filter(
    (g) =>
      g.latest_check !== null &&
      g.latest_check.verdict !== "too_early" &&
      g.latest_check.verdict !== "unmeasured",
  );
  const on = checked.filter((g) => onPath(g.latest_check?.verdict)).length;
  const goals = tr("title.count", { count: n });
  const title =
    n === 0
      ? tr("title.none")
      : checked.length === 0
        ? tr("title.noneChecked", { goals })
        : on === 0
          ? tr("title.noneOn", { goals })
          : tr("title.someOn", { goals, count: on });

  const aside = (
    <div className="gl-aside">
      {n > 0 && <span>{tr("aside", { one: num(1, 0, locale) })}</span>}
      <Link className="act" href="/content">
        {n === 0 ? tr("setFirst") : tr("setNew")}
      </Link>
    </div>
  );

  const byGoal = new Map((charts ?? []).map((c) => [c.goal_id, c]));
  return (
    <Frame title={title} aside={aside}>
      {n === 0 ? (
        <SheetCard>
          <WhyFold summary={tr("how.label")}>{tr("how.copy")}</WhyFold>
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
