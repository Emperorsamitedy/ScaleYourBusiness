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
