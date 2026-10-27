// The creative studio's words, pure — counted from what the API returned,
// never invented. Tested in studio-view.test.ts.

import type { NicheView } from "../../lib/research/niche";

export type StudioNiche = Pick<NicheView, "set_up" | "blocked" | "last_read" | "groups">;

/** The screen's one display line: its main fact, from real data. */
export function studioHeadline(niche: StudioNiche, briefs: number, businessWord: string): string {
  const top = niche.groups[0];
  if (!top || !niche.last_read) {
    if (!niche.set_up) return "Niche research isn't set up yet.";
    if (niche.blocked) return "Meta's Ad Library can't show your niche's ads.";
  }
  if (!niche.last_read || !top) {
    return briefs > 0
      ? `${briefs === 1 ? "One brief" : `${briefs} briefs`} written; I haven't read your niche's ads yet.`
      : `I haven't read the ads in your ${businessWord}'s niche yet.`;
  }
  return `${top.page_name}'s ${top.format === "video" ? "video" : "ad"} has run ${top.running_days} days — the longest-running concept I found.`;
}

/** "142 days · LIVE" / "8 days · STOPPED". */
export function runningWords(g: { running_days: number; active: boolean }): {
  days: string;
  word: "LIVE" | "STOPPED";
} {
  return {
    days: `${g.running_days} day${g.running_days === 1 ? "" : "s"}`,
    word: g.active ? "LIVE" : "STOPPED",
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "26 Oct", in UTC so server and browser agree. */
export function dayText(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "26 Oct, 14:05 UTC" — when a fresh read becomes allowed. */
export function timeText(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${dayText(iso)}, ${hh}:${mm} UTC`;
}

/** Terms as the owner types them: comma-separated, trimmed, at most two. */
export function parseTerms(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 2);
}

/** What a citation's kind is called on screen. */
export const SOURCE_WORD: Readonly<Record<string, string>> = {
  fact: "YOUR FACT",
  finding: "DIAGNOSIS",
  voice: "YOUR WORDS",
  post: "YOUR POST",
  competitor: "COMPETITOR",
  ad: "NICHE AD",
};

/** The outcome of a research click, in a sentence. */
export function researchNotice(r: { status: string; why: string | null; fresh: boolean }): string {
  if (r.status === "read") {
    return r.fresh
      ? "Read the Ad Library just now."
      : "That read is still fresh, so I used it rather than asking Meta again.";
  }
  return r.why ?? "That didn't work. Try again.";
}
