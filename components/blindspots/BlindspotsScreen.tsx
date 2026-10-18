"use client";

// Insights · Blindspots — the owner's Blindspots design (2026-10-17) on
// Phase 2 Session G (P2-32..37). What potential customers asked and
// searched for, against what the business's own site shows them. Every
// row names its counts and its sources; what isn't connected or checked
// is said, not hidden. Read-only: a fix goes through the approval queue.

import "../../app/blindspots.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";

interface Demand {
  support_asked: number;
  support_unanswered: number;
  site_searches: number;
  google_impressions: number;
  google_clicks: number;
}
interface Blindspot {
  code: string;
  label: string;
  sources: number;
  competitors_showing: number;
  competitors_checked: number;
  arithmetic: string;
  fix: string;
  demand: Demand;
}
interface View {
  window: { from: string; to: string };
  site_checked_at: string | null;
  site_note: string | null;
  blindspots: Blindspot[];
  hard_to_find: { code: string; label: string; page: string; asked: number }[];
  seen_not_chosen: { query: string; impressions: number; clicks: number; position: number }[];
  topics: { label: string; count: number; examples: string[] }[];
  coverage: string[];
}

/** How the site re-check works (app/api/blindspots: RECHECK_DAYS). */
const RECHECK_DAYS = 30;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree. */
function dayText(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Times a customer asked or searched — the demand the site left unmet. */
export function asked(d: Demand): number {
  return d.support_asked + d.support_unanswered + d.site_searches;
}

function whereFrom(b: Blindspot): string {
  const parts: string[] = [];
  if (b.demand.support_asked + b.demand.support_unanswered > 0) parts.push("support chat");
  if (b.demand.site_searches > 0) parts.push("site search");
  if (b.demand.google_impressions > 0) parts.push("Google");
  if (b.competitors_showing > 0)
    parts.push(`${b.competitors_showing} of ${b.competitors_checked} competitors`);
  return parts.join(" · ");
}

function headline(view: View): string {
  const n = view.blindspots.length;
  if (n === 0) {
    if (!view.site_checked_at) {
      return view.site_note === "no website in the profile"
        ? "There's no website in your profile yet."
        : "Your website hasn't been read yet.";
    }
    return "Nothing customers look for is missing from your site.";
  }
  const searches = view.blindspots.reduce((s, b) => s + b.demand.site_searches, 0);
  const questions = view.blindspots.reduce(
    (s, b) => s + b.demand.support_asked + b.demand.support_unanswered,
    0,
  );
  if (searches + questions === 0) {
    return `${n} thing${n === 1 ? "" : "s"} customers look for ${n === 1 ? "isn't" : "aren't"} on your site.`;
  }
  const what =
    searches > 0 && questions > 0
      ? "searches and questions"
      : searches > 0
        ? searches === 1
          ? "search"
          : "searches"
        : questions === 1
          ? "question"
          : "questions";
  return `${num(searches + questions)} ${what} found nothing on your site.`;
}

function BlindspotTable({ list }: { list: Blindspot[] }) {
  const max = Math.max(1, ...list.map((b) => asked(b.demand)));
  return (
    <div className="bs-table-wrap" tabIndex={0} aria-label="Blindspots table">
      <table className="rt bs-table">
        <thead>
          <tr>
            <th scope="col">They looked for</th>
            <th scope="col" className="num">
              Times
            </th>
            <th scope="col">
              <span className="sr-only">Share of the biggest</span>
            </th>
            <th scope="col">Where it came up</th>
            <th scope="col">On your site</th>
          </tr>
        </thead>
        <tbody>
          {list.map((b) => {
            const times = asked(b.demand);
            return (
              <tr key={b.code}>
                <th scope="row">&ldquo;{b.label}&rdquo;</th>
                <td className="num">{times > 0 ? num(times) : "—"}</td>
                <td className="bs-barcell">
                  <span className="bs-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((times / max) * 100)}%` }} />
                  </span>
                </td>
                <td className="src">{whereFrom(b)}</td>
                <td>
                  <span className="word alarm">Not found</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Biggest({ b }: { b: Blindspot }) {
  const d = b.demand;
  const support = d.support_asked + d.support_unanswered;
  return (
    <SheetCard
      label={`Biggest blindspot · ${num(asked(d))} times`}
      title={`“${b.label}” isn't on your site`}
    >
      <dl className="bs-sources">
        <div>
          <dt>Support chat</dt>
          <dd className={support === 0 ? "none" : undefined}>
            {support === 0 ? "not asked" : num(support)}
            {d.support_unanswered > 0 && <small>{num(d.support_unanswered)} left unanswered</small>}
          </dd>
        </div>
        <div>
          <dt>Site search</dt>
          <dd className={d.site_searches === 0 ? "none" : undefined}>
            {d.site_searches === 0 ? "not searched" : num(d.site_searches)}
          </dd>
        </div>
        <div>
          <dt>Google</dt>
          <dd className={d.google_impressions === 0 ? "none" : undefined}>
            {d.google_impressions === 0 ? "not seen" : num(d.google_impressions)}
            {d.google_impressions > 0 && <small>impressions · {num(d.google_clicks)} clicks</small>}
          </dd>
        </div>
        <div>
          <dt>Competitors</dt>
          <dd className={b.competitors_checked === 0 ? "none" : undefined}>
            {b.competitors_checked === 0
              ? "none checked"
              : `${b.competitors_showing} of ${b.competitors_checked}`}
            {b.competitors_checked > 0 && <small>show it on their site</small>}
          </dd>
        </div>
      </dl>
      <p className="bs-copy">
        {b.arithmetic.charAt(0).toUpperCase() + b.arithmetic.slice(1)}. To fix: {b.fix}.
      </p>
    </SheetCard>
  );
}

function HowFixed({ fix }: { fix: string | null }) {
  return (
    <SheetCard
      label="How blindspots get fixed"
      title="With your approval, never on their own"
      foot={
        <span className="bs-foot-row">
          <span>Website changes wait in Website.</span>
          <Link className="act" href="/site">
            Review on Website →
          </Link>
        </span>
      }
    >
      <ol className="bs-steps">
        <li>
          <span className="n">01</span>
          <span>
            A fix is{" "}
            {fix ??
              "a website change through the approval queue, or an answer in your support assistant"}
            .
          </span>
        </li>
        <li>
          <span className="n">02</span>
          <span>
            Nothing changes on its own: a fix waits in &ldquo;Waiting for you&rdquo; until you
            approve it.
          </span>
        </li>
        <li>
          <span className="n">03</span>
          <span>
            Your site is read again every {RECHECK_DAYS} days, so a blindspot it now shows drops off
            this list.
          </span>
        </li>
      </ol>
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
    <main className="screen bs-screen">
      <PageHead kicker="Insights · Blindspots" title={title} aside={aside} />
      {children}
    </main>
  );
}

export function BlindspotsScreen() {
  const [view, setView] = useState<View | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/blindspots");
        if (res.status === 401) return setFailed("signed_out");
        if (!res.ok) return setFailed("error");
        setView((await res.json()) as View);
      } catch {
        setFailed("error");
      }
    })();
  }, []);

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="bs-wait">
          <Link href="/intake">Start with the interview</Link>, and your site is read from it.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="Blindspots didn't load.">
        <p className="bs-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!view) {
    return <Frame title="Reading what customers look for…" />;
  }

  const list = view.blindspots;
  const top = list[0];
  const aside = (
    <>
      Last 90 days · {dayText(view.window.from)} to {dayText(view.window.to)}
      {view.site_checked_at
        ? ` · site read ${dayText(view.site_checked_at)}`
        : " · site not read"}{" "}
      · OBSERVED
    </>
  );

  return (
    <Frame title={headline(view)} aside={aside}>
      {list.length > 0 ? (
        <SheetCard
          label="What customers looked for, and what your site shows"
          title={`${list.length} blindspot${list.length === 1 ? "" : "s"}, biggest first`}
          meta="Ranked by how many sources point at it, then by count"
        >
          <BlindspotTable list={list} />
        </SheetCard>
      ) : (
        <SheetCard
          label="What customers looked for, and what your site shows"
          title={view.site_checked_at ? "Nothing missing" : "Nothing to compare yet"}
        >
          <p className="bs-copy">
            {view.site_checked_at
              ? "Everything customers asked or searched for that I can match is on your site."
              : view.site_note === "no website in the profile"
                ? "Add your website to your profile and I read up to five of its pages, then compare them with what customers ask and search for."
                : `Your website hasn't been read yet${view.site_note ? `: ${view.site_note}` : ""}, so nothing can be called missing from it.`}{" "}
            {!view.site_checked_at && <Link href="/profile">Fact sheet</Link>}
          </p>
        </SheetCard>
      )}

      <div className="bs-grid">
        {top ? (
          <Biggest b={top} />
        ) : (
          view.coverage.length > 0 && (
            <SheetCard label="What this couldn't see" title="Gaps, not failures">
              <ul className="bs-list">
                {view.coverage.map((c) => (
                  <li key={c}>{c.charAt(0).toUpperCase() + c.slice(1)}.</li>
                ))}
              </ul>
            </SheetCard>
          )
        )}
        <HowFixed fix={top?.fix ?? null} />
      </div>

      {(view.hard_to_find.length > 0 ||
        view.seen_not_chosen.length > 0 ||
        view.topics.length > 0 ||
        (top && view.coverage.length > 0)) && (
        <div className="bs-grid">
          {view.hard_to_find.length > 0 && (
            <SheetCard label="On your site, yet customers keep asking" title="Maybe hard to find">
              <ul className="bs-list">
                {view.hard_to_find.map((h) => (
                  <li key={h.code}>
                    <strong>{h.label}</strong>: asked {num(h.asked)} times in your support chat;
                    it&apos;s on{" "}
                    <a href={h.page} target="_blank" rel="noreferrer">
                      {h.page}
                    </a>
                    .
                  </li>
                ))}
              </ul>
            </SheetCard>
          )}
          {view.seen_not_chosen.length > 0 && (
            <SheetCard label="Seen on Google, rarely clicked" title="Shown, not chosen">
              <div
                className="bs-table-wrap"
                tabIndex={0}
                aria-label="Seen on Google, rarely clicked"
              >
                <table className="rt">
                  <thead>
                    <tr>
                      <th scope="col">Search</th>
                      <th scope="col" className="num">
                        Shown
                      </th>
                      <th scope="col" className="num">
                        Clicked
                      </th>
                      <th scope="col" className="num">
                        Position
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.seen_not_chosen.map((q) => (
                      <tr key={q.query}>
                        <th scope="row">&ldquo;{q.query}&rdquo;</th>
                        <td className="num">{num(q.impressions)}</td>
                        <td className="num">{num(q.clicks)}</td>
                        <td className="num">{num(q.position, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SheetCard>
          )}
          {view.topics.length > 0 && (
            <SheetCard label="Other things people searched for" title="Is it on your site?">
              <ul className="bs-list">
                {view.topics.map((t) => (
                  <li key={t.label}>
                    <strong>{t.label}</strong>: {num(t.count)} searches (e.g.{" "}
                    {t.examples.map((e) => `“${e}”`).join(", ")})
                  </li>
                ))}
              </ul>
            </SheetCard>
          )}
          {top && view.coverage.length > 0 && (
            <SheetCard label="What this couldn't see" title="Gaps, not failures">
              <ul className="bs-list">
                {view.coverage.map((c) => (
                  <li key={c}>{c.charAt(0).toUpperCase() + c.slice(1)}.</li>
                ))}
              </ul>
            </SheetCard>
          )}
        </div>
      )}
    </Frame>
  );
}
