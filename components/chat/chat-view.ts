// Ask me anything — what the conversation sheet prints around the turns,
// pure so it is tested (the owner's chat design, 2026-10-17). The title is
// the owner's latest question, the side sheet lists their earlier ones,
// and each turn's stamp is read off its stored time. Nothing is invented:
// with no turns there is no question to title the sheet with.

import type { ChangeCardView } from "../../lib/assistant/view";

export interface Turn {
  id: string;
  role: "owner" | "system";
  text: string;
  at: string;
  intent: string | null;
}

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

/** "14:10" today, "9 Oct 14:10" before. */
export function stamp(at: string, now: number): string {
  const ms = parseTs(at);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return new Date(now).toDateString() === d.toDateString()
    ? hm
    : `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""} ${hm}`;
}

const ownerTurns = (turns: readonly Turn[]) =>
  turns.filter((t) => t.role === "owner" && !t.id.startsWith("tmp-"));

/** The sheet's title: the owner's latest question, or null when there is none. */
export function latestQuestion(turns: readonly Turn[]): string | null {
  const own = turns.filter((t) => t.role === "owner");
  return own[own.length - 1]?.text ?? null;
}

/** Earlier questions, newest first, without the one in the title. */
export function earlierQuestions(turns: readonly Turn[], max = 6): Turn[] {
  const own = ownerTurns(turns);
  const latest = turns.filter((t) => t.role === "owner").pop();
  return own
    .filter((t) => t !== latest)
    .reverse()
    .slice(0, max);
}

/** A reply's paragraphs, as the model wrote them. */
export const paragraphs = (text: string): string[] =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");

/* ── feature 33: the change card ── */

export type { ChangeCardView };

/** The cards a reply carries; a question asked or answered draws none (the reply says it). */
export function cardsFor(replyId: string, cards: readonly ChangeCardView[]): ChangeCardView[] {
  return cards.filter(
    (c) => c.reply_id === replyId && c.status !== "asked" && c.status !== "superseded",
  );
}

/** The card's worded status: the word carries the meaning, the tone only tints it. */
export function cardFlag(
  card: Pick<ChangeCardView, "status" | "prepare">,
): { word: string; tone: "ok" | "low" | "drift" } | null {
  switch (card.status) {
    case "applied":
      return { word: "Changed", tone: "ok" };
    case "queued":
      return { word: "In your queue", tone: "low" };
    case "stale":
      return { word: "Not changed", tone: "drift" };
    default:
      return null;
  }
}

/** The mono line above the change, in first person. */
export function cardKicker(card: Pick<ChangeCardView, "status" | "prepare" | "screen">): string {
  if (card.status === "link_only") return `Yours to change · ${card.screen}`;
  if (card.status === "applied") return `Made · ${card.screen}`;
  if (card.status === "queued") return `In your queue · ${card.screen}`;
  if (card.status === "stale") return `Not made · ${card.screen}`;
  if (card.prepare === "proposal") return `Drafted for your queue · ${card.screen}`;
  return `Drafted, not yet made · ${card.screen}`;
}

/** Whether the confirming button still applies. */
export const canConfirm = (card: Pick<ChangeCardView, "status" | "confirm">): boolean =>
  card.status === "prepared" && card.confirm !== null;

/** Replace one card by id, or add it — the thread's cards after a post or a click. */
export function upsertCard(
  cards: readonly ChangeCardView[],
  card: ChangeCardView,
): ChangeCardView[] {
  return cards.some((c) => c.id === card.id)
    ? cards.map((c) => (c.id === card.id ? card : c))
    : [...cards, card];
}
