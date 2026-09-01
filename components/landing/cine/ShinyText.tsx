"use client";

// ShinyText — an animated gradient sweep across a headline, per the
// owner-supplied spec: a base colour with a bright band travelling
// left→right forever, painted through background-clip: text.
//
// Colours are props with the spec's defaults; the landing passes Ember
// Grid values (amber base, white shine) so the sweep reads as part of
// this product rather than a borrowed effect.

import { motion } from "framer-motion";

export function ShinyText({
  text,
  className,
  baseColor = "#64CEFB",
  shineColor = "#ffffff",
  speed = 3,
  spread = 100,
}: {
  text: string;
  className?: string;
  baseColor?: string;
  shineColor?: string;
  /** Seconds for one full sweep. */
  speed?: number;
  /** Gradient angle, degrees. */
  spread?: number;
}) {
  return (
    <motion.span
      className={className}
      style={{
        display: "inline-block",
        backgroundImage: `linear-gradient(${spread}deg, ${baseColor} 35%, ${shineColor} 50%, ${baseColor} 65%)`,
        backgroundSize: "250% 100%",
        backgroundClip: "text",
        WebkitBackgroundClip: "text",
        color: "transparent",
        WebkitTextFillColor: "transparent",
      }}
      animate={{ backgroundPosition: ["250% 0%", "-250% 0%"] }}
      transition={{ duration: speed, repeat: Infinity, ease: "linear" }}
    >
      {text}
    </motion.span>
  );
}
