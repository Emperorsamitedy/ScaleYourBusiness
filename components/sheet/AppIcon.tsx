// The app's icon art — idea 53 (I-53.1), redrawn for the ScaleX brand
// (concept A, "Ascent", 2026-11-15): the mark (components/brand/Mark.tsx)
// on a rounded tile. Large icons use the dark tile with white bars, as an
// app icon on a Home Screen; the small favicon uses the light tile with
// ink bars. Drawn by next/og at whatever size the metadata route asks for
// (app/icon.tsx, app/apple-icon.tsx), so there are no image files in the repo.

import { ImageResponse } from "next/og";
import { BRAND, MARK } from "../brand/Mark";

function markSvg(px: number, bar: string) {
  return (
    <svg width={px} height={px} viewBox="0 0 100 100">
      {MARK.bars.map(([x1, y1, x2, y2]) => (
        <line
          key={`${x1}-${y1}`}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={bar}
          strokeWidth={MARK.stroke}
          strokeLinecap="round"
        />
      ))}
      <line
        x1={MARK.shaft[0]}
        y1={MARK.shaft[1]}
        x2={MARK.shaft[2]}
        y2={MARK.shaft[3]}
        stroke={BRAND.accent}
        strokeWidth={MARK.stroke}
        strokeLinecap="round"
      />
      <polygon
        points={MARK.head}
        fill={BRAND.accent}
        stroke={BRAND.accent}
        strokeWidth={4}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The icon at `side` px: dark tile and white bars, or light tile and ink bars. */
export function wordmarkIcon(side: number, light = false): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: light ? "#F3F4F6" : BRAND.tile,
        borderRadius: light ? Math.round(side * 0.22) : 0,
      }}
    >
      {markSvg(Math.round(side * 0.62), light ? BRAND.ink : BRAND.paper)}
    </div>,
    { width: side, height: side },
  );
}
