// The app's icon — idea 53 (I-53.1), at the two sizes the manifest names
// (/icon/192 and /icon/512). The art is components/sheet/AppIcon.tsx.

import { wordmarkIcon } from "../components/sheet/AppIcon";

export const contentType = "image/png";

const SIZES = [192, 512] as const;

export function generateImageMetadata() {
  return SIZES.map((s) => ({ id: String(s), size: { width: s, height: s }, contentType }));
}

export default async function Icon({ id }: { id: Promise<string | number> }) {
  const side = Number(await id) === 512 ? 512 : 192;
  return wordmarkIcon(side);
}
