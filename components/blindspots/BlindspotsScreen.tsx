"use client";

// Insights · Blindspots — the owner's Blindspots design (2026-10-17) on
// Phase 2 Session G (P2-32..37). What potential customers asked and
// searched for, against what the business's own site shows them. Every
// row names its counts and its sources; what isn't connected or checked
// is said, not hidden. Read-only: a fix goes through the approval queue.
//
// L-3b: the screen's own words are the "blindspots" catalogue; figures and
// dates in the reader's locale. What the API words (a blindspot's label,
// arithmetic and fix, the site note, the coverage lines) arrives in the
// reader's language (L-4b); the screen reads the site note's kind, never
// its sentence. Topic labels are the model's stored words (L-5) and their
// examples customers' own searches (content).

import { fullStop } from "../../lib/i18n/punctuation";
import "../../app/blindspots.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import { dayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";

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
  /** What stopped the site check (app/api/blindspots `SiteNoteKind`). */
  site_note_kind: "no_site" | "unreadable" | "error" | null;
  blindspots: Blindspot[];
  hard_to_find: { code: string; label: string; page: string; asked: number }[];
  seen_not_chosen: { query: string; impressions: number; clicks: number; position: number }[];
  topics: { label: string; count: number; examples: string[] }[];
  coverage: string[];
}

/** How the site re-check works (app/api/blindspots: RECHECK_DAYS). */
const RECHECK_DAYS = 30;
/** The window the demand is counted over (app/api/blindspots). */
const WINDOW_DAYS = 90;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree; in another language, its own. */
function dayText(iso: string, locale: AppLocale): string {
  if (locale !== "en") return dayMonth(iso, locale);
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Times a customer asked or searched — the demand the site left unmet. */
export function asked(d: Demand): number {
  return d.support_asked + d.support_unanswered + d.site_searches;
}

function whereFrom(b: Blindspot, tr: Tr): string {
  const parts: string[] = [];
  if (b.demand.support_asked + b.demand.support_unanswered > 0) parts.push(tr("where.support"));
  if (b.demand.site_searches > 0) parts.push(tr("where.search"));
  if (b.demand.google_impressions > 0) parts.push(tr("where.google"));
  if (b.competitors_showing > 0)
    parts.push(
      tr("where.competitors", {
        showing: b.competitors_showing,
        checked: b.competitors_checked,
      }),
    );
  return parts.join(" · ");
}

function headline(view: View, tr: Tr): string {
  const n = view.blindspots.length;
  if (n === 0) {
    if (!view.site_checked_at) {
      return view.site_note_kind === "no_site" ? tr("head.noSite") : tr("head.notRead");
    }
    return tr("head.nothingMissing");
  }
  const searches = view.blindspots.reduce((s, b) => s + b.demand.site_searches, 0);
  const questions = view.blindspots.reduce(
    (s, b) => s + b.demand.support_asked + b.demand.support_unanswered,
    0,
  );
  if (searches + questions === 0) return tr("head.things", { count: n });
  if (searches > 0 && questions > 0) return tr("head.foundBoth", { count: searches + questions });
  return searches > 0
    ? tr("head.foundSearches", { count: searches })
    : tr("head.foundQuestions", { count: questions });
}

function BlindspotTable({ list }: { list: Blindspot[] }) {
  const { tr, locale } = useTr("blindspots");
  const max = Math.max(1, ...list.map((b) => asked(b.demand)));
  return (
    <div className="bs-table-wrap" tabIndex={0} aria-label={tr("table.aria")}>
      <table className="rt bs-table">
        <thead>
          <tr>
            <th scope="col">{tr("table.lookedFor")}</th>
            <th scope="col" className="num">
              {tr("table.times")}
            </th>
            <th scope="col">
              <span className="sr-only">{tr("table.share")}</span>
            </th>
            <th scope="col">{tr("table.where")}</th>
            <th scope="col">{tr("table.onSite")}</th>
          </tr>
        </thead>
        <tbody>
          {list.map((b) => {
            const times = asked(b.demand);
            return (
              <tr key={b.code}>
                <th scope="row">{tr("quoted", { text: b.label })}</th>
                <td className="num">{times > 0 ? num(times, 0, locale) : "—"}</td>
                <td className="bs-barcell">
                  <span className="bs-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round((times / max) * 100)}%` }} />
                  </span>
                </td>
                <td className="src">{whereFrom(b, tr)}</td>
                <td>
                  <span className="word alarm">{tr("table.notFound")}</span>
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
  const { tr, locale } = useTr("blindspots");
  const d = b.demand;
  const support = d.support_asked + d.support_unanswered;
  return (
    <SheetCard
      label={tr("biggest.label", { count: asked(d) })}
      title={tr("biggest.title", { label: b.label })}
    >
      <dl className="bs-sources">
        <div>
          <dt>{tr("biggest.support")}</dt>
          <dd className={support === 0 ? "none" : undefined}>
            {support === 0 ? tr("biggest.notAsked") : num(support, 0, locale)}
            {d.support_unanswered > 0 && (
              <small>{tr("biggest.unanswered", { count: d.support_unanswered })}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>{tr("biggest.search")}</dt>
          <dd className={d.site_searches === 0 ? "none" : undefined}>
            {d.site_searches === 0 ? tr("biggest.notSearched") : num(d.site_searches, 0, locale)}
          </dd>
        </div>
        <div>
          <dt>{tr("biggest.google")}</dt>
          <dd className={d.google_impressions === 0 ? "none" : undefined}>
            {d.google_impressions === 0
              ? tr("biggest.notSeen")
              : num(d.google_impressions, 0, locale)}
            {d.google_impressions > 0 && (
              <small>{tr("biggest.impressions", { count: d.google_clicks })}</small>
            )}
          </dd>
        </div>
        <div>
          <dt>{tr("biggest.competitors")}</dt>
          <dd className={b.competitors_checked === 0 ? "none" : undefined}>
            {b.competitors_checked === 0
              ? tr("biggest.noneChecked")
              : tr("biggest.showing", {
                  showing: b.competitors_showing,
                  checked: b.competitors_checked,
                })}
            {b.competitors_checked > 0 && <small>{tr("biggest.showIt")}</small>}
          </dd>
        </div>
      </dl>
      <p className="bs-copy">
        {tr("biggest.toFix", {
          arithmetic: b.arithmetic.charAt(0).toUpperCase() + b.arithmetic.slice(1),
          fix: b.fix,
        })}
      </p>
    </SheetCard>
  );
}

function HowFixed({ fix }: { fix: string | null }) {
  const { tr } = useTr("blindspots");
  return (
    <SheetCard
      label={tr("fixed.label")}
      title={tr("fixed.title")}
      foot={
        <span className="bs-foot-row">
          <span>{tr("fixed.foot")}</span>
          <Link className="act" href="/site">
            {tr("fixed.link")}
          </Link>
        </span>
      }
    >
      <ol className="bs-steps">
        <li>
          <span className="n">01</span>
          <span>{tr("fixed.stepFix", { fix: fix ?? tr("fixed.fixDefault") })}</span>
        </li>
        <li>
          <span className="n">02</span>
          <span>{tr("fixed.stepWait")}</span>
        </li>
        <li>
          <span className="n">03</span>
          <span>{tr("fixed.stepRecheck", { days: RECHECK_DAYS })}</span>
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
  const { tr } = useTr("blindspots");
  return (
    <main className="screen bs-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
    </main>
  );
}

function Coverage({ lines }: { lines: string[] }) {
  const { tr, locale } = useTr("blindspots");
  return (
    <SheetCard label={tr("coverage.label")} title={tr("coverage.title")}>
      <ul className="bs-list">
        {lines.map((c) => (
          <li key={c}>
            {c.charAt(0).toUpperCase() + c.slice(1)}
            {fullStop(locale)}
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

export function BlindspotsScreen() {
  const { tr, locale } = useTr("blindspots");
  const t = useTranslations("blindspots");
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
      <Frame title={tr("signedOut.title")}>
        <p className="bs-wait">
          {t.rich("signedOut.body", { link: (c) => <Link href="/intake">{c}</Link> })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("error.title")}>
        <p className="bs-wait">{tr("error.body")}</p>
      </Frame>
    );
  }
  if (!view) {
    return <Frame title={tr("loading")} />;
  }

  const list = view.blindspots;
  const top = list[0];
  const aside = [
    tr("aside.window", {
      days: WINDOW_DAYS,
      from: dayText(view.window.from, locale),
      to: dayText(view.window.to, locale),
    }),
    view.site_checked_at
      ? tr("aside.siteRead", { day: dayText(view.site_checked_at, locale) })
      : tr("aside.siteNotRead"),
    tr("aside.observed"),
  ].join(" · ");

  return (
    <Frame title={headline(view, tr)} aside={aside}>
      {list.length > 0 ? (
        <SheetCard
          label={tr("list.label")}
          title={tr("list.title", { count: list.length })}
          meta={tr("list.meta")}
        >
          <BlindspotTable list={list} />
        </SheetCard>
      ) : (
        <SheetCard
          label={tr("list.label")}
          title={view.site_checked_at ? tr("list.nothingMissing") : tr("list.nothingYet")}
        >
          <p className="bs-copy">
            {view.site_checked_at
              ? tr("list.allThere")
              : view.site_note_kind === "no_site"
                ? tr("list.noSite")
                : view.site_note
                  ? tr("list.notReadWhy", { why: view.site_note })
                  : tr("list.notRead")}{" "}
            {!view.site_checked_at && <Link href="/profile">{tr("factSheet")}</Link>}
          </p>
        </SheetCard>
      )}

      <div className="bs-grid">
        {top ? <Biggest b={top} /> : view.coverage.length > 0 && <Coverage lines={view.coverage} />}
        <HowFixed fix={top?.fix ?? null} />
      </div>

      {(view.hard_to_find.length > 0 ||
        view.seen_not_chosen.length > 0 ||
        view.topics.length > 0 ||
        (top && view.coverage.length > 0)) && (
        <div className="bs-grid">
          {view.hard_to_find.length > 0 && (
            <SheetCard label={tr("hard.label")} title={tr("hard.title")}>
              <ul className="bs-list">
                {view.hard_to_find.map((h) => (
                  <li key={h.code}>
                    {t.rich("hard.item", {
                      label: h.label,
                      count: h.asked,
                      page: h.page,
                      strong: (c) => <strong>{c}</strong>,
                      link: (c) => (
                        <a href={h.page} target="_blank" rel="noreferrer">
                          {c}
                        </a>
                      ),
                    })}
                  </li>
                ))}
              </ul>
            </SheetCard>
          )}
          {view.seen_not_chosen.length > 0 && (
            <SheetCard label={tr("seen.label")} title={tr("seen.title")}>
              <div className="bs-table-wrap" tabIndex={0} aria-label={tr("seen.label")}>
                <table className="rt">
                  <thead>
                    <tr>
                      <th scope="col">{tr("seen.search")}</th>
                      <th scope="col" className="num">
                        {tr("seen.shown")}
                      </th>
                      <th scope="col" className="num">
                        {tr("seen.clicked")}
                      </th>
                      <th scope="col" className="num">
                        {tr("seen.position")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.seen_not_chosen.map((q) => (
                      <tr key={q.query}>
                        <th scope="row">{tr("quoted", { text: q.query })}</th>
                        <td className="num">{num(q.impressions, 0, locale)}</td>
                        <td className="num">{num(q.clicks, 0, locale)}</td>
                        <td className="num">{num(q.position, 1, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SheetCard>
          )}
          {view.topics.length > 0 && (
            <SheetCard label={tr("topics.label")} title={tr("topics.title")}>
              <ul className="bs-list">
                {view.topics.map((tp) => (
                  <li key={tp.label}>
                    {t.rich("topics.item", {
                      label: tp.label,
                      count: tp.count,
                      examples: tp.examples.map((e) => tr("quoted", { text: e })).join(", "),
                      strong: (c) => <strong>{c}</strong>,
                    })}
                  </li>
                ))}
              </ul>
            </SheetCard>
          )}
          {top && view.coverage.length > 0 && <Coverage lines={view.coverage} />}
        </div>
      )}
    </Frame>
  );
}
