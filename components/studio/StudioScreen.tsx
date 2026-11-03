"use client";

// Grow · Creative studio — Phase 3 Session K (P3-50, P3-51), on the sheet
// system. Top to bottom: the niche's longest-running ads from Meta's Ad
// Library, with the honesty printed beside them every time (no results
// figures exist; running time and versions are a proxy; EU/UK only); then
// the creative brief — audience, the business's own offer, hooks with a
// script and shots, every part showing what it cites — and "Make this",
// which puts a shot-list PROPOSAL in the approval queue. Nothing here
// publishes, films, generates or spends on ads.

import "../../app/studio.css";
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { BriefCitation, BriefRead, BriefSource } from "../../lib/content/brief";
import type { NicheView } from "../../lib/research/niche";
import { useBusinessNoun } from "../nav/useBusinessNoun";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { useTr } from "../sheet/useTr";
import type { Tr } from "../../lib/i18n/tr";
import {
  countText,
  countryText,
  dayText,
  formatWord,
  parseTerms,
  researchNotice,
  runningWords,
  sourceWord,
  studioHeadline,
  timeText,
} from "./studio-view";

type Brief = BriefRead & { sources: BriefSource[]; attempts: number; cost_eur: number };

interface StudioData {
  niche: NicheView;
  briefs: Brief[];
  goals: { goal_id: string; statement: string }[];
  brief_allowance: { calls_left: number; calls_per_month: number; attempts_per_brief: number };
  watching_until: string | null;
}

/** The server's error sentence (English, L-4), or the screen's own when there is none. */
async function errorOf(res: Response, tr: Tr): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? tr("error.generic");
  } catch {
    return tr("error.generic");
  }
}

/* ── the niche's ads ── */

function NicheAds({
  niche,
  busy,
  onRead,
}: {
  niche: NicheView;
  busy: boolean;
  onRead: (terms: string[], fresh: boolean) => void;
}) {
  const { tr, locale } = useTr("studio");
  const [terms, setTerms] = useState(niche.plan_terms.join(", "));
  const read = niche.last_read;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onRead(parseTerms(terms), true);
  };

  // A stored read still shows when a new one can't be made (no token yet,
  // or the business moved outside the coverage); only reading again stops.
  if (niche.blocked && niche.groups.length === 0) {
    return (
      <SheetCard label={tr("niche.label")} title={tr("niche.nothingYet")}>
        <p className="st-copy">{niche.blocked}</p>
        {!niche.set_up && <p className="st-note">{tr("niche.notSetUpNote")}</p>}
      </SheetCard>
    );
  }

  const searched = niche.blocked ? (
    <p className="st-note">{tr("niche.blockedNote", { why: niche.blocked })}</p>
  ) : (
    <form className="st-terms" onSubmit={submit}>
      <label>
        <span>{tr("niche.termsLabel")}</span>
        <input
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          maxLength={130}
          autoComplete="off"
          placeholder={tr("niche.termsPlaceholder")}
        />
      </label>
      <button
        type="submit"
        className="act"
        disabled={busy || (read !== null && !read.refresh_allowed)}
      >
        {busy ? tr("niche.reading") : read ? tr("niche.readAgain") : tr("niche.readLibrary")}
      </button>
      <p className="st-note st-wide">
        {niche.competitors.length > 0
          ? tr("niche.searchesNamed", { names: niche.competitors.map((c) => c.name).join(", ") })
          : tr("niche.searches")}{" "}
        {read &&
          !read.refresh_allowed &&
          tr("niche.freshFrom", { when: timeText(read.refresh_from, locale) })}
      </p>
    </form>
  );

  if (!read || niche.groups.length === 0) {
    return (
      <SheetCard
        label={tr("niche.label")}
        title={read ? tr("niche.noAdsTitle") : tr("niche.notReadTitle")}
        foot={searched}
      >
        <p className="st-copy">
          {read
            ? tr("niche.noAds", {
                day: dayText(read.read_at, locale),
                terms: read.terms.join(", ") || tr("niche.yourCompetitors"),
                country: read.country ? countryText(read.country, locale) : tr("niche.yourCountry"),
              })
            : tr("niche.notReadCopy")}
        </p>
        {niche.last_failure && (
          <p className="st-error" role="status">
            {tr("niche.lastTry", {
              day: dayText(niche.last_failure.at, locale),
              reason: niche.last_failure.reason,
            })}
          </p>
        )}
      </SheetCard>
    );
  }

  return (
    <SheetCard
      label={tr("niche.label")}
      title={tr("niche.foundTitle", {
        count: niche.groups.length,
        businesses: new Set(niche.groups.map((g) => g.page_id)).size,
        day: dayText(read.read_at, locale),
      })}
      meta={<>{tr("niche.ranked")}</>}
      foot={searched}
    >
      <ul className="st-caveats">
        {niche.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {niche.last_failure && (
        <p className="st-error" role="status">
          {tr("niche.lastTry", {
            day: dayText(niche.last_failure.at, locale),
            reason: niche.last_failure.reason,
          })}
        </p>
      )}
      <div className="st-table-wrap" tabIndex={0} aria-label={tr("niche.label")}>
        <table className="rt rt-stack st-table">
          <thead>
            <tr>
              <th scope="col">{tr("table.business")}</th>
              <th scope="col">{tr("table.format")}</th>
              <th scope="col" className="num">
                {tr("table.running")}
              </th>
              <th scope="col" className="num">
                {tr("table.versions")}
              </th>
              <th scope="col">{tr("table.opens")}</th>
              <th scope="col">{tr("table.offer")}</th>
            </tr>
          </thead>
          <tbody>
            {niche.groups.map((g) => {
              const run = runningWords(g, tr);
              return (
                <tr key={g.key}>
                  <th scope="row">
                    {g.page_name}
                    {g.competitor_id && (
                      <span className="word boxed st-flag">{tr("table.youListed")}</span>
                    )}
                    <span className="st-src">
                      <a href={g.library_url} target="_blank" rel="noopener noreferrer">
                        {tr("table.inLibrary")}
                      </a>
                    </span>
                  </th>
                  <td data-label={tr("table.format")}>
                    <span className="word low">{formatWord(g.format, tr)}</span>
                  </td>
                  <td data-label={tr("table.running")} className="num" title={g.arithmetic}>
                    {run.days}{" "}
                    <span className={`word ${g.active ? "ok" : "low"}`}>
                      {run.word === "LIVE" ? tr("running.live") : tr("running.stopped")}
                    </span>
                  </td>
                  <td data-label={tr("table.versions")} className="num">
                    {countText(g.versions, locale)}
                  </td>
                  <td data-label={tr("table.opens")}>
                    {g.hook ? (
                      <q>{g.hook}</q>
                    ) : (
                      <span className="st-src">{tr("table.noText")}</span>
                    )}
                  </td>
                  <td data-label={tr("table.offer")}>
                    {g.offer ? (
                      <q>{g.offer}</q>
                    ) : (
                      <span className="st-src">{tr("table.noOffer")}</span>
                    )}
                    <span className="st-src">{g.cta ?? tr("table.noCta")}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="st-note">
        {tr("niche.searched", {
          terms:
            read.terms.length > 0
              ? read.terms.map((term) => tr("niche.quotedTerm", { term })).join(", ")
              : tr("niche.competitorsOnly"),
          country: countryText(read.country ?? "", locale),
          ads: read.ads_read,
          requests: read.requests,
        })}
      </p>
    </SheetCard>
  );
}

/* ── the brief ── */

function Cites({
  cites,
  sources,
}: {
  cites: readonly BriefCitation[];
  sources: readonly BriefSource[];
}) {
  const { tr } = useTr("studio");
  return (
    <span className="st-cites">
      {cites.map((c) => {
        const s = sources.find((x) => x.id === c.id);
        return (
          <span key={c.id} className="st-cite" title={s?.text ?? c.ref}>
            {c.id} · {sourceWord(c.kind, tr)}
          </span>
        );
      })}
    </span>
  );
}

function BriefForm({
  data,
  busy,
  onWrite,
}: {
  data: StudioData;
  busy: boolean;
  onWrite: (campaign: string, goalId: string) => void;
}) {
  const { tr, locale } = useTr("studio");
  const [campaign, setCampaign] = useState("");
  const [goal, setGoal] = useState("");
  const left = data.brief_allowance.calls_left;
  return (
    <form
      className="st-brief-form"
      onSubmit={(e) => {
        e.preventDefault();
        onWrite(campaign, goal);
      }}
    >
      <label>
        <span>{tr("brief.campaignLabel")}</span>
        <input
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          maxLength={160}
          placeholder={tr("brief.campaignPlaceholder")}
          autoComplete="off"
        />
      </label>
      {data.goals.length > 0 && (
        <label>
          <span>{tr("brief.goalLabel")}</span>
          <select value={goal} onChange={(e) => setGoal(e.target.value)}>
            <option value="">{tr("brief.noGoal")}</option>
            {data.goals.map((g) => (
              <option key={g.goal_id} value={g.goal_id}>
                {g.statement}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="act solid" disabled={busy || left === 0}>
        {busy ? tr("brief.writing") : tr("brief.write")}
      </button>
      <p className="st-note st-wide">
        {tr("brief.allowance", {
          left: countText(left, locale),
          perMonth: countText(data.brief_allowance.calls_per_month, locale),
          attempts: countText(data.brief_allowance.attempts_per_brief, locale),
        })}
      </p>
    </form>
  );
}

function BriefCard({
  brief,
  watchingUntil,
  making,
  onMake,
}: {
  brief: Brief;
  watchingUntil: string | null;
  making: string | null;
  onMake: (briefId: string, hookIndex: number) => void;
}) {
  const { tr, locale } = useTr("studio");
  return (
    <SheetCard
      label={tr("brief.cardLabel", { day: dayText(brief.created_at, locale) })}
      title={brief.campaign}
      meta={
        <>
          {brief.disclosure} · {tr("brief.attempts", { count: brief.attempts })}
        </>
      }
      foot={
        <details className="st-sources">
          <summary>{tr("brief.sources", { count: brief.sources.length })}</summary>
          <ol>
            {brief.sources.map((s) => (
              <li key={s.id}>
                <span className="st-cite">
                  {s.id} · {sourceWord(s.kind, tr)}
                </span>{" "}
                {s.text}
              </li>
            ))}
          </ol>
        </details>
      }
    >
      <dl className="st-claims">
        <div>
          <dt>{tr("brief.who")}</dt>
          <dd>
            {brief.audience.text} <Cites cites={brief.audience.cites} sources={brief.sources} />
          </dd>
        </div>
        <div>
          <dt>{tr("brief.offer")}</dt>
          <dd>
            {brief.offer.text} <Cites cites={brief.offer.cites} sources={brief.sources} />
          </dd>
        </div>
      </dl>
      <ol className="st-hooks">
        {brief.hooks.map((h) => (
          <li key={h.index} className="st-hook">
            <p className="st-hook-line">{h.hook}</p>
            <Cites cites={h.cites} sources={brief.sources} />
            <p className="st-script">
              <span className="st-src">{tr("brief.script", { seconds: h.seconds })}</span>
              {h.script}
            </p>
            <ol className="st-shots">
              {h.shots.map((s) => (
                <li key={s.order}>
                  {s.shot}
                  <span className="st-src">{tr("brief.why", { why: s.why })}</span>
                </li>
              ))}
            </ol>
            <div className="st-make">
              <button
                type="button"
                className="act"
                disabled={watchingUntil !== null || making !== null}
                onClick={() => onMake(brief.id, h.index)}
              >
                {making === `${brief.id}:${h.index}` ? tr("brief.proposing") : tr("brief.make")}
              </button>
              <span className="st-note">
                {watchingUntil
                  ? tr("brief.watching", {
                      day: dayText(`${watchingUntil}T00:00:00Z`, locale),
                    })
                  : tr("brief.makeNote")}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </SheetCard>
  );
}

/* ── the screen ── */

function Frame({
  title,
  aside,
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const { tr } = useTr("studio");
  return (
    <main className="screen st-screen">
      <PageHead kicker={tr("kicker")} title={title} aside={aside} />
      {children}
    </main>
  );
}

export function StudioScreen() {
  const { tr, locale } = useTr("studio");
  const rich = useTranslations("studio");
  const noun = useBusinessNoun();
  const [data, setData] = useState<StudioData | null>(null);
  const [failed, setFailed] = useState<"signed_out" | "error" | null>(null);
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [making, setMaking] = useState<string | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [shown, setShown] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/studio");
      if (res.status === 401) return setFailed("signed_out");
      if (!res.ok) return setFailed("error");
      setData((await res.json()) as StudioData);
    } catch {
      setFailed("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = (body: Record<string, unknown>) =>
    fetch("/api/studio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const research = async (terms: string[], fresh: boolean) => {
    setReading(true);
    setNotice(null);
    const res = await post({ action: "research", terms, fresh });
    if (res.ok) {
      setNotice(
        researchNotice(
          (await res.json()) as { status: string; why: string | null; fresh: boolean },
          tr,
        ),
      );
    } else setNotice(await errorOf(res, tr));
    setReading(false);
    await load();
  };

  const write = async (campaign: string, goalId: string) => {
    setWriting(true);
    setNotice(null);
    const res = await post({ action: "brief", campaign, goal_id: goalId });
    if (res.ok) {
      const { brief_id } = (await res.json()) as { brief_id: string };
      setShown(brief_id);
      setNotice(tr("notice.written"));
    } else setNotice(await errorOf(res, tr));
    setWriting(false);
    await load();
  };

  const make = async (briefId: string, hookIndex: number) => {
    setMaking(`${briefId}:${hookIndex}`);
    setNotice(null);
    const res = await post({ action: "make", brief_id: briefId, hook_index: hookIndex });
    if (res.ok) {
      const { status } = (await res.json()) as { status: string };
      setNotice(
        status === "blocked"
          ? tr("notice.blocked")
          : rich.rich("notice.proposed", {
              queue: (chunks) => <Link href="/proposals">{chunks}</Link>,
            }),
      );
    } else setNotice(await errorOf(res, tr));
    setMaking(null);
  };

  if (failed === "signed_out") {
    return (
      <Frame title={tr("signedOut.title")}>
        <p className="st-wait">
          {rich.rich("signedOut.copy", {
            intake: (chunks) => <Link href="/intake">{chunks}</Link>,
          })}
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title={tr("error.title")}>
        <p className="st-wait">{tr("error.copy")}</p>
      </Frame>
    );
  }
  if (!data) return <Frame title={tr("loading")} />;

  const brief = data.briefs.find((b) => b.id === shown) ?? data.briefs[0] ?? null;

  return (
    <Frame
      title={studioHeadline(data.niche, data.briefs.length, noun, tr, locale)}
      aside={<>{tr("aside")}</>}
    >
      {notice && (
        <p className="st-notice" role="status">
          {notice}
        </p>
      )}
      <NicheAds niche={data.niche} busy={reading} onRead={research} />
      <SheetCard
        label={tr("brief.label")}
        title={brief ? tr("brief.another") : tr("brief.first")}
        meta={tr("brief.meta")}
      >
        <BriefForm data={data} busy={writing} onWrite={write} />
        {data.briefs.length > 1 && (
          <p className="st-note">
            {tr("brief.earlier")}{" "}
            {data.briefs.map((b, i) => (
              <span key={b.id}>
                {i > 0 && " · "}
                <button
                  type="button"
                  className="st-link"
                  aria-pressed={brief?.id === b.id}
                  onClick={() => setShown(b.id)}
                >
                  {b.campaign} ({dayText(b.created_at, locale)})
                </button>
              </span>
            ))}
          </p>
        )}
      </SheetCard>
      {brief && (
        <BriefCard
          brief={brief}
          watchingUntil={data.watching_until}
          making={making}
          onMake={make}
        />
      )}
    </Frame>
  );
}
