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
//
// The owner's third round, L4b ("an interactive pop-up, and present in more
// places than one"): on a wide screen Lex is a pop-up in the corner, not a
// sheet over the page. It is not modal: the page beside it stays in reach,
// and it stays open from screen to screen until it is closed, so an answer
// can be read while the screen it is about is opened. A phone has no room
// beside the page and keeps the full-screen sheet. Lex's face floats in the
// same corner of every screen that has no composer of its own
// (components/nav/AppFrame.tsx).

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { Maximize2, X } from "lucide-react";
import { useMessages, useTranslations } from "next-intl";
import { ASSISTANT } from "../../lib/core/assistant";
import { LexFace, lexState } from "../brand/LexFace";
import { ChatBusy, ChatTurn } from "../chat/ChatTurn";
import { Composer } from "../chat/Composer";
import { chipQuestions } from "../chat/ChatScreen";
import { InPlaceDecision } from "../chat/InPlaceDecision";
import { InterviewOffer } from "../chat/InterviewOffer";
import { TryAgain } from "../chat/TryAgain";
import { SharedChatProvider, useChatCore } from "../chat/useChat";
import type { Chat } from "../chat/useChat";
import { knowsNothing } from "../home/next-steps";
import { useTr } from "../sheet/useTr";
import { IconButton } from "../ui/IconButton";
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

/** The width from which Lex is a pop-up beside the page; under it, the full-screen sheet. */
export const LEX_POPUP_FROM = 760;

/**
 * Pure: whether Lex stays open when the page changes. Beside the page (a
 * pop-up) it does, unless the new page has the conversation on it already;
 * over the page (the sheet) a link inside it has done its job.
 */
export function staysOpen(path: string, wide: boolean): boolean {
  return wide && inlineComposer(path) === null;
}

/** Whether the window is wide enough for the pop-up; false until the browser says. */
function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const q = window.matchMedia(`(min-width: ${LEX_POPUP_FROM}px)`);
    const read = () => setWide(q.matches);
    read();
    q.addEventListener("change", read);
    return () => q.removeEventListener("change", read);
  }, []);
  return wide;
}

interface LexViewProps {
  chat: Chat;
  open: boolean;
  onClose: () => void;
  business: string | null;
  /** Facts on the fact sheet; null while unknown. Zero: Lex offers the interview (L8). */
  facts: number | null;
}

/** The composer in Lex's foot, the same in the sheet and in the pop-up. */
function LexComposer({ chat, business }: { chat: Chat; business: string | null }) {
  const { tr } = useTr("chat");
  const s = chat.state;
  if (s.phase !== "ready") return null;
  return (
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
  );
}

/** What Lex holds, the same in the sheet and in the pop-up: the thread and its states. */
function LexThread({ chat, open, facts }: { chat: Chat; open: boolean; facts: number | null }) {
  const { tr, locale } = useTr("chat");
  const chips = chipQuestions(useMessages());
  const end = useRef<HTMLDivElement | null>(null);
  const s = chat.state;
  const count = s.phase === "ready" ? s.turns.length : 0;
  const busy = s.phase === "ready" && s.busy;

  // Follow the thread as it grows, and land on its end when Lex opens.
  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, count, busy]);

  // Opened before the thread had loaded, there was only Close to focus:
  // the composer takes the cursor as soon as it exists.
  const ready = s.phase === "ready";
  useEffect(() => {
    if (open && ready) document.getElementById("lex-ask")?.focus({ preventScroll: true });
  }, [open, ready]);

  const now = Date.now();
  return (
    <>
      {s.phase === "loading" && <p className="lx-note">{tr("loading")}</p>}
      {s.phase === "signedout" && <p className="lx-note">{tr("signedOut.copy")}</p>}
      {s.phase === "error" && <p className="lx-note">{tr("error.copy")}</p>}
      {s.phase === "ready" && (
        <div className="lx-thread" aria-live="polite">
          {s.turns.length === 0 && knowsNothing(facts) && <InterviewOffer />}
          {s.turns.length === 0 && !knowsNothing(facts) && (
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
              <TryAgain chat={chat} turn={turn} last={i === s.turns.length - 1} tr={tr} />
            </ChatTurn>
          ))}
          {s.busy && <ChatBusy text={tr("thinking")} />}
          <div ref={end} />
        </div>
      )}
    </>
  );
}

/** Lex over the page: a phone's full-screen sheet. */
function LexSheet({ chat, open, onClose, business, facts }: LexViewProps) {
  const { tr } = useTr("chat");
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={ASSISTANT}
      kicker={business ?? undefined}
      width={560}
      foot={
        chat.state.phase === "ready" ? <LexComposer chat={chat} business={business} /> : undefined
      }
    >
      <LexThread chat={chat} open={open} facts={facts} />
      <p className="lx-full">
        <Link href="/chat">{tr("openFull")}</Link>
      </p>
    </Sheet>
  );
}

/**
 * Lex beside the page: a pop-up in the corner of a wide screen. A dialog
 * that is not modal: nothing behind it is covered or held still, Escape
 * closes it while the cursor is inside, and the cursor goes back to what
 * opened it.
 */
function LexPop({ chat, open, onClose, business, facts }: LexViewProps) {
  const { tr } = useTr("chat");
  const common = useTranslations("common");
  const opener = useRef<HTMLElement | null>(null);
  const s = chat.state;
  const busy = s.phase === "ready" && s.busy;

  // Remember what had the cursor when Lex opened, and hand it back on closing.
  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const back = opener.current;
      // Only when the cursor is still inside Lex: a person who has clicked
      // somewhere on the page keeps their place there.
      const inside = document.activeElement?.closest(".lx-pop") !== null;
      if (back && back.isConnected && (inside || document.activeElement === document.body)) {
        back.focus({ preventScroll: true });
      }
    };
  }, [open]);

  if (!open) return null;
  return (
    <aside
      className="lx-pop"
      role="dialog"
      aria-modal="false"
      aria-labelledby="lx-pop-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="lx-pop-head">
        <LexFace size={30} state={lexState({ working: busy })} />
        <div className="lx-pop-who">
          <h2 className="lx-pop-title" id="lx-pop-title">
            {ASSISTANT}
          </h2>
          {business && <p className="lx-pop-kicker">{business}</p>}
        </div>
        <Link
          className="ui-icon-btn"
          href="/chat"
          aria-label={tr("openFull")}
          title={tr("openFull")}
        >
          <Maximize2 size={16} strokeWidth={1.75} aria-hidden="true" />
        </Link>
        <IconButton label={common("close")} onClick={onClose}>
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
      </header>
      <div className="lx-pop-body">
        <LexThread chat={chat} open={open} facts={facts} />
      </div>
      {s.phase === "ready" && (
        <footer className="lx-pop-foot">
          <LexComposer chat={chat} business={business} />
        </footer>
      )}
    </aside>
  );
}

/**
 * Holds the frame's one conversation and Lex's sheet, and answers
 * `useLex().open()` for everything inside it.
 */
export function LexHost({
  path,
  business,
  facts = null,
  children,
}: {
  path: string;
  business: string | null;
  /** Facts on the fact sheet, from the menu's read; null while unknown. */
  facts?: number | null;
  children: ReactNode;
}) {
  const shared = useChatCore(true);
  const { tr } = useTr("chat");
  const [open, setOpen] = useState(false);
  const wide = useWide();
  // The latest of each, so `open()` keeps one identity for its callers.
  const live = useRef({ path, shared, failed: tr("sendFailed"), wide });
  live.current = { path, shared, failed: tr("sendFailed"), wide };

  // The page changed. The pop-up stays beside it (L4b); the sheet, which
  // covers the page, has done its job, and so has either on a page that
  // holds the conversation itself.
  useEffect(() => {
    if (!staysOpen(path, live.current.wide)) setOpen(false);
  }, [path]);

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
          {wide ? (
            <LexPop
              chat={shared.chat}
              open={open}
              onClose={() => setOpen(false)}
              business={business}
              facts={facts}
            />
          ) : (
            <LexSheet
              chat={shared.chat}
              open={open}
              onClose={() => setOpen(false)}
              business={business}
              facts={facts}
            />
          )}
        </LexBusyProvider>
      </LexApiProvider>
    </SharedChatProvider>
  );
}
