// The owner's voice — Phase 3 Session C (P3-16).
//
// "Drafted in the owner's voice" is a checkable claim here, not vibes:
// the voice card is assembled from things the owner actually said and
// answered, and every trait on it names its source — a profile field
// key or an utterance id. The drafting prompt receives the card; the
// card is stored in each item's provenance; so for any stylistic
// choice the answer to "why does it sound like this?" is a lookup,
// not a shrug.
//
// Deterministic assembly, no model call: choosing which facts describe
// a voice is selection, not inference (CLAUDE.md cost rule).

import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { utterances } from "../../db/schema";
import { readCurrentField } from "../profile/field-store";
import type { HardLimit } from "../proposals/hard-limits";
import { ensureHardLimits } from "../proposals/hard-limits";
import type { LimitLlm } from "../proposals/hard-limits";

export interface VoiceTrait {
  statement: string;
  /** Field key or "utterance:<id>" — where this trait provably comes from. */
  source: string;
}

export interface VoiceCard {
  traits: VoiceTrait[];
  /** Verbatim owner sentences, style exemplars — the strongest signal. */
  exemplars: { text: string; source: string }[];
  /** 13.5 tone/tactic limits ride along — "never sound corporate" is a voice fact. */
  boundaries: string[];
}

const IDENTITY_KEYS: readonly { key: string; frame: (v: string) => string }[] = [
  { key: "identity.business_name", frame: (v) => `The business is called ${v}.` },
  { key: "identity.one_liner", frame: (v) => `In the owner's words, it is: ${v}` },
  { key: "customers.description", frame: (v) => `They describe their customers as: ${v}` },
  { key: "presence.brand_tone", frame: (v) => `Stated brand tone: ${v}` },
];

const MAX_EXEMPLARS = 6;

/** Build the voice card for a profile. Every entry carries its source. */
export async function buildVoiceCard(profileId: string, limitLlm?: LimitLlm): Promise<VoiceCard> {
  const traits: VoiceTrait[] = [];
  for (const { key, frame } of IDENTITY_KEYS) {
    const field = await readCurrentField<string>(profileId, key);
    if (field && typeof field.value === "string" && field.value.trim() !== "") {
      traits.push({ statement: frame(field.value.trim()), source: key });
    }
  }

  // The owner's own sentences, longest-first from their intake replies:
  // long free-text answers carry the most style. Verbatim, attributed.
  const rows = await db
    .select({ id: utterances.id, text: utterances.text })
    .from(utterances)
    .where(eq(utterances.profile_id, profileId))
    .orderBy(asc(utterances.at));
  const exemplars = rows
    .filter((r) => r.text.trim().split(/\s+/).length >= 12)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_EXEMPLARS)
    .map((r) => ({ text: r.text.trim(), source: `utterance:${r.id}` }));

  // 13.5 limits about tone and tactics belong on the card — a drafting
  // model that never sees "never sound corporate" will sound corporate.
  const { limits } = await ensureHardLimits(profileId, limitLlm);
  const boundaries = limits.map((l: HardLimit) => l.quote);

  return { traits, exemplars, boundaries };
}

/** The card rendered for a system prompt — and stored in provenance verbatim. */
export function renderVoiceCard(card: VoiceCard): string {
  const lines: string[] = [];
  if (card.traits.length > 0) {
    lines.push("About this business, from its own profile:");
    for (const t of card.traits) lines.push(`- ${t.statement}`);
  }
  if (card.exemplars.length > 0) {
    lines.push("", "The owner's own sentences — match this register, not a generic one:");
    for (const e of card.exemplars) lines.push(`- "${e.text}"`);
  }
  if (card.boundaries.length > 0) {
    lines.push("", "The owner's hard boundaries — never cross these:");
    for (const b of card.boundaries) lines.push(`- ${b}`);
  }
  return lines.join("\n");
}
