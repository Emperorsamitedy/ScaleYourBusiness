"use client";

// Insights · Missing from your site (was Blindspots): the owner's Blindspots
// design (2026-10-17) on Phase 2 Session G (P2-32..37), said plainly on
// 2026-11-23 from the canvas design the owner approved. What potential
// customers asked and searched for, against what the business's own site
// shows them: one list, most asked first, each with where it came up; how
// to fix one, in three steps; and where Lex looked, each source read or
// what it needs. Read-only: a fix is the owner's, or a change on Website
// that waits for their yes.
//
// L-3b: the screen's own words are the "blindspots" catalogue; figures and
// dates in the reader's locale. A blindspot's label arrives in the reader's
// language (L-4b); where Lex looked is drawn from the report's `looked`
// flags, never from its coverage sentences. Topic labels are the model's
// stored words (L-5) and their examples customers' own searches (content).

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
/** Which sources the counts were read from (lib/blindspots/finder `looked`). */
interface Looked {
  support: boolean;
  site_search: boolean;
  google: boolean;
  competitors_checked: number;
  unmatched: number;
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
  /** Absent from a server older than 2026-11-23: "Where Lex looked" is then left out. */
  looked?: Looked;
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

/** Where one came up, said plainly: "Searched 123 times on your site · Asked 4 times in your support chat". */
function cameUp(b: Blindspot, tr: Tr): string {
  const d = b.demand;
  const parts: string[] = [];
  if (d.site_searches > 0) parts.push(tr("row.searched", { count: d.site_searches }));
  const support = d.support_asked + d.support_unanswered;
  if (support > 0) parts.push(tr("row.asked", { count: support }));
  if (d.google_impressions > 0) parts.push(tr("row.google", { count: d.google_impressions }));
  if (b.competitors_showing > 0)
    parts.push(
      tr("row.competitors", { showing: b.competitors_showing, checked: b.competitors_checked }),
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
  return tr("head.things", { count: n });
}

function MissingList({ list }: { list: Blindspot[] }) {
  const { tr } = useTr("blindspots");
  const max = Math.max(1, ...list.map((b) => asked(b.demand)));
  return (
    <ul className="bs-rows">
      {list.map((b) => {
        const times = asked(b.demand);
        return (
          <li key={b.code}>
            <span className="bs-what">
              <b>{b.label}</b>
              <span>{cameUp(b, tr)}</span>
            </span>
            <span className="bs-bar" aria-hidden="true">
              <span style={{ width: `${Math.round((times / max) * 100)}%` }} />
            </span>
            <span className="word alarm bs-miss">{tr("row.missing")}</span>
          </li>
        );
      })}
    </ul>
  );
}

function HowToFix() {
  const { tr } = useTr("blindspots");
  return (
    <SheetCard
      title={tr("fix.title")}
      foot={
        <span className="bs-foot-row">
          <Link className="act" href="/site">
            {tr("fix.link")}
          </Link>
        </span>
      }
    >
      <ol className="bs-steps">
        <li>{tr("fix.add")}</li>
        <li>{tr("fix.website")}</li>
        <li>{tr("fix.recheck", { count: RECHECK_DAYS })}</li>
      </ol>
    </SheetCard>
  );
}

/** Each place the counts could come from: read, or what it needs. */
function WhereLooked({ view, looked }: { view: View; looked: Looked }) {
  const { tr, locale } = useTr("blindspots");
  const t = useTranslations("blindspots");
  const read = <span className="word ok">{tr("looked.read")}</span>;
  const connect = (
    <Link href="/connections" className="bs-need">
      {tr("looked.connect")}
    </Link>
  );
  const rows: { key: string; what: ReactNode; state: ReactNode }[] = [
    {
      key: "pages",
      what: view.site_checked_at
        ? tr("looked.pages", { date: dayText(view.site_checked_at, locale) })
        : tr("looked.pagesNot"),
      state: view.site_checked_at ? read : <span className="word low">{tr("looked.notYet")}</span>,
    },
    {
      key: "search",
      what: tr("looked.search"),
      state: looked.site_search ? read : connect,
    },
    {
      key: "support",
      what: (
        <>
          {tr("looked.support")}
          {looked.unmatched > 0 && (
            <small>{tr("looked.unmatched", { count: looked.unmatched })}</small>
          )}
        </>
      ),
      state: looked.support ? read : <span className="word low">{tr("looked.noneAsked")}</span>,
    },
    {
      key: "google",
      what: (
        <>
          {tr("looked.google")}
          {looked.google && <small>{tr("looked.googleHides")}</small>}
        </>
      ),
      state: looked.google ? read : connect,
    },
    {
      key: "competitors",
      what: tr("looked.competitors"),
      state:
        looked.competitors_checked > 0 ? (
          <span className="word ok">
            {tr("looked.competitorsRead", { count: looked.competitors_checked })}
          </span>
        ) : (
          <Link href="/competitors" className="bs-need">
            {tr("looked.noCompetitors")}
          </Link>
        ),
    },
  ];
  return (
    <SheetCard title={t("looked.title")}>
      <ul className="bs-looked">
        {rows.map((r) => (
          <li key={r.key}>
            <span>{r.what}</span>
            {r.state}
          </li>
        ))}
      </ul>
    </SheetCard>
  );
}

function Frame({
  title,
  lede,
  children,
}: {
  title: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useTr("blindspots");
  return (
    <main className="screen bs-screen">
      <PageHead kicker={tr("kicker")} title={title}>
        {lede}
      </PageHead>
      {children}
    </main>
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
          {t.rich("signedOut.body", { link: (c) => <Link href="/start">{c}</Link> })}
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
  const lede =
    list.length > 0 ? (
      <p className="bs-lede">
        {tr("lede", {
          days: WINDOW_DAYS,
          from: dayText(view.window.from, locale),
          to: dayText(view.window.to, locale),
        })}
      </p>
    ) : undefined;

  return (
    <Frame title={headline(view, tr)} lede={lede}>
      {list.length > 0 ? (
        <SheetCard title={tr("list.plainTitle")}>
          <MissingList list={list} />
        </SheetCard>
      ) : (
        <SheetCard title={view.site_checked_at ? tr("list.nothingMissing") : tr("list.nothingYet")}>
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
        {list.length > 0 && <HowToFix />}
        {view.looked && <WhereLooked view={view} looked={view.looked} />}
      </div>

      {(view.hard_to_find.length > 0 ||
        view.seen_not_chosen.length > 0 ||
        view.topics.length > 0) && (
        <div className="bs-grid">
          {view.hard_to_find.length > 0 && (
            <SheetCard title={tr("hard.title")}>
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
            <SheetCard title={tr("seen.label")}>
              <ul className="bs-list">
                {view.seen_not_chosen.map((q) => (
                  <li key={q.query}>
                    <strong>{tr("quoted", { text: q.query })}</strong>:{" "}
                    {tr("seen.row", {
                      shown: num(q.impressions, 0, locale),
                      clicked: num(q.clicks, 0, locale),
                      position: Math.max(1, Math.round(q.position)),
                    })}
                  </li>
                ))}
              </ul>
            </SheetCard>
          )}
          {view.topics.length > 0 && (
            <SheetCard title={tr("topics.label")}>
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
        </div>
      )}
      {!view.looked && view.coverage.length > 0 && (
        <SheetCard title={tr("looked.title")}>
          <ul className="bs-list">
            {view.coverage.map((c) => (
              <li key={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</li>
            ))}
          </ul>
        </SheetCard>
      )}
    </Frame>
  );
}
