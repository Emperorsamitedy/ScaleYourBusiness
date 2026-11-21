"use client";

// The top bar folds by what it holds (2026-11-20). Its folds were set at
// fixed window widths, measured in English: search loses its word under
// 1240px, "Ask Lex" and the stop shorten under 1100px, the places become
// icons under 1000px. Every other language's words are longer. In Hungarian
// the bar needed about 1390px with everything written out, so from 1100 to
// 1390px wide (every common laptop) the stop hung past the right edge and
// the whole page scrolled sideways; the language switch added to the bar
// that day made it show in English too.
//
// So the bar is measured: it folds one step at a time until what it holds
// fits, whatever the language, the business's name or the counts beside the
// places. The steps are the same folds, in the same order, as the widths set
// (app/shell.css, `[data-fit]`); the width rules stay as the first paint's
// guess, before anything can be measured.

import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/**
 * How far the bar can fold. Each step keeps the ones before it:
 *   1  search is its icon; the language switch is one button
 *   2  "Ask Lex" is Lex's face; the stop says one word
 *   3  a place that is not open is its icon
 *   4  the rule after the wordmark goes, the tools sit closer, the
 *      business's name gives up a few letters
 *   5  the open place is its icon too
 */
export const BAR_FIT_STEPS = 5;

/**
 * Pure: the first step at which the bar fits, trying the roomiest first;
 * the last step when nothing fits (a phone's layout takes over long before).
 */
export function firstFit(fits: (step: number) => boolean, steps: number = BAR_FIT_STEPS): number {
  for (let step = 0; step < steps; step++) if (fits(step)) return step;
  return steps;
}

/**
 * Folds the bar `ref` holds until its contents fit, and again whenever its
 * width or its words change. `live` is whether the bar is drawn at all: a
 * page outside the frame has none, and the next page inside it has a new one.
 */
export function useBarFit(ref: RefObject<HTMLElement | null>, live: boolean): void {
  useLayoutEffect(() => {
    const bar = live ? ref.current : null;
    if (!bar) return;
    const set = (step: number) => {
      if (step === 0) delete bar.dataset.fit;
      else bar.dataset.fit = String(step);
    };
    const fit = () => {
      set(
        firstFit((step) => {
          set(step);
          return bar.scrollWidth <= bar.clientWidth + 1;
        }),
      );
    };
    let frame = 0;
    const later = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };
    fit();
    // The window's width, and the words inside (another language, a business
    // named, a count arriving). The fold itself is an attribute, which is not
    // watched, so measuring never sets off another measure.
    const width = new ResizeObserver(later);
    width.observe(bar);
    const words = new MutationObserver(later);
    words.observe(bar, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      width.disconnect();
      words.disconnect();
    };
  }, [ref, live]);
}
