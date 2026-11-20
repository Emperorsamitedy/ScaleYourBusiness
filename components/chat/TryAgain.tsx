"use client";

// Under the line that stands where a reply from Lex did not come: ask again
// (docs/DASHBOARD-OVERHAUL.md, the first review's leftover). Shown only for
// the latest exchange and only where asking again could help: the server
// failed or never answered. A refusal that gave its reason has no button,
// because it would give the same reason again.

import type { Tr } from "../../lib/i18n/tr";
import type { Turn } from "./chat-view";
import type { Chat } from "./useChat";
import { isFailure } from "./useChat";

export function TryAgain({
  chat,
  turn,
  last,
  tr,
}: {
  chat: Chat;
  turn: Turn;
  /** Whether this turn is the thread's latest. */
  last: boolean;
  /** The "chat" catalogue. */
  tr: Tr;
}) {
  const s = chat.state;
  if (!last || s.phase !== "ready" || s.retry === null || s.busy || !isFailure(turn)) return null;
  return (
    <p className="ak-retry">
      <button type="button" className="act" onClick={() => void chat.retry(tr("sendFailed"))}>
        {tr("retry")}
      </button>
    </p>
  );
}
