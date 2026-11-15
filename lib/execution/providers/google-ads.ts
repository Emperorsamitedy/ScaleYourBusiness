// The Google Ads executor — P3-22's Google half (Session D, layer D3).
//
// THE ONLY FILE THAT MAY NAME A GOOGLE ADS MUTATE ENDPOINT. Everything else
// that talks to Google Ads reads, through lib/google-ads/client.ts's fence
// (search endpoints only); lib/google-ads/client.test.ts fails the build if
// ":mutate" appears in any other source file. Reached only through the
// engine (lib/execution/engine.ts), so every change here inherits what the
// engine guarantees: a recorded human approval (rule 12), the emergency
// stop (checked again between Google's dry run and the change), one
// execution row per approval (idempotency), the journal, the stored undo
// captured before attempt one (rule 16), and the real-write gate —
// `external: true`, so with SESSION_D_REAL_WRITES anything but "on" the
// engine refuses before anything is sent and the proposal stays approved.
//
// THREE OPS, each reversible (lib/execution/scopes.ts, google_ads):
//   pause_campaign   campaigns:mutate, status PAUSED        undo: the status before
//   resume_campaign  campaigns:mutate, status ENABLED       undo: the status before
//   set_daily_budget campaignBudgets:mutate, amountMicros   undo: the budget before
//
// Every change re-reads the campaign first (GAQL, through the read client),
// is sent with validateOnly first (Google's dry run), and is held again to
// the P3-22c spend guard: ±50% of the budget captured before attempt one,
// and the owner's stated monthly ceiling over the whole account (every
// campaign, Meta's and Google's, in that currency; rule 1, never converted).
// A budget shared with other campaigns, or a budget that isn't daily, is
// refused by name: changing it would change campaigns nobody approved.
// Re-activating spend (a resume, or undoing a pause) is held to the ceiling.
// Nothing here touches billing, payments or a payment method (rule 18): the
// only fields ever written are `status` and `amountMicros`, and
// google-ads-exec.test.ts pins that.
//
// Shapes, from Google's docs (2026-11-08; specs/google-ads-api-v1.md):
//   POST https://googleads.googleapis.com/v26/customers/{id}/campaigns:mutate
//     {operations:[{updateMask:"status", update:{resourceName, status}}], validateOnly}
//   POST …/campaignBudgets:mutate
//     {operations:[{updateMask:"amountMicros", update:{resourceName, amountMicros}}], validateOnly}
//   answer {results:[{resourceName}]}
// The status-only mask and the camelCase "amountMicros" mask are NOT shown in
// Google's pages (verified: false): proto3's JSON mapping writes FieldMask
// paths in lowerCamelCase, and the dry run refuses a wrong one before
// anything changes.

import { format, money, scaleMinor } from "../../core/money";
import { reactivationGuard, spendGuard, wholeUnitBudget } from "../../ads/guard";
import type { FetchLike, GadsHeaderEnv } from "../../google-ads/client";
import {
  CUSTOMER_ID_RE,
  GADS_TIMEOUT_MS,
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_ORIGIN,
  GadsRequestError,
  gadsFailure,
  gadsHeaders,
  microsToMinor,
  minorToMicros,
  readId,
  readInt64,
  searchAll,
} from "../../google-ads/client";
import { staleAdChange } from "../stale";
import { EXECUTION_SCOPE_REGISTRY } from "../scopes";
import type { ExecutionContext, ExecutionProvider } from "./fixture";

const V = GOOGLE_ADS_API_VERSION;

/** THE WRITE FENCE: the only two mutate endpoints SYB may send, and the one field each writes. */
export const GADS_MUTATE_ENDPOINTS = {
  campaigns: {
    path: new RegExp(`^/${V}/customers/\\d{10}/campaigns:mutate$`),
    field: "status",
  },
  campaignBudgets: {
    path: new RegExp(`^/${V}/customers/\\d{10}/campaignBudgets:mutate$`),
    field: "amountMicros",
  },
} as const;

export type GadsMutateEndpoint = keyof typeof GADS_MUTATE_ENDPOINTS;

/** Pure: which mutate endpoint a URL is, or null when it may not be sent. */
export function allowedMutateEndpoint(url: string): GadsMutateEndpoint | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== GOOGLE_ADS_ORIGIN || u.search !== "" || u.hash !== "" || u.username !== "") {
    return null;
  }
  for (const [id, e] of Object.entries(GADS_MUTATE_ENDPOINTS) as [
    GadsMutateEndpoint,
    (typeof GADS_MUTATE_ENDPOINTS)[GadsMutateEndpoint],
  ][]) {
    if (e.path.test(u.pathname)) return id;
  }
  return null;
}

/** Statuses SYB sets and reads as touchable. REMOVED is permanent and never touched. */
export const GADS_STATUSES: readonly string[] = ["ENABLED", "PAUSED"];
const STATUS_WORD: Readonly<Record<string, string>> = { PAUSED: "paused", ENABLED: "running" };

/** A refusal or failure, in the owner's words. `retryable` tells the engine's loop. */
export class GoogleAdChangeError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "GoogleAdChangeError";
    this.retryable = retryable;
  }
}

export const STOPPED_BEFORE_GOOGLE_CHANGE =
  "The emergency stop came on before the change was sent to Google. Nothing was changed.";

/** The live credential the backend hands over: a fresh access token, never the refresh token. */
export interface GoogleAdsCredential {
  access_token: string;
  customer_id: string;
  headers: GadsHeaderEnv;
}

/** The executor's database side, injected (lib/ads/executing.ts, dbGoogleAdsBackend). */
export interface GoogleAdsBackend {
  credential(accountId: string): Promise<GoogleAdsCredential | { refused: string }>;
  /** The undo payload the engine stored before attempt one — a budget change's baseline. */
  capturedUndo(executionId: string): Promise<unknown>;
  /** The owner's stated monthly ad ceiling (8.1i) — the same fact the generator reads. */
  ceiling(profileId: string): Promise<{ amount_minor: number; currency: string } | null>;
  /** The account's measured average day in this currency, every platform (the generator's arithmetic). */
  accountDailySpend(accountId: string, currency: string): Promise<number | null>;
  /** One watch-log line for the owner. */
  changed(profileId: string, detail: string, meta: Record<string, unknown>): Promise<void>;
}

export interface GoogleAdsExecutionOptions {
  fetch?: FetchLike;
  backend?: () => Promise<GoogleAdsBackend>;
}

interface CampaignState {
  id: string;
  name: string;
  status: string;
  currency: string;
  /** customers/{c}/campaignBudgets/{b}, or null when Google named none. */
  budget_resource: string | null;
  budget_micros: number | null;
  budget_shared: boolean;
  /** DAILY, CUSTOM_PERIOD …; null when Google didn't say. */
  budget_period: string | null;
}

const ID_RE = /^\d{1,20}$/;

function campaignIdOf(params: Record<string, unknown>): string {
  const id = params["campaign_id"];
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new GoogleAdChangeError("the ad change names no Google Ads campaign — nothing was sent");
  }
  return id;
}

function shareOf(params: Record<string, unknown>): number {
  const share = params["share"];
  if (typeof share !== "number" || !Number.isFinite(share) || share === 0) {
    throw new GoogleAdChangeError("the budget change names no amount — nothing was sent");
  }
  return share;
}

function approvedCurrency(params: Record<string, unknown>): string {
  const c = params["currency"];
  if (typeof c !== "string" || !/^[A-Za-z]{3}$/.test(c)) {
    throw new GoogleAdChangeError("the budget change names no currency — nothing was sent");
  }
  return c.toUpperCase();
}

const OPS = new Set<string>(EXECUTION_SCOPE_REGISTRY.google_ads.operations.map((o) => o.op));

const fmt = (minor: number, currency: string) => format(money(minor, currency));

function logChange(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: "google_ad_change", ...event }));
}

/** Pure: Google's campaign row into what the executor checks against. */
export function readCampaignRow(row: Record<string, unknown>): CampaignState | null {
  const c = (row["campaign"] ?? {}) as Record<string, unknown>;
  const b = (row["campaignBudget"] ?? {}) as Record<string, unknown>;
  const cu = (row["customer"] ?? {}) as Record<string, unknown>;
  const id = readId(c["id"]);
  const currency = typeof cu["currencyCode"] === "string" ? cu["currencyCode"].toUpperCase() : "";
  if (id === null || !/^[A-Z]{3}$/.test(currency)) return null;
  const resource = typeof c["campaignBudget"] === "string" ? c["campaignBudget"] : null;
  return {
    id,
    name: typeof c["name"] === "string" && c["name"] !== "" ? c["name"] : id,
    status: typeof c["status"] === "string" ? c["status"] : "UNKNOWN",
    currency,
    budget_resource:
      resource !== null && /^customers\/\d{10}\/campaignBudgets\/\d{1,20}$/.test(resource)
        ? resource
        : null,
    budget_micros: readInt64(b["amountMicros"]),
    budget_shared: b["explicitlyShared"] === true,
    budget_period: typeof b["period"] === "string" ? b["period"] : null,
  };
}

export function campaignQuery(campaignId: string): string {
  if (!ID_RE.test(campaignId)) throw new GoogleAdChangeError("that isn't a campaign id");
  return (
    "SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget, " +
    "campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period, " +
    `customer.currency_code FROM campaign WHERE campaign.id = ${campaignId}`
  );
}

export function createGoogleAdsExecution(
  options: GoogleAdsExecutionOptions = {},
): ExecutionProvider {
  const fetchImpl: FetchLike = options.fetch ?? fetch;
  const loadBackend = async (): Promise<GoogleAdsBackend> => {
    if (options.backend) return options.backend();
    // Loaded on use: lib/ads sits above lib/execution (as the Meta executor's backend does).
    const { dbGoogleAdsBackend } = await import("../../ads/executing");
    return dbGoogleAdsBackend();
  };

  interface Run {
    b: GoogleAdsBackend;
    cred: GoogleAdsCredential;
    account_id: string;
  }

  async function open(accountId: string): Promise<Run> {
    const b = await loadBackend();
    const cred = await b.credential(accountId);
    if ("refused" in cred) throw new GoogleAdChangeError(cred.refused);
    if (!CUSTOMER_ID_RE.test(cred.customer_id)) {
      throw new GoogleAdChangeError(
        "The Google Ads connection names no ad account. Reconnect it on Connections; nothing was changed.",
      );
    }
    return { b, cred, account_id: accountId };
  }

  async function readCampaign(run: Run, campaignId: string): Promise<CampaignState> {
    let rows: Record<string, unknown>[];
    try {
      rows = await searchAll(
        {
          accessToken: run.cred.access_token,
          env: run.cred.headers,
          customerId: run.cred.customer_id,
          query: campaignQuery(campaignId),
        },
        fetchImpl,
      );
    } catch (error) {
      throw asChangeError(error);
    }
    const c = rows.map(readCampaignRow).find((r) => r !== null && r.id === campaignId) ?? null;
    if (c === null) {
      throw new GoogleAdChangeError(
        `Campaign ${campaignId} isn't in the connected Google Ads account. Nothing was changed.`,
      );
    }
    return c;
  }

  function touchable(c: CampaignState): void {
    if (!GADS_STATUSES.includes(c.status)) {
      throw new GoogleAdChangeError(
        `"${c.name}" is ${c.status.toLowerCase()} on Google Ads, and ScaleX only pauses, resumes or re-budgets running and paused campaigns. Nothing was changed.`,
      );
    }
  }

  /** A budget SYB may change: its own, daily, with an amount Google reported. */
  function ownDailyBudget(c: CampaignState): { resource: string; micros: number } {
    if (c.budget_resource === null || c.budget_micros === null) {
      throw new GoogleAdChangeError(
        `"${c.name}" has no budget Google reported. Nothing was changed.`,
      );
    }
    if (c.budget_shared) {
      throw new GoogleAdChangeError(
        `"${c.name}" shares its budget with other campaigns, so changing it would change them too. Nothing was changed.`,
      );
    }
    if (c.budget_period !== null && c.budget_period !== "DAILY") {
      throw new GoogleAdChangeError(
        `"${c.name}" has a ${c.budget_period.toLowerCase().replace(/_/g, " ")} budget, not a daily one, so ScaleX won't change it. Nothing was changed.`,
      );
    }
    return { resource: c.budget_resource, micros: c.budget_micros };
  }

  /** P3-22c inside the executor: ±50% of the baseline and the stated ceiling. Throws the refusal. */
  async function guardedBudget(
    run: Run,
    args: {
      profile_id: string;
      c: CampaignState;
      baseline_minor: number;
      share: number;
      currency: string;
    },
  ): Promise<{ micros: number; sent_minor: number }> {
    if (args.c.currency !== args.currency) {
      throw new GoogleAdChangeError(
        `You approved this change in ${args.currency}, but the Google Ads account operates in ${args.c.currency}. Nothing was changed; it needs approving again.`,
      );
    }
    // Whole forints (and other whole-unit currencies) as Meta and TikTok
    // take them, rounded toward today's budget so ±50% still holds.
    const sent_minor = wholeUnitBudget(
      args.baseline_minor + scaleMinor(args.baseline_minor, args.share),
      args.currency,
      args.baseline_minor,
    );
    const ceiling = await run.b.ceiling(args.profile_id);
    const accountDaily = ceiling
      ? await run.b.accountDailySpend(run.account_id, args.currency)
      : null;
    const refusal = spendGuard({
      current_daily_minor: args.baseline_minor,
      proposed_daily_minor: sent_minor,
      currency: args.currency,
      ...(accountDaily !== null ? { account_daily_minor: accountDaily } : {}),
      monthly_ceiling: ceiling,
    });
    if (refusal !== null) {
      throw new GoogleAdChangeError(
        `I didn't change "${args.c.name}": ${refusal}. Nothing was changed.`,
      );
    }
    if (sent_minor <= 0) {
      throw new GoogleAdChangeError(
        `I won't set "${args.c.name}"'s budget to nothing. Nothing was changed.`,
      );
    }
    return { micros: minorToMicros(sent_minor, args.currency), sent_minor };
  }

  /** Re-activating spend: only the owner's stated ceiling bounds it. */
  async function reactivation(run: Run, profileId: string, c: CampaignState): Promise<void> {
    const ceiling = await run.b.ceiling(profileId);
    if (ceiling === null) return;
    const refusal = reactivationGuard({
      campaign_daily_minor:
        c.budget_micros === null ? null : microsToMinor(c.budget_micros, c.currency),
      account_daily_minor: await run.b.accountDailySpend(run.account_id, c.currency),
      currency: c.currency,
      monthly_ceiling: ceiling,
    });
    if (refusal !== null) {
      throw new GoogleAdChangeError(
        `I didn't let "${c.name}" run again: ${refusal}. Nothing was changed.`,
      );
    }
  }

  /** One mutate, through the write fence. Dry run (validateOnly) first, the stop, then the change. */
  async function mutate(
    run: Run,
    which: GadsMutateEndpoint,
    update: { resourceName: string; status?: string; amountMicros?: string },
    halted: (() => Promise<boolean>) | undefined,
  ): Promise<void> {
    const url = `${GOOGLE_ADS_ORIGIN}/${V}/customers/${run.cred.customer_id}/${which}:mutate`;
    if (allowedMutateEndpoint(url) !== which) {
      throw new GoogleAdChangeError(
        "refusing a change that isn't on ScaleX's list — nothing was sent",
      );
    }
    const field = GADS_MUTATE_ENDPOINTS[which].field;
    const keys = Object.keys(update).filter((k) => k !== "resourceName");
    if (keys.length !== 1 || keys[0] !== field) {
      throw new GoogleAdChangeError(
        "refusing a change to a field ScaleX doesn't write — nothing was sent",
      );
    }
    const operations = [{ updateMask: field, update }];
    const send = async (validateOnly: boolean): Promise<unknown> => {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: gadsHeaders(run.cred.access_token, run.cred.headers),
          body: JSON.stringify(validateOnly ? { operations, validateOnly: true } : { operations }),
          redirect: "error",
          signal: AbortSignal.timeout(GADS_TIMEOUT_MS),
        });
      } catch {
        // Setting a status or a budget twice is harmless: the engine may try again.
        throw new GoogleAdChangeError(
          "Google didn't answer. Nothing is known to have changed.",
          true,
        );
      }
      const body = (await res.json().catch(() => null)) as unknown;
      if (!res.ok) throw asChangeError(gadsFailure(res.status, body), validateOnly);
      return body;
    };
    await send(true);
    if (halted && (await halted())) throw new GoogleAdChangeError(STOPPED_BEFORE_GOOGLE_CHANGE);
    const body = (await send(false)) as { results?: unknown } | null;
    const first = Array.isArray(body?.results)
      ? (body.results[0] as { resourceName?: unknown })
      : null;
    if (first?.resourceName !== update.resourceName) {
      throw new GoogleAdChangeError("Google didn't confirm the change — I'll check again.", true);
    }
  }

  return {
    id: "google_ads",
    external: true,

    async staleApproval(op, _params, pctx, approval) {
      const sentence = staleAdChange(approval, approval.now);
      if (sentence !== null) {
        logChange({ account_id: pctx.account_id, op, phase: "stale", outcome: "lapsed" });
      }
      return sentence;
    },

    async preflight(op, params, pctx) {
      if (!OPS.has(op))
        return { code: "refused", message: `"${op}" is not a change ScaleX makes on Google Ads` };
      try {
        const run = await open(pctx.account_id);
        const c = await readCampaign(run, campaignIdOf(params));
        touchable(c);
        if (op === "resume_campaign") await reactivation(run, pctx.profile_id, c);
        if (op === "set_daily_budget") {
          const own = ownDailyBudget(c);
          await guardedBudget(run, {
            profile_id: pctx.profile_id,
            c,
            baseline_minor: microsToMinor(own.micros, c.currency),
            share: shareOf(params),
            currency: approvedCurrency(params),
          });
        }
        logChange({ account_id: pctx.account_id, op, phase: "preflight", outcome: "ok" });
        return null;
      } catch (error) {
        logChange({ account_id: pctx.account_id, op, phase: "preflight", outcome: "refused" });
        return { code: "refused", message: error instanceof Error ? error.message : String(error) };
      }
    },

    async captureUndo(op, params, pctx) {
      if (!OPS.has(op)) return null;
      const run = await open(pctx.account_id);
      const c = await readCampaign(run, campaignIdOf(params));
      touchable(c);
      if (op === "set_daily_budget") {
        const own = ownDailyBudget(c);
        return {
          campaign_id: c.id,
          campaign_name: c.name,
          budget_resource: own.resource,
          amount_micros: own.micros,
          daily_budget_minor: microsToMinor(own.micros, c.currency),
          currency: c.currency,
        };
      }
      return { campaign_id: c.id, campaign_name: c.name, status: c.status };
    },

    async execute(op, params, pctx: ExecutionContext) {
      if (!OPS.has(op))
        throw new GoogleAdChangeError(`"${op}" is not a change ScaleX makes on Google Ads`);
      const run = await open(pctx.account_id);
      const c = await readCampaign(run, campaignIdOf(params));
      touchable(c);
      if (op === "pause_campaign" || op === "resume_campaign") {
        const target = op === "pause_campaign" ? "PAUSED" : "ENABLED";
        if (target === "ENABLED" && c.status !== "ENABLED")
          await reactivation(run, pctx.profile_id, c);
        // Already there: an earlier attempt landed and its answer was lost. Setting it twice is harmless.
        if (c.status !== target) {
          await mutate(
            run,
            "campaigns",
            { resourceName: `customers/${run.cred.customer_id}/campaigns/${c.id}`, status: target },
            pctx.halted,
          );
        }
        await run.b.changed(
          pctx.profile_id,
          `${target === "PAUSED" ? "Paused" : "Resumed"} "${c.name}" on Google Ads.`,
          { campaign_id: c.id, op, platform: "google" },
        );
        logChange({ account_id: pctx.account_id, op, phase: "execute", outcome: "changed" });
        return {
          campaign_id: c.id,
          campaign_name: c.name,
          status: target,
          previous_status: c.status === target ? null : c.status,
        };
      }
      // set_daily_budget — from the budget captured before attempt one, never the live one.
      const captured = (pctx.execution_id ? await run.b.capturedUndo(pctx.execution_id) : null) as {
        daily_budget_minor?: unknown;
        currency?: unknown;
        budget_resource?: unknown;
      } | null;
      const baseline = captured?.daily_budget_minor;
      if (typeof baseline !== "number" || typeof captured?.currency !== "string") {
        throw new GoogleAdChangeError(
          "The budget before this change wasn't recorded, so I won't change it. Nothing was changed.",
        );
      }
      const own = ownDailyBudget(c);
      if (captured.budget_resource !== own.resource) {
        throw new GoogleAdChangeError(
          `"${c.name}" moved to another budget since this was approved. Nothing was changed; it needs approving again.`,
        );
      }
      const { micros, sent_minor } = await guardedBudget(run, {
        profile_id: pctx.profile_id,
        c,
        baseline_minor: baseline,
        share: shareOf(params),
        currency: approvedCurrency(params),
      });
      if (own.micros !== micros) {
        await mutate(
          run,
          "campaignBudgets",
          { resourceName: own.resource, amountMicros: String(micros) },
          pctx.halted,
        );
      }
      await run.b.changed(
        pctx.profile_id,
        `Changed "${c.name}"'s daily budget on Google Ads from ${fmt(baseline, c.currency)} to ${fmt(sent_minor, c.currency)}.`,
        { campaign_id: c.id, op, platform: "google" },
      );
      logChange({ account_id: pctx.account_id, op, phase: "execute", outcome: "changed" });
      return {
        campaign_id: c.id,
        campaign_name: c.name,
        daily_budget_before_minor: baseline,
        daily_budget_minor: sent_minor,
        currency: c.currency,
        sent_amount_micros: micros,
      };
    },

    undoRaisesSpend(op, undoPayload, result) {
      // Pure. Undoing a pause runs the campaign again; undoing a resume stops it.
      if (op === "pause_campaign") return true;
      if (op === "resume_campaign") return false;
      if (op !== "set_daily_budget") return false;
      const previous = readInt64(
        (undoPayload as { amount_micros?: unknown } | null)?.amount_micros,
      );
      const sent = readInt64(
        (result as { sent_amount_micros?: unknown } | null)?.sent_amount_micros,
      );
      // Not knowable from the record: treated as raising, so the gate and the guards apply.
      if (previous === null || sent === null) return true;
      return previous > sent;
    },

    async undo(op, undoPayload, pctx) {
      const u = (undoPayload ?? {}) as {
        campaign_id?: unknown;
        status?: unknown;
        budget_resource?: unknown;
        amount_micros?: unknown;
        daily_budget_minor?: unknown;
        currency?: unknown;
      };
      const done = (pctx.result ?? {}) as { status?: unknown; sent_amount_micros?: unknown };
      const run = await open(pctx.account_id);
      const c = await readCampaign(run, campaignIdOf({ campaign_id: u.campaign_id }));
      touchable(c);
      // An undo puts back what SYB changed — only while the live value is still
      // what this execution set. If the owner has changed it since, theirs stands.
      const changedSince = (now: string, set: string) =>
        new GoogleAdChangeError(
          `I didn't undo this: "${c.name}" is ${now} on Google Ads now, not the ${set} I set — you've changed it since, and I won't override that. Nothing was changed.`,
        );
      if (op === "pause_campaign" || op === "resume_campaign") {
        if (typeof u.status !== "string" || !GADS_STATUSES.includes(u.status)) {
          throw new GoogleAdChangeError(
            "the stored undo names no status ScaleX may set — nothing was changed",
          );
        }
        if (c.status !== u.status) {
          const set = typeof done.status === "string" ? done.status : null;
          if (set === null || c.status !== set) {
            throw changedSince(
              STATUS_WORD[c.status] ?? c.status.toLowerCase(),
              set === null ? "status" : `${STATUS_WORD[set] ?? set} status`,
            );
          }
          if (u.status === "ENABLED") await reactivation(run, pctx.profile_id, c);
          await mutate(
            run,
            "campaigns",
            {
              resourceName: `customers/${run.cred.customer_id}/campaigns/${c.id}`,
              status: u.status,
            },
            undefined,
          );
        }
        await run.b.changed(
          pctx.profile_id,
          `Undid: "${c.name}" is ${STATUS_WORD[u.status] ?? u.status} on Google Ads again.`,
          { campaign_id: c.id, op, undo: true, platform: "google" },
        );
        logChange({ account_id: pctx.account_id, op, phase: "undo", outcome: "restored" });
        return { campaign_id: c.id, status: u.status };
      }
      if (op === "set_daily_budget") {
        const previous = readInt64(u.amount_micros);
        if (
          previous === null ||
          typeof u.currency !== "string" ||
          typeof u.budget_resource !== "string"
        ) {
          throw new GoogleAdChangeError("the stored undo names no budget — nothing was changed");
        }
        const cur = u.currency;
        const own = ownDailyBudget(c);
        if (own.resource !== u.budget_resource) {
          throw changedSince("on another budget", "budget");
        }
        if (own.micros !== previous) {
          const sent = readInt64(done.sent_amount_micros);
          if (sent === null || own.micros !== sent) {
            throw changedSince(
              `at ${fmt(microsToMinor(own.micros, cur), cur)} a day`,
              sent === null ? "budget" : `${fmt(microsToMinor(sent, cur), cur)} budget`,
            );
          }
          if (previous > sent) {
            // Putting a lowered budget back up raises spend: the same guard as any raise.
            const ceiling = await run.b.ceiling(pctx.profile_id);
            const accountDaily = ceiling
              ? await run.b.accountDailySpend(run.account_id, cur)
              : null;
            const refusal = spendGuard({
              current_daily_minor: microsToMinor(sent, cur),
              proposed_daily_minor: microsToMinor(previous, cur),
              currency: cur,
              ...(accountDaily !== null ? { account_daily_minor: accountDaily } : {}),
              monthly_ceiling: ceiling,
            });
            if (refusal !== null) {
              throw new GoogleAdChangeError(
                `I didn't undo the change to "${c.name}": ${refusal}. Nothing was changed.`,
              );
            }
          }
          await mutate(
            run,
            "campaignBudgets",
            { resourceName: own.resource, amountMicros: String(previous) },
            undefined,
          );
        }
        await run.b.changed(
          pctx.profile_id,
          `Undid: "${c.name}"'s daily budget on Google Ads is ${fmt(microsToMinor(previous, cur), cur)} again.`,
          { campaign_id: c.id, op, undo: true, platform: "google" },
        );
        logChange({ account_id: pctx.account_id, op, phase: "undo", outcome: "restored" });
        return { campaign_id: c.id, amount_micros: previous };
      }
      throw new GoogleAdChangeError(`"${op}" can't be undone`);
    },
  };
}

/** A Google refusal as the engine and the owner see it. Quota and outages may be tried again. */
function asChangeError(error: unknown, dryRun = false): Error {
  if (error instanceof GoogleAdChangeError) return error;
  if (error instanceof GadsRequestError) {
    const retry = error.kind === "quota" || error.kind === "unavailable";
    const lead = dryRun ? "Google's dry run refused the change" : "Google refused the change";
    return new GoogleAdChangeError(
      `${lead}: ${error.message}${retry ? "" : " Nothing was changed."}`,
      retry,
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

export const googleAdsExecutor = createGoogleAdsExecution();
