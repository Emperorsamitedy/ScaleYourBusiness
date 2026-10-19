// How long a customer has waited, against the owner's stated reply time
// — Phase 4 Session C (P4-11). Pure arithmetic, no clock of its own.
//
// The reply time is what the OWNER said ("I reply within N hours"). With
// none set, the flag says so and nothing is invented. Clock hours, not
// business hours: a ticket that arrives on Friday evening is overdue on
// Saturday evening if the owner said 24 hours. The screen states that.
//
//   IN TIME   — more than a quarter of the reply time is left
//   DUE SOON  — a quarter or less is left, and some is
//   OVERDUE   — the reply time has passed (no time left at all)

export type SlaFlag = "in_time" | "due_soon" | "overdue" | "unset";

export interface SlaState {
  flag: SlaFlag;
  /** How long they have waited, in ms (never negative). */
  waited_ms: number;
  /** Time left before the reply time is reached; null when unset or overdue. */
  left_ms: number | null;
  /** Time past the reply time; null unless overdue. */
  over_ms: number | null;
}

const HOUR = 3_600_000;
/** DUE SOON from the moment this share of the reply time remains. */
export const DUE_SOON_SHARE = 0.25;
export const REPLY_HOURS_MIN = 1;
export const REPLY_HOURS_MAX = 720;

export function slaState(waitingSinceIso: string, now: Date, replyHours: number | null): SlaState {
  const waited_ms = Math.max(0, now.getTime() - new Date(waitingSinceIso).getTime());
  if (replyHours === null) return { flag: "unset", waited_ms, left_ms: null, over_ms: null };
  const window = replyHours * HOUR;
  const left = window - waited_ms;
  if (left <= 0) return { flag: "overdue", waited_ms, left_ms: null, over_ms: waited_ms - window };
  return {
    flag: left <= window * DUE_SOON_SHARE ? "due_soon" : "in_time",
    waited_ms,
    left_ms: left,
    over_ms: null,
  };
}

/** "45 min", "3 h 20 min", "2 d 4 h" — figures with units, rounded down to the minute. */
export function durationText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days} d` : `${days} d ${rest} h`;
}

/** The worded flag and its figure, as the ticket list prints them. */
export function slaWords(state: SlaState): { flag: string; detail: string } {
  switch (state.flag) {
    case "unset":
      return { flag: "No reply time set", detail: "" };
    case "overdue":
      return { flag: "Overdue", detail: `${durationText(state.over_ms ?? 0)} over` };
    case "due_soon":
      return { flag: "Due soon", detail: `${durationText(state.left_ms ?? 0)} left` };
    case "in_time":
      return { flag: "In time", detail: `${durationText(state.left_ms ?? 0)} left` };
  }
}

/** What the chat promises at handover: the owner's own reply time, or no promise at all. */
export function handoverTiming(replyHours: number | null): string {
  if (replyHours === null) return "A person will reply; I can't promise when.";
  return `A person usually replies within ${replyHours} ${replyHours === 1 ? "hour" : "hours"}.`;
}
