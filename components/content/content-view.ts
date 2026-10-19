// Pure read-model for the content screen (the owner's instrument design,
// 2026-10-17): the per-channel strips, each row's state word, and the
// headline — all counted from the queue the API returns. No targets are
// invented: a strip's "planned" is what is actually in the queue for
// that channel, and "posted" is what actually published.

export type ContentStatus =
  "drafted" | "queued" | "publishing" | "published" | "failed" | "withdrawn";

export interface QueueItem {
  id: string;
  kind: "post" | "email" | "shot_list" | "video";
  channel_label: string;
  scheduled_for: string | null;
  status: ContentStatus;
  publish_proposal_id: string | null;
  published_at: string | null;
  /** The owner's sentence: why it failed, why it's waiting, or that Meta didn't confirm it. */
  last_error?: string | null;
}

export interface ChannelStrip {
  channel: string;
  planned: number;
  posted: number;
  first: string | null;
  last: string | null;
  /** Unposted items dated before today. */
  overdue: number;
  /** The next unposted date, today or later. */
  next: string | null;
  state: "behind" | "on_pace" | "done";
}

const LIVE: ReadonlySet<ContentStatus> = new Set(["drafted", "queued", "publishing", "failed"]);

/** One strip per channel, in the order channels first appear in the queue. */
export function channelStrips(items: readonly QueueItem[], today: string): ChannelStrip[] {
  const by = new Map<string, QueueItem[]>();
  for (const item of items) {
    if (item.status === "withdrawn") continue;
    by.set(item.channel_label, [...(by.get(item.channel_label) ?? []), item]);
  }
  return [...by.entries()].map(([channel, list]) => {
    const dates = list.map((i) => i.scheduled_for).filter((d): d is string => d !== null);
    dates.sort();
    const unposted = list.filter((i) => LIVE.has(i.status));
    const overdue = unposted.filter((i) => i.scheduled_for !== null && i.scheduled_for < today);
    const upcoming = unposted
      .map((i) => i.scheduled_for)
      .filter((d): d is string => d !== null && d >= today)
      .sort();
    const posted = list.filter((i) => i.status === "published").length;
    return {
      channel,
      planned: list.length,
      posted,
      first: dates[0] ?? null,
      last: dates[dates.length - 1] ?? null,
      overdue: overdue.length,
      next: upcoming[0] ?? null,
      state: overdue.length > 0 ? "behind" : unposted.length === 0 ? "done" : "on_pace",
    };
  });
}

export type Tone = "live" | "ok" | "low" | "drift" | "alarm";

/** The state word a row wears, and the tone that tints it. */
export function stateWord(
  item: QueueItem,
  dayWord: (iso: string) => string,
): {
  word: string;
  tone: Tone;
} {
  switch (item.status) {
    case "drafted":
      return item.publish_proposal_id !== null
        ? { word: "in your queue", tone: "live" }
        : { word: "drafted", tone: "low" };
    case "queued":
      return {
        word: item.scheduled_for ? `scheduled ${dayWord(item.scheduled_for)}` : "scheduled",
        tone: "ok",
      };
    case "publishing":
      // P3-21d: a run that lost Meta's answer leaves it here with a sentence — never re-sent.
      return item.last_error
        ? { word: "unconfirmed", tone: "drift" }
        : { word: "publishing", tone: "live" };
    case "published":
      return {
        word: item.published_at ? `posted ${dayWord(item.published_at.slice(0, 10))}` : "posted",
        tone: "ok",
      };
    case "failed":
      return { word: "failed", tone: "alarm" };
    case "withdrawn":
      return { word: "withdrawn", tone: "low" };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const NUMBER_WORD = [
  "None",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
];
const lead = (n: number) => NUMBER_WORD[n] ?? String(n);

/** The page's one sentence, from the queue as it stands. */
export function contentHeadline(args: {
  items: readonly QueueItem[];
  producible: number;
  blocked: number;
  nextDate: string | null;
}): string {
  const { items, producible, blocked, nextDate } = args;
  const drafts = items.filter((i) => i.status === "drafted");
  const inQueue = drafts.filter((i) => i.publish_proposal_id !== null).length;
  if (items.length === 0) {
    return producible > 0
      ? `Nothing drafted yet. ${lead(producible)} approved ${producible === 1 ? "plan is" : "plans are"} ready to draft.`
      : "Nothing drafted yet.";
  }
  if (drafts.length === 0) {
    const scheduled = items.filter((i) => i.status === "queued").length;
    const posted = items.filter((i) => i.status === "published").length;
    return `${scheduled} scheduled. ${lead(posted)} posted.`;
  }
  const first = `${plural(drafts.length, "draft")}.`;
  if (inQueue > 0) return `${first} ${lead(inQueue)} ${inQueue === 1 ? "needs" : "need"} your yes.`;
  if (producible > 0) {
    return `${first} ${lead(producible)} more approved ${producible === 1 ? "plan" : "plans"} to draft.`;
  }
  if (blocked >= drafts.length) return `${first} None can post yet.`;
  if (nextDate) return `${first} The next one is due ${nextDate}.`;
  return first;
}

const PLATFORM_WORD: Readonly<Record<string, string>> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

/** The platform's own name for a stored platform value ("instagram" → "Instagram"). */
export function platformWord(platform: string | null): string {
  return platform ? (PLATFORM_WORD[platform] ?? platform) : "the platform";
}

/**
 * P3-21e: the one line under an item that says where it stands on its way
 * out — published where, waiting why, or that publishing is switched off
 * (the Session D real-write gate). Null when the row's state word is enough.
 */
export function publishLine(
  item: QueueItem & { platform: string | null },
  realWrites: boolean,
): string | null {
  switch (item.status) {
    case "queued":
      if (item.last_error) return item.last_error;
      return realWrites
        ? "Approved. It goes out at its posting time, through the runner; the emergency stop halts it."
        : "Approved, and waiting for publishing to be switched on. Nothing is sent to Meta until then.";
    case "publishing":
      return item.last_error ?? `Going out to ${platformWord(item.platform)} now.`;
    case "published":
      return `Live on ${platformWord(item.platform)}.`;
    case "withdrawn":
      return `Withdrawn: deleted from ${platformWord(item.platform)}. Its record stays here.`;
    default:
      return null;
  }
}

/** A short, real handle for an item: the first four hex digits of its id. */
export function shortId(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
}

/** P3-23b: what /content needs of a published item's measured outcome (lib/trust/post-readback). */
export interface PerformanceLike {
  verdict: "helped" | "did_nothing" | "backfired" | "too_early" | "unmeasured";
  audience_metric: "reach" | "views" | null;
  age_days: number | null;
  figures: { views: number | null; reach: number | null; interactions: number | null } | null;
  arithmetic: string;
}

const VERDICT_WORD: Readonly<Record<PerformanceLike["verdict"], { word: string; tone: Tone }>> = {
  helped: { word: "helped", tone: "ok" },
  did_nothing: { word: "did nothing", tone: "low" },
  backfired: { word: "backfired", tone: "alarm" },
  too_early: { word: "too early", tone: "low" },
  unmeasured: { word: "unmeasured", tone: "low" },
};

const grouped = (n: number) => n.toLocaleString("en-GB").replace(/,/g, " ");

/**
 * P3-23b: the measured line under a published item — its own figures on
 * the day it is judged, the verdict word, and the arithmetic behind it.
 * Null when nothing has been measured yet (the verdict says why).
 */
export function performanceLine(p: PerformanceLike | undefined): {
  figures: string | null;
  word: string;
  tone: Tone;
  arithmetic: string;
} | null {
  if (!p) return null;
  const v = VERDICT_WORD[p.verdict];
  const f = p.figures;
  const parts: string[] = [];
  if (f) {
    if (f.reach !== null) parts.push(`reach ${grouped(f.reach)}`);
    if (f.views !== null) parts.push(`views ${grouped(f.views)}`);
    if (f.interactions !== null) parts.push(`interactions ${grouped(f.interactions)}`);
  }
  const figures =
    parts.length > 0 && p.age_days !== null ? `day ${p.age_days} · ${parts.join(" · ")}` : null;
  return { figures, word: v.word, tone: v.tone, arithmetic: p.arithmetic };
}
