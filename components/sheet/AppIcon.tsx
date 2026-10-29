// The app's icon art — idea 53 (I-53.1): the wordmark on the ink masthead
// over its cobalt rule (ux-spec §2). Drawn by next/og at whatever size the
// metadata route asks for (app/icon.tsx, app/apple-icon.tsx), so there are
// no image files in the repo.

import { ImageResponse } from "next/og";

export function wordmarkIcon(side: number): ImageResponse {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0E1A13",
        color: "#F2F7F4",
        fontSize: Math.round(side * 0.34),
        fontWeight: 700,
        letterSpacing: Math.round(side * 0.01),
      }}
    >
      <div style={{ display: "flex" }}>SYB</div>
      <div
        style={{
          display: "flex",
          width: Math.round(side * 0.5),
          height: Math.max(2, Math.round(side * 0.025)),
          marginTop: Math.round(side * 0.04),
          background: "#3D6BFF",
        }}
      />
    </div>,
    { width: side, height: side },
  );
}
