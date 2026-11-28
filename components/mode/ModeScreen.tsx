"use client";

// How Lex works (was How I work) — the mode decision (Session H, P1-43; the
// owner's How-I-work design, 2026-10-17), said plainly on 2026-11-23 from
// the canvas design the owner approved. The title says how Lex starts here;
// one card says where things stand (the day, the dates, the owner's own
// note when they changed the length, and the one-click extend); then why,
// worded from the inputs the rule stored, each reason once, with one
// sentence on the other way to start; then what is always true. Extending
// the watch is one click here; shortening is not on this screen at all
// (P1-44 buries it behind an acknowledgement), and switching modes is not
// a feature: the rule decides it from the profile.
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "mode"
// catalogue; dates and counts in the reader's locale. The reasons are said
// from the decision's stored inputs (components/mode/mode-view
// plainReasons); a decision stored without inputs shows its stored reasons.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import { WhyFold } from "../report/WhyFold";
import type { ModeDecision } from "./mode-view";
import { dayMonth, humanise, overrideLine, parseTs, plainReasons, title } from "./mode-view";
import { watchDays } from "../../lib/watch/watch-view";
import "../../app/mode.css";

/** A YYYY-MM-DD calendar day as an instant at its middle, for dayMonth. */
const dayAt = (ymd: string): number => Date.parse(`${ymd}T12:00:00Z`);

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "none" }
  | { phase: "deferred"; reasoning: string }
  | { phase: "ready"; decision: ModeDecision; extending: boolean };

export function ModeScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const { tr, locale } = useTr("mode");
  const t = useTranslations("mode");
  const KICKER = tr("kicker");

  const load = useCallback(async () => {
    const res = await fetch("/api/mode");
    if (res.status === 401) return setState({ phase: "signedout" });
    const j = (await res.json().catch(() => ({}))) as ModeDecision & { none?: boolean };
    if (!res.ok || j.none) return setState({ phase: "none" });
    setState({ phase: "ready", decision: j, extending: false });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async () => {
    setState({ phase: "loading" });
    const res = await fetch("/api/mode", { method: "POST" });
    const j = (await res.json().catch(() => ({}))) as {
      kind?: string;
      decision?: ModeDecision;
      reasoning?: string;
    };
    if (j.kind === "deferred") {
      setState({ phase: "deferred", reasoning: j.reasoning ?? "" });
    } else if (j.kind === "decided" && j.decision) {
      setState({ phase: "ready", decision: j.decision, extending: false });
    } else {
      setState({ phase: "none" });
    }
  };

  const extend = async () => {
    if (state.phase !== "ready") return;
    setState({ ...state, extending: true });
    await fetch("/api/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_weeks: 8 }),
    });
    await load();
  };

  if (state.phase === "loading") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title={tr("loading.title")} />
        <p className="md-wait">{tr("loading.copy")}</p>
      </main>
    );
  }

  if (state.phase === "signedout") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title={tr("signedOut.title")} />
        <SheetCard label={tr("signedOut.label")}>
          <Link className="next" href="/login">
            {tr("signedOut.signIn")} <span aria-hidden="true">→</span>
          </Link>
        </SheetCard>
      </main>
    );
  }

  if (state.phase === "none") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title={tr("none.title")} />
        <SheetCard label={tr("none.label")} title={tr("none.sheetTitle")}>
          <WhyFold className="md-fold">{tr("none.copy")}</WhyFold>
          <button type="button" className="next" onClick={() => void decide()}>
            {tr("none.decide")} <span aria-hidden="true">→</span>
          </button>
        </SheetCard>
      </main>
    );
  }

  if (state.phase === "deferred") {
    return (
      <main className="screen md-screen">
        <PageHead kicker={KICKER} title={tr("none.title")} />
        <SheetCard label={tr("deferred.label")} title={tr("deferred.sheetTitle")}>
          <p className="md-copy">{state.reasoning}</p>
          <Link className="next" href="/start">
            {tr("deferred.answer")} <span aria-hidden="true">→</span>
          </Link>
        </SheetCard>
      </main>
    );
  }

  const { decision } = state;
  const watching = decision.mode === "watching";
  const weeks = decision.watch_weeks;
  // The same days Watching counts (lib/watch/watch-view), so both pages agree.
  const w = watchDays(decision, new Date());
  const day = w ? { day: w.day, of: w.of } : null;
  const span = w ? { start: dayAt(w.start), end: dayAt(w.end) } : null;
  const over = w !== null && w.days_remaining === 0;
  const override = decision.owner_override ?? null;
  const said = overrideLine(decision, tr);
  const reasons = plainReasons(decision);

  const stand = watching ? (
    <section className="md-stand" aria-label={tr("stand.label")}>
      <p className="md-stand-head">
        <b>
          {over
            ? tr("stand.done")
            : day
              ? tr("stand.day", { day: day.day, of: day.of })
              : tr("stand.watching")}
        </b>
        {span && (
          <span>
            {tr(over ? "stand.spanDone" : "stand.span", {
              start: dayMonth(span.start, locale),
              end: dayMonth(span.end, locale),
            })}
          </span>
        )}
      </p>
      {day && (
        <span className="md-bar" aria-hidden="true">
          <span style={{ width: `${over ? 100 : Math.round((day.day / day.of) * 100)}%` }} />
        </span>
      )}
      {override?.acknowledgement?.text && (
        <blockquote className="md-note">
          <p className="md-note-label">
            {tr("stand.note", {
              kind: override.kind,
              date: dayMonth(parseTs(override.acknowledgement.at ?? override.at), locale),
            })}
          </p>
          {tr("quoted", { text: override.acknowledgement.text })}
        </blockquote>
      )}
      <div className="md-acts">
        <Link className="next" href="/watch">
          {tr("stand.seeWatching")} <span aria-hidden="true">→</span>
        </Link>
        {weeks !== 8 && !over && (
          <button
            type="button"
            className="ghost"
            disabled={state.extending}
            onClick={() => void extend()}
          >
            {state.extending ? tr("stand.extending") : tr("stand.extend", { count: 8 })}
          </button>
        )}
      </div>
    </section>
  ) : (
    <section className="md-stand" aria-label={tr("stand.label")}>
      <p className="md-stand-head">
        <b>{tr("stand.started", { date: dayMonth(parseTs(decision.decided_at), locale) })}</b>
      </p>
      <div className="md-acts">
        <Link className="next" href="/report">
          {tr("stand.seeReport")} <span aria-hidden="true">→</span>
        </Link>
      </div>
    </section>
  );

  return (
    <main className="screen md-screen">
      <PageHead kicker={KICKER} title={title(decision, tr)}>
        <p className="md-lede">
          {tr(watching ? "lede.watching" : "lede.instant")}
          {said && <> {said}</>}
        </p>
      </PageHead>

      {stand}

      <div className="md-grid">
        <SheetCard title={watching ? tr("why.watching") : tr("why.instant")}>
          {reasons !== null ? (
            <ul className="md-reasons">
              {reasons.map((r) => (
                <li key={r.key}>{tr(`reason.${r.key}`, r.values)}</li>
              ))}
            </ul>
          ) : decision.reasons.length > 0 ? (
            <ul className="md-reasons">
              {decision.reasons.map((reason) => (
                <li key={reason}>{humanise(reason)}</li>
              ))}
            </ul>
          ) : (
            <p className="md-copy">{tr("why.none")}</p>
          )}
          <p className="md-other">
            {watching ? tr("other.instant", { sales: 10, months: 3 }) : tr("other.watching")}
          </p>
        </SheetCard>

        <SheetCard title={tr("always.title")}>
          <ul className="md-always">
            <li>
              {t.rich("always.yes", {
                link: (chunks) => <Link href="/ladder">{chunks}</Link>,
              })}
            </li>
            <li>{t.rich("always.stop", { b: (chunks) => <b>{chunks}</b> })}</li>
            <li>{tr("always.limits")}</li>
          </ul>
        </SheetCard>
      </div>
    </main>
  );
}
