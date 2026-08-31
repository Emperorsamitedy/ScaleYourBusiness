"use client";

// The spec's BlurText, on real Framer Motion: word-by-word staggered
// blur-in, armed once when the container enters the viewport.

import { motion, useInView } from "framer-motion";
import { useRef } from "react";

export function BlurText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { amount: 0.1, once: true });

  return (
    <span
      ref={ref}
      className={className}
      style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", rowGap: "0.1em" }}
    >
      {text.split(" ").map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          style={{ display: "inline-block", marginRight: "0.28em" }}
          initial={{ filter: "blur(10px)", opacity: 0, y: 50 }}
          animate={inView ? { filter: "blur(0px)", opacity: 1, y: 0 } : { filter: "blur(10px)", opacity: 0, y: 50 }}
          transition={{ duration: 0.7, delay: i * 0.1, ease: "easeOut" }}
        >
          {word}
        </motion.span>
      ))}
    </span>
  );
}
