// Pure read-model for the owner's support screen (the instrument design,
// 2026-10-17): the headline, the counts line, and how each conversation
// is worded in the list. Counted from what the API returns; nothing here
// reads a customer's message as anything but text (rule 24).

export type TicketReason = "customer_asked" | "no_answer" | "cost_cap" | "conversation_cap";
export type TicketStatus = "open" | "answered" | "closed";
export type ConversationStatus = "open" | "escalated" | "closed";

export const REASON_WORD: Record<TicketReason, string> = {
  customer_asked: "asked for a person",
  no_answer: "no approved answer",
  cost_cap: "spend cap reached",
  conversation_cap: "conversation ran long",
};

export function supportHeadline(publicAnswers: number): string {
  return publicAnswers === 0
    ? "Nothing approved yet, so every question comes to you."
    : "The assistant only says what you approved.";
}

const NUMBER_WORD = [
  "Nobody",
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

export function waitingTitle(waiting: number): string {
  if (waiting === 0) return "Nobody waiting for you";
  return `${NUMBER_WORD[waiting] ?? String(waiting)} waiting for you`;
}

/** The state line under a conversation in the list, and its tone. */
export function conversationWord(
  status: ConversationStatus,
  ticket: { status: TicketStatus; reason: TicketReason } | null,
): { word: string; tone: "drift" | "ok" | "low" } {
  if (ticket?.status === "open") return { word: "waiting for you", tone: "drift" };
  if (ticket?.status === "answered") return { word: "handed to you · you answered", tone: "ok" };
  if (ticket?.status === "closed") return { word: "handed to you · closed", tone: "low" };
  if (status === "escalated") return { word: "handed to you", tone: "drift" };
  if (status === "closed") return { word: "closed", tone: "low" };
  return { word: "open", tone: "low" };
}

/** "13:52" today, "Fri" this week, "12 Oct" before that. */
export function whenShort(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  if (now.getTime() - d.getTime() < 6 * 86_400_000 && d.getTime() <= now.getTime()) {
    return d.toLocaleDateString("en-GB", { weekday: "short" });
  }
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
