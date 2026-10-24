// Drafting — Phase 3 Session C (P3-16). Sonnet writes; the fence around
// it is total:
//
//   · the voice card (voice.ts) is the whole of what the model knows —
//     traits and exemplars with statable sources, and the 13.5
//     boundaries in plain sight
//   · the model may not invent numbers, offers, claims or discounts;
//     the prompt says so and the brief carries only profile facts
//   · disclosure is applied AFTER the model, by code (P3-19) — a label
//     the model writes is a label the model could forget
//
// The seam is injectable like every model boundary in this repo
// (parser, limits, classifier): deterministic tests, live verify.

import { textOf } from "../llm/answer";
import { anthropicClient } from "../llm/client";
import { buildCallRecord, recordLlmCall } from "../llm/cost-log";
import type { PlannedItem } from "./plan";
import type { VoiceCard } from "./voice";
import { renderVoiceCard } from "./voice";
import type { ContentKind } from "./disclosure";
import { withDisclosure } from "./disclosure";

export const DRAFT_MODEL = "claude-sonnet-5";

export type DraftLlm = (args: {
  system: string;
  user: string;
  accountId: string;
}) => Promise<{ text: string }>;

const SYSTEM_BASE = `You draft ONE piece of content for a small business, in the owner's own voice.

Hard rules:
- Use ONLY facts present in the brief and the voice card. Never invent numbers, prices, claims, testimonials, discounts or urgency.
- Match the owner's register from their example sentences — their rhythm, their plainness or their color. Do not sand it into marketing-speak.
- Respect every stated boundary absolutely.
- No hashtag walls; at most two hashtags if the platform warrants any.
- Plain text only. No markdown headers, no emoji unless the owner's own sentences use them.
- Output the content only — no preamble, no explanation.`;

export const liveDraftLlm: DraftLlm = async ({ system, user, accountId }) => {
  const started = Date.now();
  const response = await anthropicClient().messages.create({
    model: DRAFT_MODEL,
    max_tokens: 900,
    system,
    messages: [{ role: "user", content: user }],
  });
  await recordLlmCall(
    buildCallRecord({
      workload: "content",
      account_id: accountId,
      model: DRAFT_MODEL,
      duration_ms: Date.now() - started,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }),
  );
  // By type, not position: a model that thinks first puts its answer later.
  return { text: textOf(response.content) };
};

export interface DraftResult {
  body: string;
  /** What produced it — stored verbatim in the item's provenance. */
  provenance: {
    model: string;
    voice_card: VoiceCard;
    brief: string;
  };
}

/**
 * Draft one planned item in the owner's voice, disclosure applied by
 * code on the way out.
 */
export async function draftItem(args: {
  card: VoiceCard;
  item: PlannedItem;
  kind: ContentKind;
  accountId: string;
  llm?: DraftLlm;
}): Promise<DraftResult> {
  const llm = args.llm ?? liveDraftLlm;
  const brief =
    `Format: ${args.item.format}. Channel: ${args.item.channel_label}. ` +
    `Scheduled for ${args.item.date}. Focus: ${args.item.focus}. Brief: ${args.item.brief}`;
  const system = `${SYSTEM_BASE}\n\n${renderVoiceCard(args.card)}`;
  const { text } = await llm({ system, user: brief, accountId: args.accountId });
  const body = text.trim();
  if (body === "") throw new Error("the draft came back empty");
  return {
    body: withDisclosure(args.kind, body),
    provenance: { model: DRAFT_MODEL, voice_card: args.card, brief },
  };
}
