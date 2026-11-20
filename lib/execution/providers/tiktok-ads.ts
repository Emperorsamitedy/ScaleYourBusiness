// The TikTok ad executor — TikTok Ads (specs/tiktok-ads-api-v1.md), the
// TikTok side of P3-22b/c, mirroring the Meta ad executor (./meta.ts).
//
// Three ops, each reversible, each run only by the execution engine on an
// approved proposal (rule 12), only when SESSION_D_REAL_WRITES=on (guard
// 6a: `external: true`), and only through lib/tiktok/api's fence:
//
//   pause_campaign     operation_status DISABLE; undo puts back the status
//   resume_campaign    operation_status ENABLE;  undo puts back the status
//   set_daily_budget   budget (BUDGET_MODE_DAY campaigns only), from the
//                      budget captured before attempt one; undo puts it back
//
// Nothing is created and nothing is deleted: TikTok's DELETE is permanent,
// so it is not an op and the fence refuses it. Every op first reads the
// campaign and refuses one outside the connected ad accounts, or in any
// state but on or off. TikTok has no dry run for these endpoints, so the
// re-read and SYB's own guards stand where Meta's validate_only stands.
//
// THE GUARDRAILS (P3-22c), again inside the executor: no change beyond
// ±50% of the captured budget, never under TikTok's campaign minimum
// (50 × the currency's ratio), never past the owner's monthly ad ceiling
// over the whole account (Meta and TikTok campaigns together, rule 1: one
// currency). A HUF budget goes to TikTok in whole forints.
//
// UNDO only while the live value is still what SYB set; the owner's own
// later change stands. An undo that would spend again (un-pausing, putting
// a lowered budget back up) is held to the real-write gate and the ceiling.

import { format, money, scaleMinor } from "../../core/money";
import { reactivationGuard, spendGuard } from "../../ads/guard";
import type { TikTokContext, TikTokCredential } from "../../tiktok/api";
import {
  TikTokFenceError,
  TikTokRequestError,
  defaultTikTokContext,
  tiktokCall,
} from "../../tiktok/api";
import {
  UnknownTikTokCurrencyError,
  fromTikTokBudget,
  tiktokMinDailyMinor,
  toTikTokBudget,
} from "../../tiktok/budget";
import { readAdvertiserCurrencies } from "../../tiktok/read";
import { staleAdChange } from "../stale";
import type { ExecutionContext, ExecutionProvider } from "./fixture";

export type TikTokAdOp = "pause_campaign" | "resume_campaign" | "set_daily_budget";

const STATUS_WORD: Readonly<Record<string, string>> = { ENABLE: "running", DISABLE: "paused" };
const TOUCHABLE = ["ENABLE", "DISABLE"];
const ID = /^\d{5,25}$/;

export class TikTokAdChangeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "TikTokAdChangeError";
    this.retryable = retryable;
  }
}

/** The ad ops' state, held by the database (lib/ads/executing.ts). Injected, as Meta's AdsBackend is. */
export interface TikTokAdsBackend {
  /** The live tiktok_ads credential, or the sentence saying why there is none. */
  credential(accountId: string): Promise<TikTokCredential | { refused: string }>;
  /** The undo payload the engine stored before attempt one — a budget change's baseline. */
  capturedUndo(executionId: string): Promise<unknown>;
  /** The owner's stated monthly ad ceiling (8.1i) — the same fact the generator reads. */
  ceiling(profileId: string): Promise<{ amount_minor: number; currency: string } | null>;
  /** The account's measured average day in this currency, every ad platform together, or null. */
  accountDailySpend(accountId: string, currency: string): Promise<number | null>;
  /** One watch-log line for the owner: "Paused "Spring sale" on TikTok." */
  changed(profileId: string, detail: string, meta: Record<string, unknown>): Promise<void>;
}

interface CampaignState {
  id: string;
  advertiser_id: string;
  name: string;
  /** TikTok's operation_status: ENABLE | DISABLE (anything else is untouchable). */
  status: string;
  secondary_status: string | null;
  budget_mode: string | null;
  /** TikTok's float, major units; null when it reports none. */
  budget: number | null;
  currency: string;
}

const fmt = (minor: number, currency: string) => format(money(minor, currency));

function isTikTokAdOp(op: string): op is TikTokAdOp {
  return op === "pause_campaign" || op === "resume_campaign" || op === "set_daily_budget";
}

function campaignIdOf(params: Record<string, unknown>): string {
  const id = params["campaign_id"];
  if (typeof id !== "string" || !ID.test(id)) {
    throw new TikTokAdChangeError("the ad change names no TikTok campaign: nothing was sent");
  }
  return id;
}

function shareOf(params: Record<string, unknown>): number {
  const share = params["share"];
  if (typeof share !== "number" || !Number.isFinite(share) || share === 0) {
    throw new TikTokAdChangeError("the budget change names no amount: nothing was sent");
  }
  return share;
}

function approvedCurrency(params: Record<string, unknown>): string {
  const c = params["currency"];
  if (typeof c !== "string" || !/^[A-Za-z]{3}$/.test(c)) {
    throw new TikTokAdChangeError("the budget change names no currency: nothing was sent");
  }
  return c.toUpperCase();
}

function logAdChange(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "ad_change", platform: "tiktok", ...event }));
}

function refusalFrom(error: TikTokRequestError): TikTokAdChangeError {
  return new TikTokAdChangeError(
    error.kind === "not_found"
      ? "TikTok has no such campaign on the connected ad accounts. Nothing was changed."
      : error.message,
    error.retryable,
  );
}

export interface TikTokExecutionOptions {
  fetch?: TikTokContext["fetch"];
  sleep?: TikTokContext["sleep"];
  backend?: TikTokAdsBackend | (() => Promise<TikTokAdsBackend>);
}

/** The ads executor, with its HTTP and its database injected. */
export function createTikTokAdsExecutor(opts: TikTokExecutionOptions = {}): ExecutionProvider {
  const ctx = defaultTikTokContext({
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  });
  const loadBackend = async (): Promise<TikTokAdsBackend> => {
    if (typeof opts.backend === "function") return opts.backend();
    if (opts.backend) return opts.backend;
    // Loaded on use: lib/ads sits above lib/execution, as for Meta's backend.
    const { dbTikTokAdsBackend } = await import("../../ads/executing");
    return dbTikTokAdsBackend();
  };

  interface Run {
    b: TikTokAdsBackend;
    cred: TikTokCredential;
    account_id: string;
  }

  async function open(accountId: string): Promise<Run> {
    const b = await loadBackend();
    const cred = await b.credential(accountId);
    if ("refused" in cred) throw new TikTokAdChangeError(cred.refused);
    return { b, cred, account_id: accountId };
  }

  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof TikTokRequestError) throw refusalFrom(error);
      if (error instanceof TikTokFenceError || error instanceof UnknownTikTokCurrencyError) {
        throw new TikTokAdChangeError(error.message);
      }
      if (error instanceof RangeError) throw new TikTokAdChangeError(error.message);
      throw error;
    }
  }

  /** The campaign, proven to sit in one of the connected ad accounts. */
  async function readCampaign(run: Run, campaignId: string): Promise<CampaignState> {
    const currencies = await readAdvertiserCurrencies(ctx, run.cred, run.account_id);
    for (const advertiserId of run.cred.advertiser_ids) {
      const data = await tiktokCall(ctx, "campaign_get", {
        token: run.cred.access_token,
        query: {
          advertiser_id: advertiserId,
          filtering: { campaign_ids: [campaignId] },
          fields: [
            "campaign_id",
            "advertiser_id",
            "campaign_name",
            "operation_status",
            "secondary_status",
            "budget_mode",
            "budget",
          ],
        },
        account_id: run.account_id,
      });
      const list = Array.isArray(data["list"]) ? data["list"] : [];
      const found = list
        .map((c) => (c ?? {}) as Record<string, unknown>)
        .find((c) => String(c["campaign_id"] ?? "") === campaignId);
      if (!found) continue;
      if (String(found["advertiser_id"] ?? advertiserId) !== advertiserId) continue;
      const currency = currencies.get(advertiserId);
      if (!currency) {
        throw new TikTokAdChangeError(
          "TikTok didn't say which currency the ad account bills in. Nothing was changed.",
        );
      }
      const budget =
        typeof found["budget"] === "number" ? found["budget"] : Number(found["budget"]);
      return {
        id: campaignId,
        advertiser_id: advertiserId,
        name:
          typeof found["campaign_name"] === "string" && found["campaign_name"] !== ""
            ? found["campaign_name"]
            : campaignId,
        status:
          typeof found["operation_status"] === "string" ? found["operation_status"] : "UNKNOWN",
        secondary_status:
          typeof found["secondary_status"] === "string" ? found["secondary_status"] : null,
        budget_mode: typeof found["budget_mode"] === "string" ? found["budget_mode"] : null,
        budget: Number.isFinite(budget) && budget > 0 ? budget : null,
        currency,
      };
    }
    throw new TikTokAdChangeError(
      `Campaign ${campaignId} isn't in the connected TikTok ad accounts. Nothing was changed.`,
    );
  }

  /** Only a campaign that is on or off is touched; a deleted one is permanent on TikTok. */
  function touchable(c: CampaignState): void {
    if (!TOUCHABLE.includes(c.status) || /DELETE/i.test(c.secondary_status ?? "")) {
      throw new TikTokAdChangeError(
        `"${c.name}" is ${c.status.toLowerCase()} on TikTok, and ScaleX only pauses, resumes or re-budgets campaigns that are on or off. Nothing was changed.`,
      );
    }
  }

  function dailyBudgetMinor(c: CampaignState): number {
    if (c.budget_mode !== "BUDGET_MODE_DAY" || c.budget === null) {
      throw new TikTokAdChangeError(
        `"${c.name}" has no daily budget on the campaign (TikTok calls its budget ${c.budget_mode ?? "unset"}), and ScaleX changes campaign daily budgets only. Nothing was changed.`,
      );
    }
    return fromTikTokBudget(c.budget, c.currency);
  }

  /** P3-22c inside the executor: the new budget from a baseline, through the same spend guard. */
  async function guardedBudget(
    run: Run,
    args: {
      profile_id: string;
      campaign: CampaignState;
      baseline_minor: number;
      share: number;
      currency: string;
    },
  ): Promise<{ value: number; sent_minor: number }> {
    const { campaign } = args;
    if (campaign.currency !== args.currency) {
      throw new TikTokAdChangeError(
        `You approved this change in ${args.currency}, but the ad account bills in ${campaign.currency}. Nothing was changed; it needs approving again.`,
      );
    }
    const target = args.baseline_minor + scaleMinor(args.baseline_minor, args.share);
    const { value, sent_minor } = toTikTokBudget(target, campaign.currency, args.baseline_minor);
    const ceiling = await run.b.ceiling(args.profile_id);
    const accountDaily = ceiling
      ? await run.b.accountDailySpend(run.account_id, campaign.currency)
      : null;
    const refusal = spendGuard({
      current_daily_minor: args.baseline_minor,
      proposed_daily_minor: sent_minor,
      currency: campaign.currency,
      ...(accountDaily !== null ? { account_daily_minor: accountDaily } : {}),
      monthly_ceiling: ceiling,
      floor_minor: tiktokMinDailyMinor(campaign.currency),
      platform: "TikTok",
    });
    if (refusal !== null) {
      throw new TikTokAdChangeError(
        `I didn't change "${campaign.name}": ${refusal}. Nothing was changed.`,
      );
    }
    return { value, sent_minor };
  }

  async function setStatus(
    run: Run,
    c: CampaignState,
    status: "ENABLE" | "DISABLE",
  ): Promise<void> {
    const data = await tiktokCall(ctx, "campaign_status_update", {
      token: run.cred.access_token,
      body: { advertiser_id: c.advertiser_id, campaign_ids: [c.id], operation_status: status },
      account_id: run.account_id,
    });
    const ids = Array.isArray(data["campaign_ids"]) ? data["campaign_ids"].map(String) : null;
    if (ids !== null && !ids.includes(c.id)) {
      throw new TikTokAdChangeError(
        `TikTok didn't confirm the change to "${c.name}": I'll check again.`,
        true,
      );
    }
  }

  async function setBudget(run: Run, c: CampaignState, value: number): Promise<void> {
    const data = await tiktokCall(ctx, "campaign_update", {
      token: run.cred.access_token,
      body: { advertiser_id: c.advertiser_id, campaign_id: c.id, budget: value },
      account_id: run.account_id,
    });
    if (data["campaign_id"] !== undefined && String(data["campaign_id"]) !== c.id) {
      throw new TikTokAdChangeError(
        `TikTok didn't confirm the change to "${c.name}": I'll check again.`,
        true,
      );
    }
  }

  /** Everything the attempt checks, reads only: what a pre-flight refusal would say. */
  async function checks(
    op: TikTokAdOp,
    params: Record<string, unknown>,
    pctx: ExecutionContext,
  ): Promise<void> {
    const run = await open(pctx.account_id);
    const c = await readCampaign(run, campaignIdOf(params));
    touchable(c);
    if (op === "pause_campaign" && c.status === "DISABLE") {
      throw new TikTokAdChangeError(`"${c.name}" is already paused. Nothing was sent.`);
    }
    if (op === "resume_campaign" && c.status === "ENABLE") {
      throw new TikTokAdChangeError(`"${c.name}" is already running. Nothing was sent.`);
    }
    if (op === "set_daily_budget") {
      await guardedBudget(run, {
        profile_id: pctx.profile_id,
        campaign: c,
        baseline_minor: dailyBudgetMinor(c),
        share: shareOf(params),
        currency: approvedCurrency(params),
      });
    }
  }

  return {
    id: "tiktok_ads",
    external: true,

    async staleApproval(op, _params, pctx, approval) {
      // An ad change rests on measured days that go stale; an old approval isn't acted on.
      const sentence = staleAdChange(approval, approval.now);
      if (sentence !== null) {
        logAdChange({ account_id: pctx.account_id, op, phase: "stale", outcome: "lapsed" });
      }
      return sentence;
    },

    async preflight(op, params, pctx) {
      if (!isTikTokAdOp(op))
        return { code: "refused", message: `"${op}" is not an ad change ScaleX makes on TikTok` };
      try {
        await guarded(() => checks(op, params, pctx));
        logAdChange({ account_id: pctx.account_id, op, phase: "preflight", outcome: "ok" });
        return null;
      } catch (error) {
        if (error instanceof TikTokAdChangeError) {
          logAdChange({ account_id: pctx.account_id, op, phase: "preflight", outcome: "refused" });
          return { code: error.retryable ? "deferred" : "refused", message: error.message };
        }
        throw error;
      }
    },

    async captureUndo(op, params, pctx) {
      if (!isTikTokAdOp(op)) return null;
      return guarded(async () => {
        const run = await open(pctx.account_id);
        const c = await readCampaign(run, campaignIdOf(params));
        touchable(c);
        if (op === "set_daily_budget") {
          return {
            campaign_id: c.id,
            advertiser_id: c.advertiser_id,
            campaign_name: c.name,
            budget: c.budget,
            daily_budget_minor: dailyBudgetMinor(c),
            currency: c.currency,
          };
        }
        return {
          campaign_id: c.id,
          advertiser_id: c.advertiser_id,
          campaign_name: c.name,
          status: c.status,
        };
      });
    },

    async execute(op, params, pctx) {
      if (!isTikTokAdOp(op))
        throw new TikTokAdChangeError(`"${op}" is not an ad change ScaleX makes on TikTok`);
      return guarded(async () => {
        const run = await open(pctx.account_id);
        const c = await readCampaign(run, campaignIdOf(params));
        touchable(c);
        if (op === "pause_campaign" || op === "resume_campaign") {
          const target = op === "pause_campaign" ? "DISABLE" : "ENABLE";
          // Already there: an earlier attempt landed and its answer was lost. Setting it twice is harmless.
          if (c.status !== target) await setStatus(run, c, target);
          await run.b.changed(
            pctx.profile_id,
            `${target === "DISABLE" ? "Paused" : "Resumed"} "${c.name}" on TikTok.`,
            { campaign_id: c.id, op, platform: "tiktok" },
          );
          logAdChange({
            account_id: pctx.account_id,
            op,
            phase: "execute",
            outcome: "changed",
            campaign_id: c.id,
          });
          return {
            campaign_id: c.id,
            campaign_name: c.name,
            status: target,
            previous_status: c.status === target ? null : c.status,
          };
        }
        // set_daily_budget — from the budget captured before attempt one, never the live one.
        const captured = (
          pctx.execution_id ? await run.b.capturedUndo(pctx.execution_id) : null
        ) as {
          daily_budget_minor?: unknown;
          currency?: unknown;
        } | null;
        const baseline = captured?.daily_budget_minor;
        if (typeof baseline !== "number" || typeof captured?.currency !== "string") {
          throw new TikTokAdChangeError(
            "The budget before this change wasn't recorded, so I won't change it. Nothing was changed.",
          );
        }
        dailyBudgetMinor(c); // still a daily budget on the campaign
        const { value, sent_minor } = await guardedBudget(run, {
          profile_id: pctx.profile_id,
          campaign: c,
          baseline_minor: baseline,
          share: shareOf(params),
          currency: approvedCurrency(params),
        });
        if (c.budget !== value) await setBudget(run, c, value);
        await run.b.changed(
          pctx.profile_id,
          `Changed "${c.name}"'s daily budget on TikTok from ${fmt(baseline, c.currency)} to ${fmt(sent_minor, c.currency)}.`,
          { campaign_id: c.id, op, platform: "tiktok" },
        );
        logAdChange({
          account_id: pctx.account_id,
          op,
          phase: "execute",
          outcome: "changed",
          campaign_id: c.id,
        });
        return {
          campaign_id: c.id,
          campaign_name: c.name,
          daily_budget_before_minor: baseline,
          daily_budget_minor: sent_minor,
          currency: c.currency,
          sent_budget: value,
        };
      });
    },

    undoRaisesSpend(op, undoPayload, result) {
      // Pure. Undoing a pause re-activates spend; undoing a resume stops it.
      if (op === "pause_campaign") return true;
      if (op !== "set_daily_budget") return false;
      const previous = (undoPayload as { daily_budget_minor?: unknown } | null)?.daily_budget_minor;
      const sent = (result as { daily_budget_minor?: unknown } | null)?.daily_budget_minor;
      // Not knowable from the record: treated as raising, so the gate and guards apply.
      if (typeof previous !== "number" || typeof sent !== "number") return true;
      return previous > sent;
    },

    async undo(op, undoPayload, pctx) {
      if (!isTikTokAdOp(op))
        throw new TikTokAdChangeError(`"${op}" is not an ad change ScaleX makes on TikTok`);
      const u = (undoPayload ?? {}) as {
        campaign_id?: unknown;
        status?: unknown;
        budget?: unknown;
        daily_budget_minor?: unknown;
        currency?: unknown;
      };
      const done = (pctx.result ?? {}) as {
        status?: unknown;
        sent_budget?: unknown;
        daily_budget_minor?: unknown;
      };
      return guarded(async () => {
        const run = await open(pctx.account_id);
        const c = await readCampaign(run, campaignIdOf({ campaign_id: u.campaign_id }));
        touchable(c);
        const changedSince = (now: string, set: string) =>
          new TikTokAdChangeError(
            `I didn't undo this: "${c.name}" is ${now} on TikTok now, not the ${set} I set: you've changed it since, and I won't override that. Nothing was changed.`,
          );
        if (op === "pause_campaign" || op === "resume_campaign") {
          if (u.status !== "ENABLE" && u.status !== "DISABLE") {
            throw new TikTokAdChangeError(
              "the stored undo names no status ScaleX may set: nothing was changed",
            );
          }
          const set = typeof done.status === "string" ? done.status : null;
          if (c.status !== u.status) {
            if (set === null || c.status !== set) {
              throw changedSince(
                STATUS_WORD[c.status] ?? c.status.toLowerCase(),
                `${STATUS_WORD[set ?? ""] ?? "status"}`,
              );
            }
            if (u.status === "ENABLE") {
              // Running it again spends again: the owner's stated ceiling bounds it.
              const ceiling = await run.b.ceiling(pctx.profile_id);
              const daily =
                c.budget_mode === "BUDGET_MODE_DAY" && c.budget !== null
                  ? fromTikTokBudget(c.budget, c.currency)
                  : null;
              const refusal = reactivationGuard({
                campaign_daily_minor: daily,
                account_daily_minor: ceiling
                  ? await run.b.accountDailySpend(run.account_id, c.currency)
                  : null,
                currency: c.currency,
                monthly_ceiling: ceiling,
              });
              if (refusal !== null) {
                throw new TikTokAdChangeError(
                  `I didn't undo the pause of "${c.name}": ${refusal}. Nothing was changed.`,
                );
              }
            }
            await setStatus(run, c, u.status);
          }
          await run.b.changed(
            pctx.profile_id,
            `Undid: "${c.name}" is ${STATUS_WORD[u.status]} on TikTok again.`,
            { campaign_id: c.id, op, undo: true, platform: "tiktok" },
          );
          logAdChange({
            account_id: pctx.account_id,
            op,
            phase: "undo",
            outcome: "restored",
            campaign_id: c.id,
          });
          return { campaign_id: c.id, status: u.status };
        }
        // set_daily_budget
        const previousMinor = u.daily_budget_minor;
        if (typeof previousMinor !== "number" || typeof u.currency !== "string") {
          throw new TikTokAdChangeError("the stored undo names no budget: nothing was changed");
        }
        const currency = u.currency;
        const live = dailyBudgetMinor(c);
        const sent = typeof done.daily_budget_minor === "number" ? done.daily_budget_minor : null;
        if (live !== previousMinor) {
          if (sent === null || live !== sent) {
            throw changedSince(
              `at ${fmt(live, currency)} a day`,
              sent === null ? "budget" : `${fmt(sent, currency)} budget`,
            );
          }
          if (previousMinor > sent) {
            // Putting a lowered budget back up raises spend: the same guard as any raise.
            const ceiling = await run.b.ceiling(pctx.profile_id);
            const refusal = spendGuard({
              current_daily_minor: sent,
              proposed_daily_minor: previousMinor,
              currency,
              ...(ceiling
                ? {
                    account_daily_minor:
                      (await run.b.accountDailySpend(run.account_id, currency)) ?? sent,
                  }
                : {}),
              monthly_ceiling: ceiling,
              floor_minor: tiktokMinDailyMinor(currency),
              platform: "TikTok",
            });
            if (refusal !== null) {
              throw new TikTokAdChangeError(
                `I didn't undo the budget change of "${c.name}": ${refusal}. Nothing was changed.`,
              );
            }
          }
          await setBudget(run, c, toTikTokBudget(previousMinor, currency).value);
        }
        await run.b.changed(
          pctx.profile_id,
          `Undid: "${c.name}"'s daily budget on TikTok is ${fmt(previousMinor, currency)} again.`,
          { campaign_id: c.id, op, undo: true, platform: "tiktok" },
        );
        logAdChange({
          account_id: pctx.account_id,
          op,
          phase: "undo",
          outcome: "restored",
          campaign_id: c.id,
        });
        return { campaign_id: c.id, daily_budget_minor: previousMinor, currency };
      });
    },
  };
}

export const tiktokAdsExecutor = createTikTokAdsExecutor();
