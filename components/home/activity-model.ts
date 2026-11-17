// Home's activity feed (docs/DASHBOARD-OVERHAUL.md C6) — pure. One list,
// newest first, of what was read, noticed and checked (the watch's own log,
// GET /api/watch) and of what was proposed and answered (the queue, GET
// /api/proposals). Nothing here is invented: a row is a stored log line or
// a stored proposal's own time and words. The screen words the tags and
// reads the stored English lines back in the reader's language.

import { parseTs } from "../chat/chat-view";

/** A watch_activity row as /api/watch returns it. */
export interface LogLike {
  at: string;
  kind: string;
  detail: string;
  /** What the line is about, when the line itself doesn't say (a goal's statement). */
  subject?: string | null;
}

/** A proposal as the queue's lists carry it, whatever its state. */
export interface FeedProposal {
  id: string;
  status: string;
  action: { summary: string };
  created_at?: string | null;
  decided_at?: string | null;
  expires_at?: string | null;
  rejection_reason?: string | null;
  change_request?: string | null;
}

export type FeedTag =
  | "read"
  | "noticed"
  | "checked"
  | "watch"
  | "proposed"
  | "approved"
  | "declined"
  | "changes"
  | "done"
  | "expired"
  | "blocked";

export interface FeedRow {
  /** Stable across reads, so a row that was not there before can be told. */
  key: string;
  ms: number;
  tag: FeedTag;
  source: "log" | "proposal";
  /** A log line as stored, or a proposal's summary. */
  text: string;
  subject: string | null;
  /** The proposal behind the row, which a press opens. */
  proposal: string | null;
  /** The screen that owns a log line. */
  href: string | null;
  /** The owner's own words on a decline or a request for changes. */
  said: string | null;
}

/** What each kind of log line is, and the screen it belongs to. An unknown kind is the watch's. */
const LOG: Readonly<Record<string, { tag: FeedTag; href: string }>> = {
  connector_sync: { tag: "read", href: "/connections" },
  connection_paused: { tag: "noticed", href: "/connections" },
  connection_resumed: { tag: "watch", href: "/connections" },
  anomaly_detected: { tag: "noticed", href: "/watch" },
  anomaly_cleared: { tag: "noticed", href: "/watch" },
  watch_interrupted: { tag: "noticed", href: "/watch" },
  hours_findings: { tag: "noticed", href: "/hours" },
  goal_alert: { tag: "noticed", href: "/progress" },
  goal_progress: { tag: "checked", href: "/progress" },
  competitor_change: { tag: "noticed", href: "/competitors" },
  cash_warning: { tag: "noticed", href: "/cash" },
  stock_warning: { tag: "noticed", href: "/stock" },
  review_alert: { tag: "noticed", href: "/reviews" },
  approval_lapsed: { tag: "expired", href: "/proposals" },
  ad_changed: { tag: "done", href: "/history" },
  content_published: { tag: "done", href: "/content" },
  content_withdrawn: { tag: "done", href: "/content" },
};
const WATCH = { tag: "watch", href: "/watch" } as const;

/** A proposal's recorded answer as a tag; null while it waits or for a status with no word. */
export function answerOf(
  status: string,
): Exclude<FeedTag, "read" | "noticed" | "checked" | "watch" | "proposed"> | null {
  switch (status) {
    case "approved":
      return "approved";
    case "executed":
      return "done";
    case "rejected":
      return "declined";
    case "changes_requested":
      return "changes";
    case "expired":
      return "expired";
    case "blocked":
      return "blocked";
    default:
      return null;
  }
}

/** A short stable number for a line's words, so two lines at one instant get two keys. */
function wordsHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const said = (s: string | null | undefined): string | null => {
  const t = s?.trim() ?? "";
  return t === "" ? null : t;
};

/** The same line said again within this long is one row (two reads of one connection a moment apart). */
const SAME_LINE_MS = 60_000;

/**
 * Pure: the feed. Every log line; and for every proposal the moment it was
 * proposed (or held back) and, once answered or run out, that moment too.
 * A row whose time can't be read is left out rather than placed by guess.
 */
export function mergeFeed(log: readonly LogLike[], proposals: readonly FeedProposal[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const e of log) {
    const ms = parseTs(e.at);
    if (Number.isNaN(ms)) continue;
    const meta = LOG[e.kind] ?? WATCH;
    const subject = said(e.subject);
    rows.push({
      key: `l|${e.at}|${e.kind}|${subject ?? ""}|${wordsHash(e.detail)}`,
      ms,
      tag: meta.tag,
      source: "log",
      text: e.detail,
      subject,
      proposal: null,
      href: meta.href,
      said: null,
    });
  }
  for (const p of proposals) {
    const base = {
      source: "proposal" as const,
      text: p.action.summary,
      subject: null,
      proposal: p.id,
      href: null,
    };
    const answer = answerOf(p.status);
    const made = parseTs(p.created_at ?? "");
    if (!Number.isNaN(made)) {
      // A proposal held back was never put to the owner: that is its one row.
      const tag: FeedTag = answer === "blocked" ? "blocked" : "proposed";
      rows.push({ ...base, key: `p|${p.id}|${tag}`, ms: made, tag, said: null });
    }
    if (answer !== null && answer !== "blocked") {
      const at = answer === "expired" ? p.expires_at : p.decided_at;
      const ms = parseTs(at ?? "");
      if (!Number.isNaN(ms)) {
        rows.push({
          ...base,
          key: `p|${p.id}|${answer}`,
          ms,
          tag: answer,
          said:
            answer === "declined"
              ? said(p.rejection_reason)
              : answer === "changes"
                ? said(p.change_request)
                : null,
        });
      }
    }
  }
  rows.sort((a, b) => b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const lastSaid = new Map<string, number>();
  return rows.filter((r) => {
    if (r.source !== "log") return true;
    const line = `${r.tag}|${r.subject ?? ""}|${r.text}`;
    const newer = lastSaid.get(line);
    if (newer !== undefined && newer - r.ms <= SAME_LINE_MS) return false;
    lastSaid.set(line, r.ms);
    return true;
  });
}

/** Which of the feed's two reads have come back: the watch's log, the queue. */
export interface FeedSources {
  log: boolean;
  proposals: boolean;
}

/** The feed as it stood when it was last looked at. */
export interface FeedSeen extends FeedSources {
  keys: ReadonlySet<string>;
}

const from = (seen: FeedSources, r: FeedRow): boolean =>
  r.source === "log" ? seen.log : seen.proposals;

/**
 * Pure: the rows that are news since the feed was last looked at. Nothing
 * is news at first sight. A read that has only now come back brings none
 * either: its rows were there all along, the page had just not read them.
 */
export function newKeys(before: FeedSeen | null, rows: readonly FeedRow[]): string[] {
  if (before === null) return [];
  return rows.filter((r) => !before.keys.has(r.key) && from(before, r)).map((r) => r.key);
}

/**
 * Pure: what is remembered after `rows`. Looked at, all of it is seen. Not
 * looked at (the feed's tab is closed), only the first rows of each read
 * join what was seen: whatever arrives after them is still news when the
 * feed is opened.
 */
export function remember(
  before: FeedSeen | null,
  rows: readonly FeedRow[],
  sources: FeedSources,
  looked: boolean,
): FeedSeen {
  const had: FeedSources = before ?? { log: false, proposals: false };
  const first: FeedSources = {
    log: sources.log && !had.log,
    proposals: sources.proposals && !had.proposals,
  };
  const keys = new Set(looked ? [] : (before?.keys ?? []));
  for (const r of rows) if (looked || from(first, r)) keys.add(r.key);
  return {
    keys,
    log: had.log || sources.log,
    proposals: had.proposals || sources.proposals,
  };
}

export type AgoUnit = "second" | "minute" | "hour" | "day" | "week";

/**
 * Pure: how long ago, as Intl.RelativeTimeFormat takes it (a negative value
 * in one unit). Zero seconds reads "now". Null past four weeks: the screen
 * prints the date instead.
 */
export function ago(ms: number, now: number): { value: number; unit: AgoUnit } | null {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 45) return { value: 0, unit: "second" };
  if (s < 3600) return { value: -Math.max(1, Math.floor(s / 60)), unit: "minute" };
  if (s < 86_400) return { value: -Math.floor(s / 3600), unit: "hour" };
  if (s < 7 * 86_400) return { value: -Math.floor(s / 86_400), unit: "day" };
  if (s < 28 * 86_400) return { value: -Math.floor(s / (7 * 86_400)), unit: "week" };
  return null;
}
