// A change card as the chat draws it (feature 33) — pure, so the route
// and the screen share one shape. No ids on screen beyond what the click
// needs; the catalogue supplies the screen's name and the button's words.

import type { AssistantChangeRow } from "./changes";
import { entryFor } from "./catalogue";
import { isChangeKind } from "./kinds";

export interface ChangeCardView {
  id: string;
  reply_id: string | null;
  status: AssistantChangeRow["status"];
  summary: string;
  current: string | null;
  proposed: string | null;
  link: string;
  screen: string;
  /** The confirming button's words; null when only the link is offered. */
  confirm: string | null;
  /** "proposal" when the click queues it rather than writes it. */
  prepare: "direct" | "proposal" | "link";
  result: string | null;
}

export function cardView(row: AssistantChangeRow): ChangeCardView {
  const entry = isChangeKind(row.kind) ? entryFor(row.kind) : null;
  return {
    id: row.id,
    reply_id: row.reply_utterance_id,
    status: row.status,
    summary: row.summary,
    current: row.current_text,
    proposed: row.proposed_text,
    link: row.link,
    screen: entry?.screen ?? "the page",
    confirm: entry?.confirm ?? null,
    prepare: entry?.prepare ?? "link",
    result: row.result_text,
  };
}
