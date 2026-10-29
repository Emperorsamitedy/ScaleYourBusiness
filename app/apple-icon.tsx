// The Home Screen icon an iPhone uses (apple-touch-icon) — idea 53 (I-53.1).
// The same wordmark as app/icon.tsx, at Apple's 180 px.

import { wordmarkIcon } from "../components/sheet/AppIcon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return wordmarkIcon(size.width);
}
