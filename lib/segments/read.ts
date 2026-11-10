// Reading a business's segment from its current facts (the multi-market
// spec Part C). Kept apart from ./segment.ts so the derivation stays pure.

import { readCurrentField } from "../profile/field-store";
import type { SegmentResult } from "./segment";
import { deriveSegment } from "./segment";

function code(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { code?: unknown }).code === "string") {
    return (v as { code: string }).code;
  }
  return null;
}

function count(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v !== null && typeof v === "object" && typeof (v as { value?: unknown }).value === "number") {
    return (v as { value: number }).value;
  }
  return null;
}

export async function segmentOf(profileId: string): Promise<SegmentResult> {
  const [form, team, band] = await Promise.all([
    readCurrentField<unknown>(profileId, "legal.entity_type"),
    readCurrentField<unknown>(profileId, "identity.team_size"),
    readCurrentField<unknown>(profileId, "identity.size_band"),
  ]);
  return deriveSegment({
    legal_form: form?.status === "answered" ? code(form.value) : null,
    team_size: team?.status === "answered" ? count(team.value) : null,
    size_band: band?.status === "answered" ? code(band.value) : null,
  });
}
