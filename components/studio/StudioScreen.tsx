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
import type { BriefCitation, BriefRead, BriefSource } from "../../lib/content/brief";
import type { NicheView } from "../../lib/research/niche";
import { useBusinessNoun } from "../nav/useBusinessNoun";
import { PageHead, SheetCard } from "../sheet/PageHead";
import {
  SOURCE_WORD,
  dayText,
  parseTerms,
  researchNotice,
  runningWords,
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

const FORMAT_WORD: Record<string, string> = {
  video: "VIDEO",
  image: "IMAGE",
  multi: "CARDS / VERSIONS",
};

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? "That didn't work. Try again.";
  } catch {
    return "That didn't work. Try again.";
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
      <SheetCard label="The niche's longest-running ads" title="Nothing to read yet">
        <p className="st-copy">{niche.blocked}</p>
        {!niche.set_up && (
          <p className="st-note">
            Meta opens its Ad Library API only to a developer account whose identity it has
            confirmed. Once SYB&rsquo;s token is set, this reads the ads your niche runs, read-only.
          </p>
        )}
      </SheetCard>
    );
  }

  const searched = niche.blocked ? (
    <p className="st-note">{niche.blocked} What is shown is the last read.</p>
  ) : (
    <form className="st-terms" onSubmit={submit}>
      <label>
        <span>Words your niche&rsquo;s ads would use, comma-separated (two at most)</span>
        <input
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          maxLength={130}
          autoComplete="off"
          placeholder="e.g. handmade mug, pottery class"
        />
      </label>
      <button
        type="submit"
        className="act"
        disabled={busy || (read !== null && !read.refresh_allowed)}
      >
        {busy ? "Reading…" : read ? "Read again →" : "Read the Ad Library →"}
      </button>
      <p className="st-note st-wide">
        The Library searches the words in the ads themselves, in their own language. I also look for
        the competitors you listed
        {niche.competitors.length > 0
          ? ` (${niche.competitors.map((c) => c.name).join(", ")})`
          : ""}
        .{" "}
        {read &&
          !read.refresh_allowed &&
          `A fresh read is allowed from ${timeText(read.refresh_from)}.`}
      </p>
    </form>
  );

  if (!read || niche.groups.length === 0) {
    return (
      <SheetCard
        label="The niche's longest-running ads"
        title={read ? "The Library had no ads for those words" : "Not read yet"}
        foot={searched}
      >
        <p className="st-copy">
          {read
            ? `I read Meta's Ad Library on ${dayText(read.read_at)} for ${read.terms.join(", ") || "your competitors"} and found nothing that reached ${read.country ?? "your country"}. Try other words.`
            : "I read which ads businesses like yours have kept running the longest, as far as Meta's public Ad Library shows them."}
        </p>
        {niche.last_failure && (
          <p className="st-error" role="status">
            Last try, {dayText(niche.last_failure.at)}: {niche.last_failure.reason}.
          </p>
        )}
      </SheetCard>
    );
  }

  return (
    <SheetCard
      label="The niche's longest-running ads"
      title={`${niche.groups.length} ad concept${niche.groups.length === 1 ? "" : "s"} from ${new Set(niche.groups.map((g) => g.page_id)).size} businesses, read ${dayText(read.read_at)}`}
      meta={<>Ranked by staying power · a proxy, NOT A RESULT</>}
      foot={searched}
    >
      <ul className="st-caveats">
        {niche.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      {niche.last_failure && (
        <p className="st-error" role="status">
          Last try, {dayText(niche.last_failure.at)}: {niche.last_failure.reason}.
        </p>
      )}
      <div className="st-table-wrap" tabIndex={0} aria-label="The niche's longest-running ads">
        <table className="rt rt-stack st-table">
          <thead>
            <tr>
              <th scope="col">Business</th>
              <th scope="col">Format</th>
              <th scope="col" className="num">
                Running
              </th>
              <th scope="col" className="num">
                Versions
              </th>
              <th scope="col">How it opens</th>
              <th scope="col">Offer · call to action</th>
            </tr>
          </thead>
          <tbody>
            {niche.groups.map((g) => {
              const run = runningWords(g);
              return (
                <tr key={g.key}>
                  <th scope="row">
                    {g.page_name}
                    {g.competitor_id && <span className="word boxed st-flag">You listed them</span>}
                    <span className="st-src">
                      <a href={g.library_url} target="_blank" rel="noopener noreferrer">
                        In the Ad Library →
                      </a>
                    </span>
                  </th>
                  <td data-label="Format">
                    <span className="word low">{FORMAT_WORD[g.format] ?? g.format}</span>
                  </td>
                  <td data-label="Running" className="num" title={g.arithmetic}>
                    {run.days} <span className={`word ${g.active ? "ok" : "low"}`}>{run.word}</span>
                  </td>
                  <td data-label="Versions" className="num">
                    {g.versions}
                  </td>
                  <td data-label="How it opens">
                    {g.hook ? <q>{g.hook}</q> : <span className="st-src">no text</span>}
                  </td>
                  <td data-label="Offer · call to action">
                    {g.offer ? <q>{g.offer}</q> : <span className="st-src">no offer found</span>}
                    <span className="st-src">{g.cta ?? "no call to action found"}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="st-note">
        Searched for{" "}
        {read.terms.length > 0
          ? read.terms.map((t) => `“${t}”`).join(", ")
          : "your competitors only"}
        , ads that reached {read.country}; {read.ads_read} ads read in {read.requests} requests.
        OBSERVED from Meta&rsquo;s public Ad Library; the hooks, offers and calls to action are
        picked out by plain patterns, and blank when none matched.
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
  return (
    <span className="st-cites">
      {cites.map((c) => {
        const s = sources.find((x) => x.id === c.id);
        return (
          <span key={c.id} className="st-cite" title={s?.text ?? c.ref}>
            {c.id} · {SOURCE_WORD[c.kind] ?? c.kind}
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
        <span>The campaign, in your words</span>
        <input
          value={campaign}
          onChange={(e) => setCampaign(e.target.value)}
          maxLength={160}
          placeholder="e.g. Autumn mugs for gifting"
          autoComplete="off"
        />
      </label>
      {data.goals.length > 0 && (
        <label>
          <span>Or the goal it serves</span>
          <select value={goal} onChange={(e) => setGoal(e.target.value)}>
            <option value="">No particular goal</option>
            {data.goals.map((g) => (
              <option key={g.goal_id} value={g.goal_id}>
                {g.statement}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className="act solid" disabled={busy || left === 0}>
        {busy ? "Writing…" : "Write a brief →"}
      </button>
      <p className="st-note st-wide">
        {left} of {data.brief_allowance.calls_per_month} brief-writing calls left this month; one
        brief takes up to {data.brief_allowance.attempts_per_brief}. I write only from what you see
        cited, and refuse any line that repeats five words in a row from another business&rsquo;s
        ad.
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
  return (
    <SheetCard
      label={`Creative brief · ${dayText(brief.created_at)}`}
      title={brief.campaign}
      meta={
        <>
          {brief.disclosure} · {brief.attempts} attempt{brief.attempts === 1 ? "" : "s"}
        </>
      }
      foot={
        <details className="st-sources">
          <summary>Everything this brief was written from ({brief.sources.length} sources)</summary>
          <ol>
            {brief.sources.map((s) => (
              <li key={s.id}>
                <span className="st-cite">
                  {s.id} · {SOURCE_WORD[s.kind] ?? s.kind}
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
          <dt>Who it&rsquo;s for</dt>
          <dd>
            {brief.audience.text} <Cites cites={brief.audience.cites} sources={brief.sources} />
          </dd>
        </div>
        <div>
          <dt>The offer</dt>
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
              <span className="st-src">Script · about {h.seconds} s</span>
              {h.script}
            </p>
            <ol className="st-shots">
              {h.shots.map((s) => (
                <li key={s.order}>
                  {s.shot}
                  <span className="st-src">Why: {s.why}</span>
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
                {making === `${brief.id}:${h.index}` ? "Proposing…" : "Make this →"}
              </button>
              <span className="st-note">
                {watchingUntil
                  ? `Still watching until ${dayText(`${watchingUntil}T00:00:00Z`)}; nothing is proposed before then.`
                  : "Puts this shot list in Waiting for you. Approved, it becomes a “film this” item; your footage goes to the cutting room."}
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
  return (
    <main className="screen st-screen">
      <PageHead kicker="Grow · Creative studio" title={title} aside={aside} />
      {children}
    </main>
  );
}

export function StudioScreen() {
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
        ),
      );
    } else setNotice(await errorOf(res));
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
      setNotice("The brief is written. Every part shows what it rests on.");
    } else setNotice(await errorOf(res));
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
        status === "blocked" ? (
          "That shot list crossed one of your limits, so it sits in the restraint view instead."
        ) : (
          <>
            Proposed. It&rsquo;s in <Link href="/proposals">Waiting for you</Link>.
          </>
        ),
      );
    } else setNotice(await errorOf(res));
    setMaking(null);
  };

  if (failed === "signed_out") {
    return (
      <Frame title="There's no business here yet.">
        <p className="st-wait">
          <Link href="/intake">Start with the interview</Link>; the studio works from what you tell
          me.
        </p>
      </Frame>
    );
  }
  if (failed) {
    return (
      <Frame title="The studio didn't load.">
        <p className="st-wait">Something went wrong on our side. Refresh to try again.</p>
      </Frame>
    );
  }
  if (!data) return <Frame title="Reading your niche and your briefs…" />;

  const brief = data.briefs.find((b) => b.id === shown) ?? data.briefs[0] ?? null;

  return (
    <Frame
      title={studioHeadline(data.niche, data.briefs.length, noun)}
      aside={<>Meta Ad Library · read-only · OBSERVED</>}
    >
      {notice && (
        <p className="st-notice" role="status">
          {notice}
        </p>
      )}
      <NicheAds niche={data.niche} busy={reading} onRead={research} />
      <SheetCard
        label="Creative brief"
        title={brief ? "Write another" : "Write the first brief"}
        meta="Sonnet writes it · every part cites its source"
      >
        <BriefForm data={data} busy={writing} onWrite={write} />
        {data.briefs.length > 1 && (
          <p className="st-note">
            Earlier briefs:{" "}
            {data.briefs.map((b, i) => (
              <span key={b.id}>
                {i > 0 && " · "}
                <button
                  type="button"
                  className="st-link"
                  aria-pressed={brief?.id === b.id}
                  onClick={() => setShown(b.id)}
                >
                  {b.campaign} ({dayText(b.created_at)})
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
