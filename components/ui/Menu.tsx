"use client";

// A menu under its button (docs/DASHBOARD-OVERHAUL.md A4): the bell's list
// today. It stays inside the window wherever its button sits. The button
// says whether it is open; Escape closes it and gives
// the button its focus back; a click outside or the Tab key closes it;
// the arrow keys, Home and End move through its items; choosing one
// closes it. Items are links or buttons with role="menuitem" and the
// class "ui-menu-item".

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { nudgeInto } from "./overlay";
import "../../app/ui.css";

/** The room kept between a menu and the window's edge. */
const EDGE = 12;

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  "aria-controls": string | undefined;
  onClick: () => void;
}

export function Menu({
  label,
  trigger,
  children,
}: {
  /** The menu's spoken name. */
  label: string;
  /** Draws the button; spread the props onto it. */
  trigger: (props: MenuTriggerProps) => ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  // It hangs from the button's right edge; under a button near the left
  // edge (the bell on a phone) that would start off-screen, so it is moved
  // back inside the window before it is painted, and again on a resize.
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const menu = wrap.current?.querySelector<HTMLElement>(".ui-menu");
      if (!menu) return;
      menu.style.removeProperty("--ui-menu-nudge");
      const r = menu.getBoundingClientRect();
      const by = nudgeInto(r.left, r.right, document.documentElement.clientWidth, EDGE);
      if (by !== 0) menu.style.setProperty("--ui-menu-nudge", `${Math.round(by)}px`);
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (e.target instanceof Node && !wrap.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    const menu = wrap.current?.querySelector<HTMLElement>(".ui-menu");
    (menu?.querySelector<HTMLElement>('[role="menuitem"]') ?? menu)?.focus();
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = Array.from(
      wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      e.key === "ArrowDown"
        ? (at + 1) % items.length
        : e.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : null;
    if (to !== null) {
      e.preventDefault();
      items[to]?.focus();
    }
  };

  return (
    <div className="ui-menu-wrap" ref={wrap} onKeyDown={onKeyDown}>
      {trigger({
        ref: button,
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": open ? id : undefined,
        onClick: () => setOpen((o) => !o),
      })}
      {open && (
        <div
          id={id}
          className="ui-menu"
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onClick={(e) => {
            if (e.target instanceof Element && e.target.closest('[role="menuitem"]')) {
              setOpen(false);
            }
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
