"use client";

// The content queue — Phase 3 Session C, in the owner's instrument
// design (2026-10-17). Top to bottom: one sentence counted from the
// queue; a strip per channel (planned vs posted, from the queue itself —
// no invented targets); the draft queue as a ruled table beside the open
// draft's record (caption, what it was written from, its disclosure);
// then the goals the content serves and the two proposal buttons, which
// put PROPOSALS in the approval queue rather than doing anything.
//
// P3-21e: it is also the publishing queue — each item's state on its way
// out, the platform's link once it is live, and Withdraw, which runs the
// stored undo through the engine. Nothing is ever published FROM this
// screen: an item goes out after its own yes in the queue, at its time,
// through the runner. While the Session D real-write gate is off the
// screen says so plainly.
//
// P3-54: a publish-ready item with its image or clip offers "Run this as an
// ad" — it makes ONE proposal in the queue (budget, duration, audience,
// scenarios), never a send. Approved, the runner creates the ad on Meta,
// paused; going live is a second, separate proposal.
//
// P3-24b: an item held by a write connection that paused itself reads
// `failed` with the one sentence ("I couldn't post — the connection
// expired…") and offers Reconnect, which goes to /connections; the
// reconnect puts it back in the queue.
//
// L-3c (TASKS-LANGUAGES.md): the screen's own words are the "content"
// catalogue; dates and counts in the reader's locale. A draft's title,
// caption and disclosure, a goal's statement, a channel's label and every
// sentence the server sends (publish notes, last errors, the arithmetic)
// are shown as they are.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import "../../app/content.css";
import { EmergencyStop } from "../execution/EmergencyStop";
import { MediaPanel } from "./MediaPanel";
import type { TikTokItemStateLike } from "./TikTokPostForm";
import { TikTokPostForm } from "./TikTokPostForm";
import { HBars } from "../charts/Viz";
import { Fold } from "../sheet/Fold";
import { PageHead, SheetCard } from "../sheet/PageHead";
import { ToolIntro } from "../grow/ToolIntro";
import { num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import { rangeOf } from "../../lib/i18n/range";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import {
  type AdStateLike,
  type ContentStatus,
  type DayMark,
  type MediaState,
  type PerformanceLike,
  adLine,
  aiMediaWord,
  calendarStrip,
  channelStrips,
  contentHeadline,
  learnedWords,
  mediaWord,
  performanceBars,
  performanceLine,
  platformWord,
  publishLine,
  shortId,
  stateWord,
  tileMedia,
} from "./content-view";
import { Logo } from "../brand/Mark";

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
  media_path: string | null;
  provenance: {
    evidence?: string[];
    item?: { focus?: string };
    media?: { origin?: string; is_ai_generated?: boolean };
    /** Posts that learn: the business's own judged posts the draft had in view, by id. */
    lessons?: { platform?: string; helped?: string[]; backfired?: string[] };
  } | null;
  /* P3-20d — the publish state, straight from the row. */
  status: ContentStatus;
  platform: string | null;
  platform_post_id: string | null;
  platform_url: string | null;
  published_at: string | null;
  publish_proposal_id: string | null;
  last_error: string | null;
  /** P3-24b: set when the item waits for a paused connection to be reconnected. */
  paused_connection_id?: string | null;
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
      /** P3-21a: item id → why it isn't headed for publishing. */
      publishNotes: Record<string, string>;
      /** L-4c: the items whose note Connections fixes — a flag from the server, not a word match. */
      publishConnect: readonly string[];
      /** The Session D real-write gate: false until the two-week test completes. */
      realWrites: boolean;
      /** YYYY-MM-DD the watch ends, while it runs: nothing is proposed before then (rule 15). */
      watchingUntil: string | null;
      /** P3-23b: item id → its measured figures and verdict, published items only. */
      performance: Record<string, PerformanceLike>;
      /** P3-54: item id → whether it can run as an ad, and where its ad stands. */
      ads: Record<string, AdStateLike>;
      /** 2026-11-08: item id → its TikTok post settings and whether they may still change. */
      tiktok: Record<string, TikTokItemStateLike>;
      /** P3-52/53: footage, renders and the AI fallback, for the items that can take media. */
      media: MediaState | null;
      /** The item whose Withdraw is waiting on a second click. */
      confirmWithdraw: string | null;
      busy: boolean;
      notice: string | null;
      newGoal: string;
      open: string | null;
    };

/** A goal's horizon code ("3_months") in words; an unknown code shows as it is. */
function horizonWord(horizon: string, tr: Tr): string {
  const m = /^(\d+)_months$/.exec(horizon);
  return m ? tr("goals.horizon", { months: Number(m[1]) }) : horizon;
}

/** A calendar day, not an instant — rendered in UTC so a negative offset doesn't shift it. */
function dayWord(iso: string, locale: AppLocale = "en"): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(intlTag(locale), {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function shortDay(iso: string, locale: AppLocale = "en"): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Monday to Sunday, one narrow letter each (1 January 2024 was a Monday). */
function weekdayInitials(locale: AppLocale): string[] {
  return Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, 1 + i)).toLocaleDateString(intlTag(locale), {
      weekday: "narrow",
      timeZone: "UTC",
    }),
  );
}

/** The calendar strip's marks in the small visuals' grammar (app/viz.css). */
const MARK_TONE: Readonly<Record<DayMark, string>> = {
  posted: "vz-ink",
  planned: "vz-hollow",
  overdue: "vz-drift",
};
const MARK_ORDER: readonly DayMark[] = ["posted", "planned", "overdue"];

/** The id that produced a "channels.<id>.type" style key, if any. */
const EVIDENCE = /^(channels|goals)\.([0-9a-f-]{36})\.(\w+)$/;

/** "1 November" from YYYY-MM-DD, read as a calendar day (no time zone shift). */
function watchDay(day: string, locale: AppLocale = "en"): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString(intlTag(locale), {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

export function ContentScreen() {
  const [state, setState] = useState<State>({ phase: "loading" });
  /** Tile sources that didn't load: such an item gets no tile rather than an empty one. */
  const [unloadable, setUnloadable] = useState<ReadonlySet<string>>(new Set());
  const detailRef = useRef<HTMLElement | null>(null);
  const { tr, locale } = useTr("content");
  const day = (iso: string) => dayWord(iso, locale);
  const short = (iso: string) => shortDay(iso, locale);
  const kindWord = (kind: ContentItem["kind"]) => tr(`kind.${kind}`);

  const load = useCallback(async () => {
    const [contentRes, goalsRes] = await Promise.all([fetch("/api/content"), fetch("/api/goals")]);
    if (contentRes.status === 401 || goalsRes.status === 401) {
      return setState({ phase: "signedout" });
    }
    const content = (await contentRes.json()) as {
      items: ContentItem[];
      producible: Producible[];
      publish_notes?: Record<string, string>;
      publish_connect?: string[];
      real_writes?: boolean;
      watching_until?: string | null;
      performance?: Record<string, PerformanceLike>;
      ads?: Record<string, AdStateLike>;
      tiktok?: Record<string, TikTokItemStateLike>;
      media?: MediaState;
    };
    const goals = (await goalsRes.json()) as { goals: Goal[]; suggestions: Suggestion[] };
    setState((cur) => ({
      phase: "ready",
      goals: goals.goals,
      suggestions: goals.suggestions,
      items: content.items,
      producible: content.producible,
      publishNotes: content.publish_notes ?? {},
      publishConnect: content.publish_connect ?? [],
      realWrites: content.real_writes === true,
      watchingUntil: content.watching_until ?? null,
      performance: content.performance ?? {},
      ads: content.ads ?? {},
      tiktok: content.tiktok ?? {},
      media: content.media ?? null,
      confirmWithdraw: null,
      busy: false,
      notice: null,
      newGoal: "",
      open: cur.phase === "ready" ? cur.open : null,
    }));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "loading") {
    return (
      <main className="screen ct-screen">
        <PageHead kicker={tr("kicker")} title={tr("loading")} />
      </main>
    );
  }
  if (state.phase === "signedout") {
    return (
      <main className="auth-stage">
        <div className="auth-col">
          <span className="wordmark">
            <Logo onDark />
          </span>
          <section className="card auth-card">
            <span className="auth-eyebrow">{tr("signedOut.eyebrow")}</span>
            <h1 className="auth-title">{tr("signedOut.title")}</h1>
            <p className="auth-copy">{tr("signedOut.body")}</p>
            <Link className="next auth-cta" style={{ marginTop: 24 }} href="/start">
              {tr("signedOut.cta")}
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
      setState({ ...s, busy: false, notice: j.error ?? tr("failed") });
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

  const today = todayIso();
  const strips = channelStrips(s.items, today);
  const goalById = new Map(s.goals.map((g) => [g.goal_id, g]));
  const nextDate =
    s.items
      .filter((i) => i.status === "drafted" || i.status === "queued")
      .map((i) => i.scheduled_for)
      .filter((d): d is string => d !== null && d >= today)
      .sort()[0] ?? null;
  const headline = contentHeadline(
    {
      items: s.items,
      producible: s.producible.length,
      blocked: Object.keys(s.publishNotes).length,
      nextDate: nextDate ? day(nextDate) : null,
    },
    tr,
  );

  // The open draft: the owner's pick, else the first one waiting on them, else the first draft.
  const open =
    s.items.find((i) => i.id === s.open) ??
    s.items.find((i) => i.status === "drafted" && i.publish_proposal_id !== null) ??
    s.items.find((i) => i.status === "drafted") ??
    s.items[0] ??
    null;

  const stripTitle = (channel: string, planned: number): string => {
    const kinds = new Set(
      s.items
        .filter((i) => i.channel_label === channel && i.status !== "withdrawn")
        .map((i) => i.kind),
    );
    const only = kinds.size === 1 ? [...kinds][0] : undefined;
    return tr(`strip.${only ?? "piece"}`, { count: planned });
  };

  const pick = (id: string) => {
    setState({ ...s, open: id });
    if (window.matchMedia("(max-width: 1099px)").matches) {
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: "start" }));
    }
  };

  const tiles = s.items.flatMap((item) => {
    const media = tileMedia(item);
    return media && !unloadable.has(media.src) ? [{ item, media }] : [];
  });
  const calendar = calendarStrip(s.items, today);
  const calendarDays = calendar?.weeks.flat() ?? [];
  const itemById = new Map(s.items.map((i) => [i.id, i]));
  const marksDrawn = new Set(calendarDays.flatMap((d) => d.entries.map((e) => e.mark)));
  const markWord = (mark: DayMark) =>
    mark === "posted" ? tr("state.posted") : tr(`calendar.${mark}`);

  const evidenceLine = (key: string, item: ContentItem): string => {
    const m = EVIDENCE.exec(key);
    if (m?.[1] === "channels") return tr("evidence.channel", { channel: item.channel_label });
    if (m?.[1] === "goals") {
      const g = m[2] ? goalById.get(m[2]) : undefined;
      return tr("evidence.goal", { goal: g?.statement ?? tr("evidence.goalUnknown") });
    }
    return key;
  };

  return (
    <main className="screen ct-screen">
      <PageHead
        kicker={tr("kicker")}
        title={headline}
        aside={
          <a className="ghost ct-aside" href="#ct-goals">
            {tr("aside")} <span aria-hidden="true">→</span>
          </a>
        }
      />
      <ToolIntro tool="posts" />

      <div className="ct-stop">
        <EmergencyStop />
      </div>

      {s.notice && (
        <p className="ct-notice" aria-live="polite">
          {s.notice}
        </p>
      )}

      {strips.length > 0 && (
        <ul className="ct-strips" aria-label={tr("strips.label")}>
          {strips.map((st) => {
            const pct = st.planned === 0 ? 0 : Math.round((st.posted / st.planned) * 100);
            const span =
              st.first && st.last
                ? st.first === st.last
                  ? short(st.first)
                  : rangeOf(short(st.first), short(st.last), locale)
                : tr("strips.undated");
            return (
              <li key={st.channel} className="ct-strip">
                <p className="ct-strip-label">
                  {st.channel} · {span}
                </p>
                <p className="ct-strip-row">
                  <span className="ct-strip-title">{stripTitle(st.channel, st.planned)}</span>
                  <span className="ct-strip-fig">
                    {num(st.posted, 0, locale)} / {num(st.planned, 0, locale)}
                  </span>
                </p>
                <span
                  className={`ct-bar ${st.state}`}
                  role="img"
                  aria-label={tr("strips.bar", { posted: st.posted, planned: st.planned })}
                >
                  <span className="ct-bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <p className="ct-strip-state">
                  {st.state === "behind"
                    ? tr("strips.behind", { count: st.overdue })
                    : st.state === "done"
                      ? tr("strips.done")
                      : st.next
                        ? tr("strips.next", { day: day(st.next) })
                        : tr("strips.onPace")}
                </p>
              </li>
            );
          })}
        </ul>
      )}

      {tiles.length > 0 && (
        <SheetCard label={tr("gallery.label")} title={tr("gallery.title")} className="ct-gallery">
          <ul className="ct-tiles">
            {tiles.map(({ item, media }) => {
              const w = stateWord(item, short, tr);
              const ai = aiMediaWord(item.provenance, media.kind, tr);
              const date = item.published_at ?? item.scheduled_for;
              const failed = () => setUnloadable((cur) => new Set(cur).add(media.src));
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className="ct-tile"
                    aria-pressed={open?.id === item.id}
                    onClick={() => pick(item.id)}
                  >
                    <span className="ct-tile-frame" title={item.title}>
                      {media.kind === "video" ? (
                        // The fragment makes the first frame the poster where metadata alone draws none.
                        <video
                          src={`${media.src}#t=0.1`}
                          preload="metadata"
                          muted
                          playsInline
                          tabIndex={-1}
                          aria-hidden="true"
                          onError={failed}
                        />
                      ) : (
                        // A plain img: the store's own address, which next/image is not configured for.
                        <img
                          src={media.src}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          onError={failed}
                        />
                      )}
                    </span>
                    <span className="sr-only">{item.title}</span>
                    <span className="ct-tile-line">
                      {item.channel_label} · {date ? short(date) : tr("anytime")}
                    </span>
                    <span className={`word boxed ${w.tone}`}>{w.word}</span>
                    {ai && <span className="ct-tile-ai">{ai}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </SheetCard>
      )}

      <div className="ct-grid">
        <SheetCard
          label={tr("queue.label")}
          title={s.realWrites ? tr("queue.titleOn") : tr("queue.titleOff")}
          className="ct-queue"
          id="ct-calendar"
        >
          {calendar && (
            <div className="ct-cal">
              <p className="vz-cap">
                {rangeOf(
                  short(calendarDays[0]?.date ?? today),
                  short(calendarDays[calendarDays.length - 1]?.date ?? today),
                  locale,
                )}
              </p>
              <div className="ct-cal-grid" role="group" aria-label={tr("calendar.label")}>
                {weekdayInitials(locale).map((initial, i) => (
                  <span key={i} className="ct-cal-wd" aria-hidden="true">
                    {initial}
                  </span>
                ))}
                {calendarDays.map((d) => (
                  <div
                    key={d.date}
                    className={`ct-cal-day${d.today ? " today" : ""}`}
                    title={day(d.date)}
                    aria-current={d.today ? "date" : undefined}
                  >
                    <span className="ct-cal-num" aria-hidden="true">
                      {num(Number(d.date.slice(8)), 0, locale)}
                    </span>
                    {d.entries.map((e) => {
                      const item = itemById.get(e.id);
                      if (!item) return null;
                      return (
                        <button
                          key={e.id}
                          type="button"
                          className="ct-cal-pick"
                          title={item.title}
                          aria-label={`${item.title} · ${stateWord(item, short, tr).word}`}
                          aria-pressed={open?.id === e.id}
                          onClick={() => pick(e.id)}
                        >
                          <span className={MARK_TONE[e.mark]} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <ul className="vz-keys" aria-hidden="true">
                {MARK_ORDER.filter((mark) => marksDrawn.has(mark)).map((mark) => (
                  <li key={mark}>
                    <span className={`vz-key ${MARK_TONE[mark]}`} />
                    {markWord(mark)}
                  </li>
                ))}
              </ul>
              <ul className="sr-only">
                {calendarDays
                  .filter((d) => d.entries.length > 0)
                  .map((d) => (
                    <li key={d.date}>
                      {day(d.date)}:{" "}
                      {d.entries
                        .map((e) => `${itemById.get(e.id)?.title ?? ""} (${markWord(e.mark)})`)
                        .join("; ")}
                    </li>
                  ))}
              </ul>
              {calendar.outside > 0 && (
                <p className="ct-cal-more">{tr("calendar.outside", { count: calendar.outside })}</p>
              )}
            </div>
          )}
          {s.items.length === 0 ? (
            <p className="ct-empty">
              {s.watchingUntil
                ? tr("queue.emptyWatching", { day: watchDay(s.watchingUntil, locale) })
                : tr("queue.empty")}
            </p>
          ) : (
            <table className="rt ct-table">
              <thead>
                <tr>
                  <th scope="col">{tr("col.draft")}</th>
                  <th scope="col">{tr("col.channel")}</th>
                  <th scope="col">{tr("col.goal")}</th>
                  <th scope="col">{tr("col.state")}</th>
                  <th scope="col" className="num">
                    {tr("col.date")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.items.map((item) => {
                  const w = stateWord(item, short, tr);
                  const goal = item.goal_id ? goalById.get(item.goal_id) : undefined;
                  return (
                    <tr key={item.id} className={open?.id === item.id ? "on" : undefined}>
                      <th scope="row" data-label={tr("col.draft")}>
                        <button
                          type="button"
                          className="ct-pick"
                          aria-pressed={open?.id === item.id}
                          onClick={() => pick(item.id)}
                        >
                          {item.title}
                        </button>
                        <span className="src ct-sub">
                          {shortId("C", item.id)} · {kindWord(item.kind)}
                        </span>
                      </th>
                      <td data-label={tr("col.channel")} className="ct-mono">
                        {item.channel_label}
                      </td>
                      <td data-label={tr("col.goal")}>{goal?.statement ?? "-"}</td>
                      <td data-label={tr("col.state")}>
                        <span className={`word boxed ${w.tone}`}>{w.word}</span>
                      </td>
                      <td data-label={tr("col.date")} className="num">
                        {item.scheduled_for ? short(item.scheduled_for) : tr("anytime")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </SheetCard>

        {open && (
          <section
            className="cs ct-detail"
            ref={detailRef}
            aria-label={tr("detail.aria", { id: shortId("C", open.id) })}
          >
            <header className="cs-head">
              <div>
                <p className="cs-label">
                  {shortId("C", open.id)} · {open.channel_label} {kindWord(open.kind)} ·{" "}
                  {open.scheduled_for ? day(open.scheduled_for) : tr("anytime")}
                </p>
                <h2 className="cs-title">{open.title}</h2>
              </div>
              <div className="cs-meta">
                <span className={`word boxed ${stateWord(open, short, tr).tone}`}>
                  {stateWord(open, short, tr).word}
                </span>
              </div>
            </header>
            <div className="cs-body ct-detail-body">
              {open.media_path && (
                <div className="ct-media">
                  <span>{tr("detail.media", { what: mediaWord(open.provenance, tr) })}</span>
                  <span className="ct-media-path">{open.media_path.split("/").pop()}</span>
                </div>
              )}
              <div className="ct-detail-text">
                <p className="cs-label">
                  {open.kind === "email" ? tr("detail.email") : tr("detail.caption")}
                </p>
                <p className="ct-caption">{open.body}</p>
                <p className="cs-label ct-gap">{tr("detail.writtenFrom")}</p>
                <ul className="ct-from">
                  {(open.provenance?.evidence ?? []).map((key) => (
                    <li key={key}>{evidenceLine(key, open)}</li>
                  ))}
                  {open.goal_id && goalById.get(open.goal_id)?.statement && (
                    <li>
                      {tr("detail.serves", { goal: goalById.get(open.goal_id)?.statement ?? "" })}
                    </li>
                  )}
                  {learnedWords(open.provenance?.lessons, tr) && (
                    <li>{learnedWords(open.provenance?.lessons, tr)}</li>
                  )}
                  <li>{tr("detail.disclosure", { text: open.disclosure })}</li>
                </ul>
              </div>
            </div>
            <footer className="ct-detail-foot">
              {s.publishNotes[open.id] && (
                <p className="ct-why">
                  {tr("detail.notPublishing", { why: s.publishNotes[open.id] ?? "" })}
                </p>
              )}
              {s.media?.superseded.includes(open.id) && (
                <p className="ct-why">{tr("detail.superseded")}</p>
              )}
              {s.media && s.media.footage[open.id] !== undefined && (
                <MediaPanel
                  key={open.id}
                  item={open}
                  media={s.media}
                  busy={s.busy}
                  setBusy={(busy) =>
                    setState((cur) => (cur.phase === "ready" ? { ...cur, busy } : cur))
                  }
                  onDone={async (notice) => {
                    await load();
                    setState((cur) => (cur.phase === "ready" ? { ...cur, notice } : cur));
                  }}
                  onPick={pick}
                />
              )}
              {s.tiktok[open.id] && (
                <TikTokPostForm
                  key={`tiktok-${open.id}`}
                  itemId={open.id}
                  state={s.tiktok[open.id] as TikTokItemStateLike}
                  aiGenerated={open.provenance?.media?.is_ai_generated === true}
                  busy={s.busy}
                  onSaved={async (notice) => {
                    await load();
                    setState((cur) => (cur.phase === "ready" ? { ...cur, notice } : cur));
                  }}
                />
              )}
              {open.status === "failed" && open.last_error && (
                <p className="ct-why">
                  <span className="word alarm">{tr("state.failed")}</span> {open.last_error}
                </p>
              )}
              {publishLine(open, s.realWrites, tr) && (
                <p className="ct-why">
                  {open.status === "publishing" && open.last_error && (
                    <>
                      <span className="word drift">{tr("state.unconfirmed")}</span>{" "}
                    </>
                  )}
                  {publishLine(open, s.realWrites, tr)}
                  {(open.status === "published" || open.status === "withdrawn") &&
                    open.platform_post_id && (
                      <span className="src ct-sub">
                        {tr("detail.platformId", {
                          platform: platformWord(open.platform, tr),
                          id: open.platform_post_id,
                        })}
                        {open.published_at &&
                          ` · ${tr("detail.posted", { day: day(open.published_at) })}`}
                      </span>
                    )}
                </p>
              )}
              {(() => {
                const perf = performanceLine(s.performance[open.id], tr, locale);
                if (!perf) return null;
                // This post's own figures only: two posts are never drawn on one scale.
                const bars = performanceBars(s.performance[open.id], tr, locale);
                return (
                  <>
                    {bars && (
                      <HBars
                        label={`${tr("perf.measured")} ${perf.word} ${perf.figures ?? ""}`.trim()}
                        rows={bars.rows.map((r) => ({ ...r, tone: bars.tone }))}
                      />
                    )}
                    <p className="ct-why">
                      {tr("perf.measured")}{" "}
                      <span className={`word boxed ${perf.tone}`}>{perf.word}</span>
                      {perf.figures && ` ${perf.figures}`}
                      <span className="src ct-sub">{perf.arithmetic}</span>
                    </p>
                  </>
                );
              })()}
              {(() => {
                // P3-54: "Run this as an ad" — a proposal, never a send from this screen.
                const ad = adLine(s.ads[open.id], s.realWrites, tr);
                if (!ad) return null;
                return (
                  <p className="ct-why">
                    {ad.word && (
                      <>
                        <span className={`word boxed ${ad.tone}`}>{ad.word}</span>{" "}
                      </>
                    )}
                    {ad.text}
                  </p>
                );
              })()}
              {open.status === "published" && s.confirmWithdraw === open.id && (
                <p className="ct-why">
                  {tr("withdraw.confirm", { platform: platformWord(open.platform, tr) })}
                </p>
              )}
              <div className="ct-actions">
                {open.status === "published" && open.platform_url && (
                  <a
                    className="prop-btn"
                    href={open.platform_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {tr("withdraw.openOn", { platform: platformWord(open.platform, tr) })}{" "}
                    <span aria-hidden="true">→</span>
                  </a>
                )}
                {/* TikTok's API has no delete: the post comes down in the TikTok app. */}
                {open.status === "published" && open.platform === "tiktok" && (
                  <p className="ct-why">{tr("tiktok.noDelete")}</p>
                )}
                {open.status === "published" &&
                  open.platform !== "tiktok" &&
                  (s.confirmWithdraw === open.id ? (
                    <>
                      <button
                        type="button"
                        className="prop-btn"
                        disabled={s.busy}
                        onClick={() =>
                          void act(
                            { action: "withdraw", item_id: open.id },
                            tr("withdraw.done", { platform: platformWord(open.platform, tr) }),
                          )
                        }
                      >
                        {tr("withdraw.yes")}
                      </button>
                      <button
                        type="button"
                        className="prop-btn quiet"
                        disabled={s.busy}
                        onClick={() => setState({ ...s, confirmWithdraw: null })}
                      >
                        {tr("withdraw.keep")}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="prop-btn"
                      disabled={s.busy}
                      onClick={() => setState({ ...s, confirmWithdraw: open.id })}
                    >
                      {tr("withdraw.button")}
                    </button>
                  ))}
                {(() => {
                  const ad = adLine(s.ads[open.id], s.realWrites, tr);
                  if (ad?.action === "run_ad") {
                    return (
                      <button
                        type="button"
                        className="prop-btn"
                        disabled={s.busy}
                        onClick={() =>
                          void act({ action: "run_ad", item_id: open.id }, tr("ad.runDone"))
                        }
                      >
                        {tr("ad.run")}
                      </button>
                    );
                  }
                  if (ad?.action === "go_live") {
                    const build = s.ads[open.id]?.build;
                    if (!build) return null;
                    return (
                      <button
                        type="button"
                        className="prop-btn"
                        disabled={s.busy}
                        onClick={() =>
                          void act({ action: "go_live", build_id: build.id }, tr("ad.goLiveDone"))
                        }
                      >
                        {tr("ad.goLive")}
                      </button>
                    );
                  }
                  if (ad?.action === "queue" && open.publish_proposal_id === null) {
                    return (
                      <Link className="prop-btn" href="/proposals">
                        {tr("ad.decide")} <span aria-hidden="true">→</span>
                      </Link>
                    );
                  }
                  return null;
                })()}
                {open.publish_proposal_id === null &&
                  open.status === "drafted" &&
                  (open.kind === "post" || open.kind === "video") &&
                  !s.publishNotes[open.id] && (
                    <button
                      type="button"
                      className="prop-btn"
                      disabled={s.busy}
                      onClick={() =>
                        void (async () => {
                          setState({ ...s, busy: true, notice: null });
                          const res = await fetch("/api/content/media", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ action: "propose_publish", item_id: open.id }),
                          });
                          const j = (await res.json().catch(() => ({}))) as {
                            error?: string;
                            proposed?: number;
                            reason?: string | null;
                          };
                          await load();
                          const notice = !res.ok
                            ? (j.error ?? tr("failed"))
                            : j.proposed
                              ? tr("publish.proposed")
                              : tr("publish.notProposed", {
                                  reason: j.reason ?? tr("publish.notQualify"),
                                });
                          setState((cur) => (cur.phase === "ready" ? { ...cur, notice } : cur));
                        })()
                      }
                    >
                      {tr("publish.propose")}
                    </button>
                  )}
                {open.publish_proposal_id !== null && open.status === "drafted" && (
                  <Link className="prop-btn ct-wide" href="/proposals">
                    {tr("action.decide")} <span aria-hidden="true">→</span>
                  </Link>
                )}
                {open.status === "failed" && open.paused_connection_id && (
                  <Link className="prop-btn" href="/connections">
                    {tr("action.reconnect")} <span aria-hidden="true">→</span>
                  </Link>
                )}
                {s.publishConnect.includes(open.id) && (
                  <Link className="prop-btn" href="/connections">
                    {tr("action.connections")} <span aria-hidden="true">→</span>
                  </Link>
                )}
              </div>
              {s.realWrites ? (
                <Fold className="ct-fine">
                  <p>{tr("fine.on")}</p>
                </Fold>
              ) : (
                <p className="ct-fine">{tr("fine.off")}</p>
              )}
            </footer>
          </section>
        )}
      </div>

      <div className="ct-lower">
        <SheetCard label={tr("goals.label")} title={tr("goals.title")} id="ct-goals">
          {s.goals.length === 0 ? (
            <p className="ct-empty">{tr("goals.empty")}</p>
          ) : (
            <ul className="ct-goal-list">
              {s.goals.map((g) => (
                <li key={g.goal_id}>
                  <span>{g.statement ?? "-"}</span>
                  <span className="ct-goal-meta">
                    {g.horizon ? horizonWord(g.horizon, tr) : ""}
                    {g.target_value ? ` · ${tr("goals.target", { value: g.target_value })}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {s.suggestions.length > 0 && (
            <div className="ct-suggest">
              {s.suggestions.map((sug) => (
                <button
                  key={sug.source}
                  type="button"
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
            className="ct-form"
            onSubmit={(e) => {
              e.preventDefault();
              void addGoal(s.newGoal);
            }}
          >
            <label className="cs-label" htmlFor="ct-new-goal">
              {tr("goals.inputLabel")}
            </label>
            <input
              id="ct-new-goal"
              className="ct-input"
              placeholder={tr("goals.placeholder")}
              value={s.newGoal}
              onChange={(e) => setState({ ...s, newGoal: e.target.value })}
            />
            <button className="prop-btn" disabled={s.busy || s.newGoal.trim() === ""}>
              {tr("goals.add")}
            </button>
          </form>
        </SheetCard>

        <SheetCard label={tr("propose.label")} title={tr("propose.title")}>
          {s.watchingUntil && (
            <p className="ct-prose">
              {tr("propose.watching", { day: watchDay(s.watchingUntil, locale) })}
            </p>
          )}
          <div className="ct-actions">
            <button
              type="button"
              className="prop-btn"
              disabled={s.busy || s.watchingUntil !== null}
              onClick={() => void act({ action: "plan" }, tr("propose.calendarDone"))}
            >
              {tr("propose.calendar")}
            </button>
            <button
              type="button"
              className="prop-btn"
              disabled={s.busy || s.watchingUntil !== null}
              onClick={() => void act({ action: "shotlist" }, tr("propose.shotlistDone"))}
            >
              {tr("propose.shotlist")}
            </button>
          </div>
          {s.producible.length > 0 && (
            <>
              <p className="cs-label ct-gap">{tr("propose.ready")}</p>
              <ul className="ct-producible">
                {s.producible.map((p) => (
                  <li key={p.id}>
                    <span>{p.summary}</span>
                    <button
                      type="button"
                      className="next"
                      disabled={s.busy}
                      onClick={() =>
                        void act({ action: "produce", proposal_id: p.id }, tr("propose.drafted"))
                      }
                    >
                      {tr("propose.draft")} <span aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </SheetCard>
      </div>
    </main>
  );
}
