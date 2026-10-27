// Session K, wired at merge: the creative brief (P3-51) reaches the two
// steps that come after it. An item made from a brief's hook carries
// `brief_id` and `hook_index` in its provenance (produceFromProposal); a
// cut of the owner's footage keeps them (placeMedia). From there:
//
//   · P3-53 — the AI fallback's prompt takes that hook and its script
//     (generation.ts BriefInput) when the owner gave no direction of
//     their own;
//   · P3-54 — the ad's audience takes the brief's country and its
//     audience in words (targeting.ts AdAudienceInput; the words are
//     shown on the proposal, never sent as targeting).
//
// Profile-scoped, like every other read: a brief id copied onto another
// business's item finds nothing.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { creativeBriefs } from "../../db/schema";
import type { AdAudienceInput } from "../ads/targeting";
import { type BriefRead, briefReadOf } from "./brief";
import type { BriefInput } from "./generation";

export interface ItemBrief {
  brief: BriefRead;
  /** The hook the item was made from, when it names one. */
  hook: BriefRead["hooks"][number] | null;
}

/** The brief id and hook index an item's provenance names, or null. */
export function briefRefOf(
  provenance: unknown,
): { brief_id: string; hook_index: number | null } | null {
  const p = provenance as { brief_id?: unknown; hook_index?: unknown } | null;
  if (typeof p?.brief_id !== "string" || !/^[0-9a-f-]{36}$/i.test(p.brief_id)) return null;
  return {
    brief_id: p.brief_id,
    hook_index: Number.isInteger(p.hook_index) ? (p.hook_index as number) : null,
  };
}

/** The brief an item was made from, read for that item's own business. */
export async function briefForItem(
  profileId: string,
  provenance: unknown,
): Promise<ItemBrief | null> {
  const ref = briefRefOf(provenance);
  if (!ref) return null;
  const [row] = await db
    .select()
    .from(creativeBriefs)
    .where(and(eq(creativeBriefs.id, ref.brief_id), eq(creativeBriefs.profile_id, profileId)));
  if (!row) return null;
  const brief = briefReadOf(row);
  const hook = ref.hook_index === null ? null : (brief.hooks[ref.hook_index] ?? null);
  return { brief, hook };
}

/** P3-53's prompt input: the hook and its script, or null without one. */
export function briefInputOf(found: ItemBrief | null): BriefInput | null {
  if (!found?.hook) return null;
  return { hook: found.hook.hook, script: found.hook.script };
}

/** P3-54's audience input: the brief's country and its audience in words. */
export function briefAudienceOf(found: ItemBrief | null): AdAudienceInput | null {
  if (!found) return null;
  const country = found.brief.audience.countries[0];
  const words = found.brief.audience.text.trim();
  if (!country && !words) return null;
  return {
    ...(country ? { location: { country } } : {}),
    ...(words ? { interests: words } : {}),
  };
}
