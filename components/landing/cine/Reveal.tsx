"use client";

// The spec's shared motion primitive — blur(10px)/opacity 0/y 20 →
// settled — as a CSS transition armed on mount (hero) or on
// intersection (below the fold), with a per-element delay. Reduced
// motion renders settled immediately.

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

export function Reveal({
  children,
  delay = 0,
  className,
  onScroll = false,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  onScroll?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOn(true);
      return;
    }
    if (!onScroll) {
      // next frame, so the initial state paints first
      const raf = requestAnimationFrame(() => setOn(true));
      return () => cancelAnimationFrame(raf);
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setOn(true);
          io.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onScroll]);

  return (
    <div
      ref={ref}
      className={`cine-reveal ${on ? "on" : ""} ${className ?? ""}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}
