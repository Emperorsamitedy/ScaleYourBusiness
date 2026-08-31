"use client";

// Word-by-word blur-in (the spec's BlurText), without Framer Motion:
// each word is a span whose transition is staggered by index; the whole
// thing arms when it enters the viewport (IntersectionObserver, 0.1).
// Under prefers-reduced-motion every word renders settled immediately.

import { useEffect, useRef, useState } from "react";

export function BlurText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOn(true);
      return;
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
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <span ref={ref} className={`cine-blurtext ${on ? "on" : ""} ${className ?? ""}`}>
      {text.split(" ").map((word, i) => (
        <span
          key={`${word}-${i}`}
          className="cine-word"
          style={{ transitionDelay: `${i * 100}ms` }}
        >
          {word}
        </span>
      ))}
    </span>
  );
}
