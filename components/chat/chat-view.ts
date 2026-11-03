// Ask me anything — what the conversation sheet prints around the turns,
// pure so it is tested (the owner's chat design, 2026-10-17). The title is
// the owner's latest question, the side sheet lists their earlier ones,
// and each turn's stamp is read off its stored time. Nothing is invented:
// with no turns there is no question to title the sheet with.
//
// L-3c (TASKS-LANGUAGES.md): the fixed words are the "chat" catalogue
// through an optional translator, English by default from messages/en.json,
// so English says exactly what it always said; stamps in the reader's
// locale. The turns themselves, and what a change card says about the
// change (its summary, values, screen name, button and result, built on
// the server), are shown as they are.

import type { ChangeCardView } from "../../lib/assistant/view";
import { dayMonth } from "../../lib/i18n/format";
import type { AppLocale } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

const EN = (): Tr => englishTr("chat");

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

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "14:10" today, "9 Oct 14:10" before — the browser's local time; the day
 * and month in the reader's own short form outside English.
 */
export function stamp(at: string, now: number, locale: AppLocale = "en"): string {
  const ms = parseTs(at);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (new Date(now).toDateString() === d.toDateString()) return hm;
  if (locale !== "en") {
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return `${dayMonth(day, locale)} ${hm}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""} ${hm}`;
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
  tr: Tr = EN(),
): { word: string; tone: "ok" | "low" | "drift" } | null {
  switch (card.status) {
    case "applied":
      return { word: tr("flag.applied"), tone: "ok" };
    case "queued":
      return { word: tr("flag.queued"), tone: "low" };
    case "stale":
      return { word: tr("flag.stale"), tone: "drift" };
    default:
      return null;
  }
}

/** The kicker's key under "chat.cardKicker", by the card's state. */
export function cardKickerKey(
  card: Pick<ChangeCardView, "status" | "prepare">,
): "link_only" | "applied" | "queued" | "stale" | "proposal" | "prepared" {
  if (card.status === "link_only") return "link_only";
  if (card.status === "applied") return "applied";
  if (card.status === "queued") return "queued";
  if (card.status === "stale") return "stale";
  if (card.prepare === "proposal") return "proposal";
  return "prepared";
}

/** The mono line above the change, in first person. */
export function cardKicker(
  card: Pick<ChangeCardView, "status" | "prepare" | "screen">,
  tr: Tr = EN(),
): string {
  return tr(`cardKicker.${cardKickerKey(card)}`, { screen: card.screen });
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
