"use client";

// What the frame offers the screens inside it (docs/DASHBOARD-OVERHAUL.md
// B2, B4): reading the menu's counts again right now (after a decision,
// say), and opening Lex's sheet, optionally with a question to ask. Both
// are no-ops outside the frame, so a component never needs to check.

import { createContext, useContext } from "react";

const RefreshCtx = createContext<() => void>(() => undefined);
export const NavRefreshProvider = RefreshCtx.Provider;

/** Re-reads `/api/nav` now; a no-op outside the frame. */
export function useNavRefresh(): () => void {
  return useContext(RefreshCtx);
}

export interface LexApi {
  /** Opens Lex's sheet; with a question, asks it at once. */
  open: (question?: string) => void;
}

const LexCtx = createContext<LexApi>({ open: () => undefined });
export const LexApiProvider = LexCtx.Provider;

/** Opens the conversation from anywhere; a no-op outside the frame. */
export function useLex(): LexApi {
  return useContext(LexCtx);
}

const BusyCtx = createContext(false);
export const LexBusyProvider = BusyCtx.Provider;

/** Whether Lex is answering right now, so a face can show it; false outside the frame. */
export function useLexBusy(): boolean {
  return useContext(BusyCtx);
}

/**
 * Opens a decision in place, over the page it was asked from. `after` is
 * called once an answer has been recorded there, so whatever showed the
 * decision can read it again.
 */
export type ReviewOpener = (id: string, after?: () => void) => void;

const ReviewCtx = createContext<ReviewOpener | null>(null);
export const ReviewOpenerProvider = ReviewCtx.Provider;

/**
 * The frame's way to open a decision in place. Null where there is no frame,
 * and inside a sheet that already covers the page (a phone's Lex): there the
 * decision keeps its link to its own page, since a sheet over a sheet is two
 * things to close.
 */
export function useReviewOpener(): ReviewOpener | null {
  return useContext(ReviewCtx);
}

const WaitingCtx = createContext(false);
export const LexWaitingProvider = WaitingCtx.Provider;

/**
 * Whether a reply has come that the owner has not seen: asked, then Lex
 * closed or the page left before the answer arrived. A face marks it until
 * the conversation is opened. False outside the frame.
 */
export function useLexWaiting(): boolean {
  return useContext(WaitingCtx);
}
