"use client";

// The conversation's state: one thread per business (GET /api/chat), one
// message at a time (POST), the change cards a reply carries, and the
// proposal a request became — which the click on its own card decides,
// never the sentence that asked for it.
//
// Inside the app's frame there is ONE conversation (2026-11-17, the owner:
// the dashboard is built around it): Home's composer, the conversation
// page and Lex's sheet on every other screen all read the same state
// through `useChat()`, shared by the frame (components/nav/LexPanel.tsx).
// Nothing is read until something needs it. Outside the frame `useChat()`
// keeps a conversation of its own, as it always did.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MutableRefObject } from "react";
import type { ChangeCardView, Turn } from "./chat-view";
import { upsertCard } from "./chat-view";

export type ChatState =
  | { phase: "loading" }
  | { phase: "signedout" }
  | { phase: "error" }
  | {
      phase: "ready";
      turns: Turn[];
      cards: ChangeCardView[];
      draft: string;
      busy: boolean;
      /** The proposal the latest request became, until the next message. */
      lastProposal: string | null;
    };

/** The service's own ceiling on one message (lib/chat/service.ts). */
export const MAX_CHARS = 4000;

/**
 * The line that stands where a reply did not come. A refusal that gives its
 * reason (too long, a key this server lacks) keeps the reason. The server's
 * plain 500 is one English sentence for every reader, so `failed` says it
 * in the reader's own language instead; so does a server that never answered.
 */
export function failureLine(status: number | null, error: string | null, failed: string): string {
  if (status === null || status === 500) return failed;
  return error !== null && error.trim() !== "" ? error : failed;
}

export interface Chat {
  state: ChatState;
  /** The composer's text as of the last change, so the microphone (idea 50) can tell the owner's typing from its own. */
  draftRef: MutableRefObject<string>;
  setDraft: (draft: string) => void;
  /** Sends the draft; `failed` is the line shown when the server can't be reached. */
  send: (failed: string) => Promise<void>;
  /**
   * Sends this text now, whatever the draft holds (a suggestion chip, the
   * palette's "Ask Lex"). Asked before the thread has loaded, it is sent
   * as soon as it has. Dropped while a reply is still being written.
   */
  ask: (text: string, failed: string) => Promise<void>;
  /** A change card after a click on it. */
  onChanged: (card: ChangeCardView) => void;
  reload: () => Promise<void>;
}

export interface SharedChat {
  chat: Chat;
  /** Starts the first read if nothing has yet. */
  ensure: () => void;
}

const SharedChatContext = createContext<SharedChat | null>(null);
export const SharedChatProvider = SharedChatContext.Provider;

/**
 * The conversation itself. `lazy`: nothing is read until `ensure()` is
 * called, so a screen that never opens the conversation never fetches it.
 */
export function useChatCore(lazy = false): SharedChat {
  const [state, setState] = useState<ChatState>({ phase: "loading" });
  const stateRef = useRef<ChatState>(state);
  stateRef.current = state;
  const draftRef = useRef("");
  const started = useRef(false);
  const queued = useRef<{ text: string; failed: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/chat");
      if (res.status === 401) return setState({ phase: "signedout" });
      if (!res.ok) return setState({ phase: "error" });
      const j = (await res.json()) as { turns: Turn[]; changes?: ChangeCardView[] };
      setState({
        phase: "ready",
        turns: j.turns,
        cards: j.changes ?? [],
        draft: draftRef.current,
        busy: false,
        lastProposal: null,
      });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  const ensure = useCallback(() => {
    if (started.current) return;
    started.current = true;
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!lazy) ensure();
  }, [lazy, ensure]);

  const setDraft = useCallback((draft: string) => {
    draftRef.current = draft;
    setState((cur) => (cur.phase === "ready" ? { ...cur, draft } : cur));
  }, []);

  const onChanged = useCallback((card: ChangeCardView) => {
    setState((cur) =>
      cur.phase === "ready" ? { ...cur, cards: upsertCard(cur.cards, card) } : cur,
    );
  }, []);

  const post = useCallback(async (raw: string, failed: string, fromDraft: boolean) => {
    const s = stateRef.current;
    if (s.phase !== "ready") return;
    const text = raw.trim().slice(0, MAX_CHARS);
    if (text === "" || s.busy) return;
    const optimistic: Turn = {
      id: `tmp-${Date.now()}`,
      role: "owner",
      text,
      at: new Date().toISOString(),
      intent: null,
    };
    if (fromDraft) draftRef.current = "";
    setState({
      ...s,
      turns: [...s.turns, optimistic],
      draft: fromDraft ? "" : s.draft,
      busy: true,
      lastProposal: null,
    });
    let reply: Turn | null = null;
    let status: number | null = null;
    let error: string | null = null;
    let proposal: string | null = null;
    let card: ChangeCardView | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      status = res.status;
      const j = (await res.json().catch(() => ({}))) as {
        reply?: Turn;
        proposal_id?: string | null;
        change?: ChangeCardView | null;
        error?: string;
      };
      reply = j.reply ? { ...j.reply, intent: j.reply.intent ?? null } : null;
      error = j.error ?? null;
      proposal = j.proposal_id ?? null;
      card = j.change ?? null;
    } catch {
      // Unreachable server: `failed` says so below.
    }
    setState((cur) => {
      if (cur.phase !== "ready") return cur;
      const turns = reply
        ? [...cur.turns, reply]
        : [
            ...cur.turns,
            {
              id: `err-${Date.now()}`,
              role: "system" as const,
              text: failureLine(status, error, failed),
              at: new Date().toISOString(),
              intent: null,
            },
          ];
      return {
        ...cur,
        turns,
        cards: card ? upsertCard(cur.cards, card) : cur.cards,
        busy: false,
        lastProposal: proposal,
      };
    });
  }, []);

  const send = useCallback(
    async (failed: string) => {
      const s = stateRef.current;
      if (s.phase === "ready") await post(s.draft, failed, true);
    },
    [post],
  );

  const ask = useCallback(
    async (text: string, failed: string) => {
      if (stateRef.current.phase === "loading") {
        queued.current = { text, failed };
        ensure();
        return;
      }
      await post(text, failed, false);
    },
    [post, ensure],
  );

  // A question asked before the thread had loaded is sent once it has.
  const phase = state.phase;
  useEffect(() => {
    if (phase !== "ready" || !queued.current) return;
    const q = queued.current;
    queued.current = null;
    void post(q.text, q.failed, false);
  }, [phase, post]);

  const chat = useMemo<Chat>(
    () => ({ state, draftRef, setDraft, send, ask, onChanged, reload }),
    [state, setDraft, send, ask, onChanged, reload],
  );
  return useMemo(() => ({ chat, ensure }), [chat, ensure]);
}

/**
 * The conversation: the frame's shared one where there is a frame, else
 * one of this component's own.
 */
export function useChat(): Chat {
  const shared = useContext(SharedChatContext);
  // Always called, so the hooks keep their order; lazy and never started when shared.
  const own = useChatCore(shared !== null);
  useEffect(() => {
    shared?.ensure();
  }, [shared]);
  return shared ? shared.chat : own.chat;
}
