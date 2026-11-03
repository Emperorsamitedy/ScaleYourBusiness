// "Propose this" — feature 36. An option the owner picked on the simulator
// becomes the NORMAL proposal for its kind, through that kind's own
// generation path and every gate on it (the watch, dedupe, suppression,
// the spend guard, the hard limits, the consent gate), with the simulated
// scenario attached. The simulation is recomputed here from fresh inputs —
// the browser's numbers are never trusted. Nothing executes (rule 12): the
// result is a pending proposal in the queue, or a born-blocked one in the
// restraint view, or a sentence saying why nothing was proposed.

import type { LimitLlm } from "../proposals/hard-limits";
import type { ProposalRow } from "../proposals/service";
import { proposeRequestedAdChange } from "../ads/proposals";
import { ContentError, proposeContentPlan } from "../content/plan";
import { proposeFromSegments } from "../crm/segment-proposals";
import { gatherInputs } from "./inputs";
import type { OptionResult, SimOption } from "./model";
import { CONTENT_WEEKS, simulateOption } from "./model";

export interface ProposeOutcome {
  /** The proposal made, pending or born blocked; null when nothing was proposed. */
  proposal: Pick<ProposalRow, "id" | "status" | "blocked_by_limit"> | null;
  /** Why nothing was proposed, in words. */
  skipped: string | null;
  result: OptionResult;
}

const made = (row: ProposalRow, result: OptionResult): ProposeOutcome => ({
  proposal: { id: row.id, status: row.status, blocked_by_limit: row.blocked_by_limit },
  skipped: null,
  result,
});

const none = (why: string, result: OptionResult): ProposeOutcome => ({
  proposal: null,
  skipped: why,
  result,
});

export async function proposeFromSimulation(
  profileId: string,
  option: SimOption,
  opts: { now?: Date; limitLlm?: LimitLlm } = {},
): Promise<ProposeOutcome> {
  const now = opts.now ?? new Date();
  // English on purpose (L-4b, rules 4 and 7): the simulation is stored on the
  // proposal and the reason is logged, so neither takes the reader's words.
  const inputs = await gatherInputs(profileId, now);
  const result = simulateOption(option, inputs);
  if (!result.proposable.ok) return none(result.proposable.why, result);
  const simulation = { result, as_of: inputs.as_of };
  const shared = { now, simulation, ...(opts.limitLlm ? { limitLlm: opts.limitLlm } : {}) };

  switch (option.kind) {
    case "email": {
      const run = await proposeFromSegments(profileId, { ...shared, only: option.segment });
      const row = run.created[0] ?? run.blocked[0];
      return row ? made(row, result) : none(run.skipped[0]?.reason ?? "nothing to propose", result);
    }
    case "ads": {
      if (option.change === "new") {
        return none(
          'A new ad starts from a post or video: on Content, "Run this as an ad" makes one proposal that creates it paused.',
          result,
        );
      }
      const run = await proposeRequestedAdChange(profileId, {
        ...shared,
        campaign_ref: option.campaign_ref,
        change:
          option.change === "pause"
            ? "pause"
            : option.change === "raise"
              ? "raise_budget"
              : "lower_budget",
        ...(option.change === "pause" ? {} : { share: option.share }),
      });
      const row = run.created[0];
      return row ? made(row, result) : none(run.skipped[0]?.reason ?? "nothing to propose", result);
    }
    case "content": {
      try {
        const row = await proposeContentPlan(profileId, { ...shared, weeks: CONTENT_WEEKS });
        return made(row, result);
      } catch (error) {
        if (error instanceof ContentError) return none(error.message, result);
        throw error;
      }
    }
  }
}
