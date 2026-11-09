"use client";

// How I work — the mode decision (Session H, P1-43; the owner's How-I-work
// design, 2026-10-17). Two cards, Mode A (watch first) and Mode B (act
// right away), the current one on paper and marked CURRENT; under them
// the stored reasons, verbatim — the owner sees a rule, not an opinion —
// and what never changes in either mode. Extending the watch is one click
// here; shortening is not on this screen at all (P1-44 buries it behind
// an acknowledgement), and switching modes is not a feature: the rule
// decides it from the profile.
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "mode"
// catalogue; dates and counts in the reader's locale. The stored reasons
// and the rule's reasoning are its own record, shown as they are (L-4).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useBusinessNoun } from "../nav/useBusinessNoun";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import { WhyFold } from "../report/WhyFold";
import type { ModeDecision } from "./mode-view";
import { chosenLine, dayMonth, headline, humanise, parseTs, watchDay } from "./mode-view";
import "../../app/mode.css";

type State =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "none" }
  | { phase: "deferred"; reasoning: string }
  | { phase: "ready"; decision: ModeDecision; extending: boolean };

export function ModeScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  const businessNoun = useBusinessNoun();
  const { tr, locale } = useTr("mode");
  const t = useTranslations("mode");
  const KICKER = tr("kicker");
  // "your salon" is English's noun table; other languages say "your business".
  const noun = locale === "en" ? businessNoun : tr("yourBusiness");

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
          <Link className="next" href="/intake">
            {tr("deferred.answer")} <span aria-hidden="true">→</span>
          </Link>
        </SheetCard>
      </main>
    );
  }

  const { decision } = state;
  const watching = decision.mode === "watching";
  const weeks = decision.watch_weeks;
  const day = watchDay(decision, Date.now());
  const ends = parseTs(decision.review_at);

  const modeA = (
    <section
      className={`md-mode${watching ? " current" : ""}`}
      aria-labelledby="md-a"
      aria-current={watching ? "true" : undefined}
    >
      <p className="md-mode-label">
        <span>{tr("a.label")}</span>
        {watching && <span className="md-current">{tr("current")}</span>}
      </p>
      <h2 className="md-mode-title" id="md-a">
        {tr("a.title")}
      </h2>
      {watching && weeks !== null ? (
        <>
          <p className="md-mode-copy">{tr("a.copyWatching", { days: weeks * 7, noun })}</p>
          <p className="md-mode-lines">
            {day && (
              <>
                {tr("a.day", { day: day.day, of: day.of, date: dayMonth(ends, locale) })}
                <br />
              </>
            )}
            {tr("a.firstRead")}
          </p>
          <div className="md-mode-acts">
            <Link className="next" href="/watch">
              {tr("a.openWatching")} <span aria-hidden="true">→</span>
            </Link>
            {weeks !== 8 && (
              <button
                type="button"
                className="ghost"
                disabled={state.extending}
                onClick={() => void extend()}
              >
                {state.extending ? tr("a.extending") : tr("a.extend", { days: 8 * 7 })}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <p className="md-mode-copy">{tr("a.copyIdle")}</p>
          <p className="md-mode-lines">{tr("a.chosenWith", { sales: 10, months: 3 })}</p>
        </>
      )}
    </section>
  );

  const modeB = (
    <section
      className={`md-mode${!watching ? " current" : ""}`}
      aria-labelledby="md-b"
      aria-current={!watching ? "true" : undefined}
    >
      <p className="md-mode-label">
        <span>{tr("b.label")}</span>
        {!watching && <span className="md-current">{tr("current")}</span>}
      </p>
      <h2 className="md-mode-title" id="md-b">
        {tr("b.title")}
      </h2>
      {!watching ? (
        <>
          <p className="md-mode-copy">{decision.reasoning}</p>
          <p className="md-mode-lines">
            {tr("b.started", { date: dayMonth(parseTs(decision.decided_at), locale) })}
          </p>
          <div className="md-mode-acts">
            <Link className="next" href="/report">
              {tr("b.seeFirstRead")} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="md-mode-copy">{tr("b.copyIdle")}</p>
          <p className="md-mode-lines">{tr("b.onlyUnder", { sales: 10, months: 3 })}</p>
        </>
      )}
    </section>
  );

  return (
    <main className="screen md-screen">
      <PageHead
        kicker={KICKER}
        title={headline(decision, tr)}
        aside={chosenLine(decision, tr, locale)}
      />

      <div className="md-grid">
        {modeA}
        {modeB}

        <SheetCard
          className="md-why"
          label={watching ? tr("why.labelWatching") : tr("why.labelInstant")}
          title={watching ? tr("why.titleWatching") : tr("why.titleInstant")}
        >
          {decision.reasons.length > 0 ? (
            <ul className="md-reasons">
              {decision.reasons.map((reason) => (
                <li key={reason}>{humanise(reason)}</li>
              ))}
            </ul>
          ) : (
            <p className="md-copy">{tr("why.none")}</p>
          )}
        </SheetCard>

        <SheetCard className="md-never" label={tr("never.label")} title={tr("never.title")}>
          <ol className="md-rules">
            <li>
              <span className="md-n" aria-hidden="true">
                01
              </span>
              <span>{tr("never.one")}</span>
            </li>
            <li>
              <span className="md-n" aria-hidden="true">
                02
              </span>
              <span>
                {t.rich("never.two", {
                  link: (chunks) => <Link href="/proposals">{chunks}</Link>,
                })}
              </span>
            </li>
            <li>
              <span className="md-n" aria-hidden="true">
                03
              </span>
              <span>{tr("never.three")}</span>
            </li>
          </ol>
        </SheetCard>
      </div>
    </main>
  );
}
