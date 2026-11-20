"use client";

// Lex's face (2026-11-18). The owner asked for a face, as Foundable's Ted has
// one, then for "an almost 3D feel", and left the design to us ("I trust you
// on what to pick and how to design that").
//
// It is the mark made solid: a tile in the brand's green, lit from the upper
// left, with a side you can see and a shadow under it. The mark's two bars
// are its eyes, and its smile rises to the right, as the arrow does. It is
// drawn in SVG, never an image: sharp at 20px and at 200px, nothing to load,
// and no generated picture in the owner app (docs/DASHBOARD-OVERHAUL.md).
//
// The states say what Lex is doing, in the app's own meanings: a cobalt glow
// is the machine working (ux-spec §2, "cobalt is machine state only"), and
// grey is the emergency stop (rule 15). They are never decoration.

import { useId } from "react";
import "../../app/lex.css";

export type LexState = "idle" | "working" | "listening" | "speaking" | "stopped";

/** The face is drawn on a 120 by 132 grid: the tile, then room for its shadow. */
const RATIO = 132 / 120;

/** Pure: the state a face shows, from what is true right now. Stopped outranks everything. */
export function lexState(now: {
  stopped?: boolean | undefined;
  listening?: boolean | undefined;
  working?: boolean | undefined;
}): LexState {
  if (now.stopped) return "stopped";
  if (now.listening) return "listening";
  if (now.working) return "working";
  return "idle";
}

export function LexFace({
  size = 40,
  state = "idle",
  title,
  float = false,
  className,
}: {
  /** The tile's width in pixels; the drawing is a little taller, for the shadow. */
  size?: number;
  state?: LexState;
  /** Spoken name when the face stands alone; omitted when "Lex" is written beside it. */
  title?: string | undefined;
  /** A slow rise and fall, for the one large face on Home. */
  float?: boolean;
  className?: string | undefined;
}) {
  // One set of gradients per face, so two faces on a page never share (or lose) their paint.
  const id = `lex${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const off = state === "stopped";
  const working = state === "working";
  // The soft light, the engraved edge and the shadow need room to read.
  const fine = size >= 28;
  const eyeY = state === "listening" ? 34 : 36;
  const eyeH = state === "listening" ? 32 : 30;
  // Working: the eyes look up and to the right, at the work.
  const dx = working ? 4 : 0;
  const dy = working ? -7 : 0;
  const ink = off ? "#1a2a22" : "#06170f";
  const classes = ["lex-face", float ? "lex-float" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <svg
      className={classes}
      width={size}
      height={Math.round(size * RATIO)}
      viewBox="0 0 120 132"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-state={state}
    >
      <defs>
        <radialGradient id={`${id}t`} cx="32%" cy="22%" r="95%">
          <stop offset="0" stopColor={off ? "#d5e0da" : "#9bfbd6"} />
          <stop offset=".34" stopColor={off ? "#a9bbb1" : "#34dc9c"} />
          <stop offset=".74" stopColor={off ? "#869c90" : "#14ab74"} />
          <stop offset="1" stopColor={off ? "#6b8578" : "#0b8459"} />
        </radialGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={off ? "#586d62" : "#0a7a53"} />
          <stop offset="1" stopColor={off ? "#34453c" : "#054a33"} />
        </linearGradient>
        <linearGradient id={`${id}e`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1d4a39" />
          <stop offset="1" stopColor="#051610" />
        </linearGradient>
        <linearGradient id={`${id}l`} x1="0" y1="0" x2="0" y2="1">
          <stop offset=".55" stopColor="#04402b" stopOpacity="0" />
          <stop offset="1" stopColor="#04402b" stopOpacity=".34" />
        </linearGradient>
        <filter id={`${id}b`} x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id={`${id}g`} x="-40%" y="-200%" width="180%" height="500%">
          <feGaussianBlur stdDeviation="3.4" />
        </filter>
        <filter id={`${id}h`} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      {working && (
        <ellipse
          className="lex-halo"
          cx="60"
          cy="58"
          rx="58"
          ry="56"
          fill="#3d6bff"
          filter={`url(#${id}h)`}
        />
      )}
      {fine && !working && (
        <ellipse
          cx="60"
          cy="123"
          rx="36"
          ry="6.5"
          fill="#000"
          opacity=".5"
          filter={`url(#${id}g)`}
        />
      )}

      {/* the side, then the top it is seen under */}
      <rect x="9" y="15" width="102" height="102" rx="33" fill={`url(#${id}s)`} />
      <rect x="9" y="5" width="102" height="102" rx="33" fill={`url(#${id}t)`} />
      {!off && <rect x="9" y="5" width="102" height="102" rx="33" fill={`url(#${id}l)`} />}
      {fine && !off && (
        <ellipse cx="44" cy="27" rx="27" ry="11" fill="#fff" opacity=".3" filter={`url(#${id}b)`} />
      )}
      <path
        d="M15 44 A 33 33 0 0 1 46 9"
        fill="none"
        stroke="#fff"
        strokeOpacity={off ? 0.5 : 0.6}
        strokeWidth={fine ? 2.2 : 3}
        strokeLinecap="round"
      />

      {off ? (
        <>
          <rect x="36" y="50" width="20" height="8" rx="4" fill={ink} />
          <rect x="65" y="50" width="20" height="8" rx="4" fill={ink} />
        </>
      ) : (
        <g className={state === "idle" || state === "speaking" ? "lex-eyes" : undefined}>
          {fine && (
            <>
              <rect
                x={38.5 + dx}
                y={eyeY + dy + 2.2}
                width="15.5"
                height={eyeH}
                rx="7.75"
                fill="#fff"
                fillOpacity=".3"
              />
              <rect
                x={67 + dx}
                y={eyeY + dy + 2.2}
                width="15.5"
                height={eyeH}
                rx="7.75"
                fill="#fff"
                fillOpacity=".3"
              />
            </>
          )}
          <rect
            x={38.5 + dx}
            y={eyeY + dy}
            width="15.5"
            height={eyeH}
            rx="7.75"
            fill={`url(#${id}e)`}
          />
          <rect
            x={67 + dx}
            y={eyeY + dy}
            width="15.5"
            height={eyeH}
            rx="7.75"
            fill={`url(#${id}e)`}
          />
          <circle
            cx={43.6 + dx + (working ? 3 : 0)}
            cy={eyeY + dy + 7.4}
            r="3"
            fill="#fff"
            opacity=".92"
          />
          <circle
            cx={72.1 + dx + (working ? 3 : 0)}
            cy={eyeY + dy + 7.4}
            r="3"
            fill="#fff"
            opacity=".92"
          />
        </g>
      )}

      {state === "idle" && fine && (
        <path
          d="M36 80.4 Q 59 99.4 86 73.4"
          fill="none"
          stroke="#fff"
          strokeOpacity=".3"
          strokeWidth="10.5"
          strokeLinecap="round"
        />
      )}
      {state === "idle" && (
        <path
          d="M36 78 Q 59 97 86 71"
          fill="none"
          stroke={ink}
          strokeWidth="10.5"
          strokeLinecap="round"
        />
      )}
      {state === "speaking" && (
        <path
          className="lex-talk"
          d="M38 74 Q 60 104 84 70 Z"
          fill={ink}
          stroke={ink}
          strokeWidth="6"
          strokeLinejoin="round"
        />
      )}
      {state === "listening" && (
        <ellipse className="lex-hear" cx="61" cy="83" rx="8.5" ry="9.5" fill={ink} />
      )}
      {(working || off) && (
        <path d="M48 82 H76" fill="none" stroke={ink} strokeWidth="10.5" strokeLinecap="round" />
      )}
    </svg>
  );
}
