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
      /**
       * The question whose reply did not come, while asking again could
       * help (the server failed or never answered); null otherwise, and
       * for a refusal that gave its reason.
       */
      retry: string | null;
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

/**
 * Pure: whether asking again could help. A server that failed or never
 * answered may answer the next time; a refusal (too long, the plan's
 * allowance used up, not this role's to ask) says why and would say it again.
 */
export function canRetry(status: number | null): boolean {
  // 503 is this server saying what it lacks (a key): that is a reason, not a stumble.
  return status === null || status === 500 || status === 502 || status === 504;
}

/** Pure: whether a turn is the line that stands where a reply did not come. */
export function isFailure(turn: Pick<Turn, "id">): boolean {
  return turn.id.startsWith("err-");
}

/**
 * Pure: the thread without its last failed exchange (the question as the
 * screen added it, and the line that stood for the reply), so asking again
 * shows the question once. Anything else is left as it is.
 */
export function withoutFailed(turns: readonly Turn[]): Turn[] {
  const last = turns[turns.length - 1];
  if (!last || !isFailure(last)) return [...turns];
  const before = turns[turns.length - 2];
  const cut = before && before.role === "owner" && before.id.startsWith("tmp-") ? 2 : 1;
  return turns.slice(0, turns.length - cut);
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
  /** Asks again the question whose reply did not come (state.retry). */
  retry: (failed: string) => Promise<void>;
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
        retry: null,
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

  const post = useCallback(
    async (raw: string, failed: string, fromDraft: boolean, again = false) => {
      const s = stateRef.current;
      if (s.phase !== "ready") return;
      const text = raw.trim().slice(0, MAX_CHARS);
      if (text === "" || s.busy) return;
      // Asked again: the failed exchange leaves the screen and this one takes its place.
      const before = again ? withoutFailed(s.turns) : s.turns;
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
        turns: [...before, optimistic],
        draft: fromDraft ? "" : s.draft,
        busy: true,
        lastProposal: null,
        retry: null,
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
          // The screen the question is asked from, so Lex knows where the owner is.
          body: JSON.stringify({ text, path: window.location.pathname }),
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
          retry: reply === null && canRetry(status) ? text : null,
        };
      });
    },
    [],
  );

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

  const retry = useCallback(
    async (failed: string) => {
      const s = stateRef.current;
      if (s.phase === "ready" && s.retry !== null) await post(s.retry, failed, false, true);
    },
    [post],
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
    () => ({ state, draftRef, setDraft, send, ask, retry, onChanged, reload }),
    [state, setDraft, send, ask, retry, onChanged, reload],
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
