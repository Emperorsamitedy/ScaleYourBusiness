"use client";

// The conversation's state, shared by the chat screen and Home (the owner,
// 2026-11-17: the dashboard is built around the conversation). One thread
// per business (GET /api/chat), one message at a time (POST), the change
// cards a reply carries, and the proposal a request became — which the
// click on its own card decides, never the sentence that asked for it.

import { useCallback, useEffect, useRef, useState } from "react";
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

export interface Chat {
  state: ChatState;
  /** The composer's text as of the last change, so the microphone (idea 50) can tell the owner's typing from its own. */
  draftRef: MutableRefObject<string>;
  setDraft: (draft: string) => void;
  /** Sends the draft; `failed` is the line shown when the server can't be reached. */
  send: (failed: string) => Promise<void>;
  /** A change card after a click on it. */
  onChanged: (card: ChangeCardView) => void;
  reload: () => Promise<void>;
}

export function useChat(): Chat {
  const [state, setState] = useState<ChatState>({ phase: "loading" });
  const stateRef = useRef<ChatState>(state);
  stateRef.current = state;
  const draftRef = useRef("");

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
        draft: "",
        busy: false,
        lastProposal: null,
      });
    } catch {
      setState({ phase: "error" });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setDraft = useCallback((draft: string) => {
    draftRef.current = draft;
    setState((cur) => (cur.phase === "ready" ? { ...cur, draft } : cur));
  }, []);

  const onChanged = useCallback((card: ChangeCardView) => {
    setState((cur) =>
      cur.phase === "ready" ? { ...cur, cards: upsertCard(cur.cards, card) } : cur,
    );
  }, []);

  const send = useCallback(async (failed: string) => {
    const s = stateRef.current;
    if (s.phase !== "ready") return;
    const text = s.draft.trim();
    if (text === "" || s.busy) return;
    const optimistic: Turn = {
      id: `tmp-${Date.now()}`,
      role: "owner",
      text,
      at: new Date().toISOString(),
      intent: null,
    };
    draftRef.current = "";
    setState({ ...s, turns: [...s.turns, optimistic], draft: "", busy: true, lastProposal: null });
    let reply: Turn | null = null;
    let error: string | null = null;
    let proposal: string | null = null;
    let card: ChangeCardView | null = null;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
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
              text: error ?? failed,
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

  return { state, draftRef, setDraft, send, onChanged, reload };
}
