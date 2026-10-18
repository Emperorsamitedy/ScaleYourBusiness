// How I work — the words and dates the mode screen prints, pure so they
// are tested (the owner's How-I-work design, 2026-10-17). Everything is
// read off the stored decision: the mode, the CURRENT watch length (an
// override can have changed it since the decision), when it was decided,
// when the watch ends, and any override on record.

export interface ModeDecision {
  mode: "instant" | "watching";
  watch_weeks: number | null;
  decided_at: string;
  reasons: string[];
  reasoning: string;
  review_at: string;
  owner_override?: {
    kind: "extend" | "shorten";
    from_weeks: number;
    to_weeks: number;
    at: string;
  } | null;
}

const DAY_MS = 86_400_000;

/** Postgres prints "2026-10-17 15:20:35.26+00"; make it ISO before parsing. */
export function parseTs(s: string): number {
  const iso = s
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(s) : ms;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep" — fixed three-letter months, whatever the runtime's locale data says. */
export const dayMonth = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
};

/** The screen's one line. */
export function headline(d: ModeDecision): string {
  if (d.mode === "watching" && d.watch_weeks !== null) {
    return `Watching first, for ${d.watch_weeks * 7} days.`;
  }
  return "Acting right away.";
}

/** Day N of M of the watch — the same arithmetic as the menu's count. */
export function watchDay(d: ModeDecision, now: number): { day: number; of: number } | null {
  if (d.mode !== "watching" || d.watch_weeks === null) return null;
  const of = d.watch_weeks * 7;
  const left = Math.max(0, Math.ceil((parseTs(d.review_at) - now) / DAY_MS));
  return { day: Math.min(of, Math.max(1, of - left)), of };
}

/** "Chosen 29 Sep", plus the override when one is on record. */
export function chosenLine(d: ModeDecision): string {
  const chosen = `Chosen ${dayMonth(parseTs(d.decided_at))}`;
  const o = d.owner_override;
  if (!o) return chosen;
  const verb = o.kind === "extend" ? "extended" : "shortened";
  return `${chosen} · ${verb} to ${o.to_weeks} weeks ${dayMonth(parseTs(o.at))}`;
}

/** Months read as years once they stop being months-sized. */
export const humanise = (reason: string): string =>
  reason.replace(/(\d+) months/g, (m, n: string) => {
    const months = Number(n);
    if (months < 24) return m;
    return `${Math.round(months / 12)} years`;
  });
