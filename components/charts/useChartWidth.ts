"use client";

// The pixel width a chart is drawn at. The charts draw their SVG at the
// container's own width (one viewBox unit = one CSS pixel), so text stays
// at its real size from 390 px to a wide desk instead of being scaled down
// with the drawing. Until the first measurement — and on the server — it
// is the full-width guess, which the first layout corrects.

import { useEffect, useRef, useState } from "react";

export const NARROW_BELOW = 560;

export function useChartWidth<T extends HTMLElement>(initial = 960) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = Math.floor(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width, narrow: width < NARROW_BELOW };
}
