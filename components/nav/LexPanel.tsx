"use client";

// Lex on every screen (docs/DASHBOARD-OVERHAUL.md B2; conversation-channel
// §7: the conversation is "a persistent element rather than a screen").
// The frame keeps ONE conversation (components/chat/useChat.ts) and hands
// it to Home's composer, the conversation page and this sheet alike.
// "Ask Lex" opens the sheet on any screen; on Home and on the conversation
// page, where the conversation is already on the page, it puts the cursor
// in that page's own composer instead. A question handed over with the
// call (the palette's "Ask Lex: …") is asked at once.
//
// The sheet holds what the conversation page holds: the thread, the busy
// state, change cards, a request that became a proposal answered in place,
// and the composer in its foot. Nothing here runs anything: a reply only
// ever drafts, and the click on a card is the one thing that writes.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useMessages } from "next-intl";
import { ASSISTANT } from "../../lib/core/assistant";
import { ChatBusy, ChatTurn } from "../chat/ChatTurn";
import { Composer } from "../chat/Composer";
import { chipQuestions } from "../chat/ChatScreen";
import { InPlaceDecision } from "../chat/InPlaceDecision";
import { SharedChatProvider, useChatCore } from "../chat/useChat";
import type { Chat } from "../chat/useChat";
import { useTr } from "../sheet/useTr";
import { Sheet } from "../ui/Sheet";
import { LexApiProvider, LexBusyProvider } from "./NavContext";
import type { LexApi } from "./NavContext";
import "../../app/chat.css";

/** The composer already on the page, where there is one: Home's, the conversation page's. */
export function inlineComposer(path: string): string | null {
  if (path === "/home" || path.startsWith("/home/")) return "home-ask";
  if (path === "/chat" || path.startsWith("/chat/")) return "ak-input";
  return null;
}

function LexSheet({
  chat,
  open,
  onClose,
  business,
}: {
  chat: Chat;
  open: boolean;
  onClose: () => void;
  business: string | null;
}) {
  const { tr, locale } = useTr("chat");
  const chips = chipQuestions(useMessages());
  const end = useRef<HTMLDivElement | null>(null);
  const s = chat.state;
  const count = s.phase === "ready" ? s.turns.length : 0;
  const busy = s.phase === "ready" && s.busy;

  // Follow the thread as it grows, and land on its end when the sheet opens.
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, count, busy]);

  // Opened before the thread had loaded, the sheet had only Close to focus:
  // the composer takes the cursor as soon as it exists.
  const ready = s.phase === "ready";
  useEffect(() => {
    if (open && ready) document.getElementById("lex-ask")?.focus({ preventScroll: true });
  }, [open, ready]);

  const now = Date.now();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={ASSISTANT}
      kicker={business ?? undefined}
      width={560}
      foot={
        s.phase === "ready" ? (
          <Composer
            id="lex-ask"
            compact
            autoFocus
            label={tr("composer.label", { noun: business ?? tr("yourBusiness") })}
            draft={s.draft}
            busy={s.busy}
            setDraft={chat.setDraft}
            draftRef={chat.draftRef}
            onSend={() => void chat.send(tr("sendFailed"))}
            tr={tr}
          />
        ) : undefined
      }
    >
      {s.phase === "loading" && <p className="lx-note">{tr("loading")}</p>}
      {s.phase === "signedout" && <p className="lx-note">{tr("signedOut.copy")}</p>}
      {s.phase === "error" && <p className="lx-note">{tr("error.copy")}</p>}
      {s.phase === "ready" && (
        <div className="lx-thread" aria-live="polite">
          {s.turns.length === 0 && (
            <div className="ak-start">
              <p className="ak-descriptor">{tr("descriptor")}</p>
              {chips.length > 0 && (
                <div className="ak-chips">
                  {chips.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="ak-chip"
                      disabled={s.busy}
                      onClick={() => void chat.ask(q, tr("sendFailed"))}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {s.turns.map((turn, i) => (
            <ChatTurn
              key={turn.id}
              turn={turn}
              cards={s.cards}
              onChanged={chat.onChanged}
              now={now}
              locale={locale}
              tr={tr}
            >
              {i === s.turns.length - 1 && turn.role === "system" && s.lastProposal && (
                <InPlaceDecision id={s.lastProposal} />
              )}
            </ChatTurn>
          ))}
          {s.busy && <ChatBusy text={tr("thinking")} />}
          <div ref={end} />
        </div>
      )}
      <p className="lx-full">
        <Link href="/chat">{tr("openFull")}</Link>
      </p>
    </Sheet>
  );
}

/**
 * Holds the frame's one conversation and Lex's sheet, and answers
 * `useLex().open()` for everything inside it.
 */
export function LexHost({
  path,
  business,
  children,
}: {
  path: string;
  business: string | null;
  children: ReactNode;
}) {
  const shared = useChatCore(true);
  const { tr } = useTr("chat");
  const [open, setOpen] = useState(false);
  // The latest of each, so `open()` keeps one identity for its callers.
  const live = useRef({ path, shared, failed: tr("sendFailed") });
  live.current = { path, shared, failed: tr("sendFailed") };

  // A link inside the sheet moved the page: the sheet has done its job.
  useEffect(() => setOpen(false), [path]);

  const api = useMemo<LexApi>(
    () => ({
      open: (question) => {
        const now = live.current;
        now.shared.ensure();
        if (question && question.trim() !== "") void now.shared.chat.ask(question, now.failed);
        const inline = inlineComposer(now.path);
        const field = inline ? document.getElementById(inline) : null;
        if (field) {
          field.scrollIntoView({ block: "center" });
          field.focus({ preventScroll: true });
          return;
        }
        setOpen(true);
      },
    }),
    [],
  );

  const state = shared.chat.state;
  const busy = state.phase === "ready" && state.busy;
  return (
    <SharedChatProvider value={shared}>
      <LexApiProvider value={api}>
        <LexBusyProvider value={busy}>
          {children}
          <LexSheet
            chat={shared.chat}
            open={open}
            onClose={() => setOpen(false)}
            business={business}
          />
        </LexBusyProvider>
      </LexApiProvider>
    </SharedChatProvider>
  );
}
