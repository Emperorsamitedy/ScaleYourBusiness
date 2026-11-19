// A proposal born in the chat — the P3-36 request tier's write, shared
// with the change catalogue's "proposal" rows (feature 33). Same queue,
// same rule-14 check, same evidence shape as every other source: the
// conversation never executes anything; it can only ask the queue.

import type { DbTx } from "../../db";
import type { ActionKind, LimitLlm, LimitVerdict } from "../proposals/hard-limits";
import { checkHardLimits, ensureHardLimits, limitCaption } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { createProposal } from "../proposals/service";

export const CHAT_PROPOSAL_EXPIRY_DAYS = 14;

export async function proposeFromChat(args: {
  profileId: string;
  ownerUtteranceId: string;
  kind: ActionKind;
  /** The owner's words, or the change in plain words. */
  summary: string;
  rationale?: string;
  extra?: Record<string, unknown>;
  limitLlm?: LimitLlm;
  /** Join the caller's transaction (the chat's confirm, review 2026-10-23 #21). */
  tx?: DbTx;
}): Promise<{ proposal: ProposalRow; verdict: LimitVerdict }> {
  const { limits } = await ensureHardLimits(args.profileId, args.limitLlm);
  const verdict = checkHardLimits(limits, args.kind);
  const summary = args.summary.length > 120 ? `${args.summary.slice(0, 117)}…` : args.summary;
  const proposal = await createProposal(
    {
      profile_id: args.profileId,
      module: "conversation",
      originating_finding: `utterance:${args.ownerUtteranceId}`,
      action: {
        kind: args.kind,
        summary,
        detail: {
          rationale:
            args.rationale ??
            "You asked for this in chat: written up as a proposal, because nothing runs on phrasing alone.",
          manual_limits: verdict.manual.map((l) => l.quote),
          ...(args.extra ?? {}),
        },
      },
      scenario: {
        assumptions: [
          {
            statement: "This came from your own request, not from the diagnosis",
            value: null,
            source_field: null,
            sensitivity: "low",
          },
        ],
        base_case: {
          case: "base",
          statement: "Exactly what you asked for, done once you approve it in the queue.",
          profit_delta_monthly: null,
          formula: null,
        },
        downside_case: {
          case: "downside",
          statement: "You decline it in the queue and nothing happens.",
          profit_delta_monthly: null,
          formula: null,
        },
        upside_case: {
          case: "upside",
          statement: "It works and the readback will say by how much.",
          profit_delta_monthly: null,
          formula: null,
        },
        breakeven_condition: "not computed: a chat request carries no scenario arithmetic yet",
      } as never,
      reversibility: {
        level: "moderate",
        if_you_change_your_mind:
          "Decline it in the queue, or undo it after if the action supports undo.",
      },
      expires_at: new Date(Date.now() + CHAT_PROPOSAL_EXPIRY_DAYS * 86_400_000).toISOString(),
      blocked_by_limit: verdict.verdict === "blocked" ? limitCaption(verdict.limit) : null,
    },
    args.tx,
  );
  return { proposal, verdict };
}
