// The app's icon — idea 53 (I-53.1), at the two sizes the manifest names
// (/icon/192 and /icon/512), plus a 32 px favicon on the light tile
// (ScaleX brand, 2026-11-15). The art is components/sheet/AppIcon.tsx.

import { wordmarkIcon } from "../components/sheet/AppIcon";

export const contentType = "image/png";

const SIZES = [32, 192, 512] as const;

export function generateImageMetadata() {
  return SIZES.map((s) => ({ id: String(s), size: { width: s, height: s }, contentType }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const n = Number(await id);
  if (n === 32) return wordmarkIcon(32, true);
  return wordmarkIcon(n === 512 ? 512 : 192);
}
