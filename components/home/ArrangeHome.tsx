"use client";

// Home as the owner wants it (docs/DASHBOARD-OVERHAUL.md, the later rounds:
// "A Home the owner can rearrange or trim"). A side sheet lists the cards of
// "Your numbers today", each with a tick for whether it is shown and two
// buttons to move it, and Lex's activity with a tick. What needs the owner
// and Lex's status are not on the list: they are always shown.
//
// home-layout.ts holds the rules; this keeps the choice in the browser and
// draws the sheet. Nothing here reads or writes the business's own data.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTr } from "../sheet/useTr";
import { IconButton } from "../ui/IconButton";
import { Sheet } from "../ui/Sheet";
import type { HomeBlock, HomeLayout, NumbersBlock } from "./home-layout";
import {
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  isDefault,
  moved,
  readLayout,
  shows,
  toggled,
  writeLayout,
} from "./home-layout";

/** A change to the layout as it stands at that moment (two in quick succession both count). */
export type LayoutChange = (current: HomeLayout) => HomeLayout;

/**
 * The layout this browser kept, and a way to change it. The default until
 * the browser has been asked, so the server's page and the first paint agree.
 */
export function useHomeLayout(): [HomeLayout, (change: LayoutChange) => void] {
  const [layout, setLayout] = useState<HomeLayout>(DEFAULT_LAYOUT);
  /** Whether the owner changed it here: only then is it written back. */
  const changed = useRef(false);
  useEffect(() => {
    try {
      setLayout(readLayout(window.localStorage.getItem(LAYOUT_KEY)));
    } catch {
      /* storage blocked: Home shows everything */
    }
  }, []);
  useEffect(() => {
    if (!changed.current) return;
    try {
      if (isDefault(layout)) window.localStorage.removeItem(LAYOUT_KEY);
      else window.localStorage.setItem(LAYOUT_KEY, writeLayout(layout));
    } catch {
      /* storage blocked: the choice lasts until the page is left */
    }
  }, [layout]);
  const change = useCallback((make: LayoutChange) => {
    changed.current = true;
    setLayout(make);
  }, []);
  return [layout, change];
}

export function ArrangeHome({
  open,
  onClose,
  layout,
  onChange,
  names,
}: {
  open: boolean;
  onClose: () => void;
  layout: HomeLayout;
  onChange: (change: LayoutChange) => void;
  /** Each block as Home itself names it. */
  names: Readonly<Record<HomeBlock, string>>;
}) {
  const { tr } = useTr("home");
  const tick = (block: HomeBlock) => (
    <label className="ha-tick">
      <input
        type="checkbox"
        checked={shows(layout, block)}
        onChange={() => onChange((cur) => toggled(cur, block))}
      />
      <span>{names[block]}</span>
    </label>
  );
  const move = (block: NumbersBlock, by: -1 | 1, at: number) => (
    <IconButton
      label={tr(by === -1 ? "arrange.up" : "arrange.down", { name: names[block] })}
      disabled={by === -1 ? at === 0 : at === layout.order.length - 1}
      onClick={() => onChange((cur) => moved(cur, block, by))}
    >
      {by === -1 ? (
        <ChevronUp size={18} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <ChevronDown size={18} strokeWidth={1.75} aria-hidden="true" />
      )}
    </IconButton>
  );
  return (
    <Sheet open={open} onClose={onClose} title={tr("arrange.title")} width={460}>
      <p className="ha-note">{tr("arrange.note")}</p>
      <h3 className="ha-group">{tr("readings.label")}</h3>
      <ul className="ha-list">
        {layout.order.map((block, at) => (
          <li key={block} className="ha-row">
            {tick(block)}
            <span className="ha-move">
              {move(block, -1, at)}
              {move(block, 1, at)}
            </span>
          </li>
        ))}
      </ul>
      <h3 className="ha-group">{tr("now.label")}</h3>
      <ul className="ha-list">
        <li className="ha-row">{tick("work")}</li>
      </ul>
      <p className="ha-note">{tr("arrange.always")}</p>
      <p className="ha-foot">
        <button
          type="button"
          className="home-btn"
          disabled={isDefault(layout)}
          onClick={() => onChange(() => DEFAULT_LAYOUT)}
        >
          {tr("arrange.reset")}
        </button>
      </p>
    </Sheet>
  );
}
