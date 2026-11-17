"use client";

// Toasts (docs/DASHBOARD-OVERHAUL.md A2): one line saying what was just
// recorded or what went wrong, in a polite live region at the foot of the
// screen. Five seconds, paused while pointed at or focused; three at most;
// one optional action. A toast never asks for a decision and never holds
// the only copy of anything: it repeats what the page already shows.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { IconButton } from "./IconButton";
import "../../app/ui.css";

export type ToastTone = "ok" | "drift" | "alarm";

export interface ToastOptions {
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
}

export type ToastFn = (text: string, opts?: ToastOptions) => void;

interface Item extends ToastOptions {
  id: number;
  text: string;
}

const STAY_MS = 5000;
const AT_MOST = 3;
const NOOP: ToastFn = () => undefined;
const Ctx = createContext<ToastFn>(NOOP);

/** Says one line at the foot of the screen; a no-op outside a provider. */
export function useToast(): ToastFn {
  return useContext(Ctx);
}

function Toast({ item, onDone }: { item: Item; onDone: (id: number) => void }) {
  const t = useTranslations("common");
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => onDone(item.id), STAY_MS);
    return () => window.clearTimeout(timer);
  }, [held, item.id, onDone]);
  return (
    <div
      className={`ui-toast ${item.tone ?? "ok"}`}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <p className="ui-toast-text">{item.text}</p>
      {item.action && (
        <button
          type="button"
          className="ui-toast-act"
          onClick={() => {
            item.action?.onClick();
            onDone(item.id);
          }}
        >
          {item.action.label}
        </button>
      )}
      <IconButton label={t("close")} className="ui-toast-close" onClick={() => onDone(item.id)}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [items, setItems] = useState<Item[]>([]);
  const next = useRef(1);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const push = useCallback<ToastFn>((text, opts) => {
    const id = next.current++;
    setItems((cur) => [...cur.slice(-(AT_MOST - 1)), { id, text, ...opts }]);
  }, []);
  const done = useCallback((id: number) => {
    setItems((cur) => cur.filter((i) => i.id !== id));
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      {mounted &&
        createPortal(
          <div className="ui-toasts" role="status" aria-live="polite">
            {items.map((i) => (
              <Toast key={i.id} item={i} onDone={done} />
            ))}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}
