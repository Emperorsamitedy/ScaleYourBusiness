// The uniform connector contract — the v1 build spec §11.1 (P7-30).
//
//   Connector {
//     authorize() -> AuthResult
//     health() -> { status, last_success_at, latency_ms, scopes_held, scopes_needed }
//     pull(since) -> NormalisedEvent[]
//     push(action) -> ActionResult      // omitted for read-only connectors
//     capabilities() -> Capability[]
//     cost_model() -> { per_call, quota, reset_at }
//   }
//
// Every measuring connector already implements the Phase 2 Provider
// (./provider.ts): connect, pull pages of daily observations, list items.
// fromProvider wraps one in this contract without changing it, and the
// bank-statement parser (lib/balance/import.ts) gets the same face through
// bankStatementConnector. Both hand back NormalisedEvents: one schema, with
// the §6.1 grade attached at the boundary, so the diagnosis, the ledger and
// the ladder never learn whether revenue came from Stripe, Shopify, Square
// or a parsed statement (§11.1). A structure test keeps provider modules
// out of those three (contract.test.ts).
//
// push() is absent on every connector here: measuring connectors are
// read-only forever (rule 9). The execution side keeps its own engine,
// which is where ComplianceGate and the ladder sit (§9.5).

import { createHash } from "node:crypto";
import type { BalanceImportOptions } from "../balance/import";
import { BalanceImportError, statementBalances } from "../balance/import";
import { BALANCE_METRIC, MONEY_IN_METRIC } from "../balance/source";
import type { Grade } from "../core/grade";
import { provenanceGrade } from "../core/grade";
import type { Money } from "../core/money";
import { money } from "../core/money";
import type { MetricKey, Observation, ObservationDimensions, Provider } from "./provider";
import { MONEY_METRICS, ProviderError } from "./provider";
import type { ProviderId } from "./scopes";
import { SCOPE_GUIDE, SCOPE_REGISTRY, ScopeViolationError, verifyGrantedScopes } from "./scopes";

// ── The contract ─────────────────────────────────────────────────────────

export type AuthResult = { ok: true; scopes_held: string[] } | { ok: false; reason: string };

export type HealthStatus = "healthy" | "degraded" | "failed" | "not_connected";

export interface ConnectorHealth {
  status: HealthStatus;
  last_success_at: string | null;
  latency_ms: number | null;
  scopes_held: string[];
  scopes_needed: string[];
}

/** What a connector can do: read one metric, or (execution side only) write. */
export type Capability = { kind: "read"; metric: MetricKey } | { kind: "write"; action: string };

export interface CostModel {
  /** What one call costs SYB, in money (rule 1). Zero for APIs that are free to read. */
  per_call: Money;
  /** Calls allowed per window, when the provider states one we rely on; null when not. */
  quota: number | null;
  /** When the quota resets, ISO; null when it isn't a fixed reset. */
  reset_at: string | null;
}

/** One measured event, in the one internal schema (§11.1). */
export interface NormalisedEvent {
  /** Deterministic: the same reading always has the same id, so a re-pull is idempotent. */
  id: string;
  metric: MetricKey;
  /** "YYYY-MM-DD" — the day the event is about. */
  day: string;
  dimensions: ObservationDimensions;
  /** Money metrics: integer minor units + currency (rule 1). Otherwise null. */
  amount: Money | null;
  /** Count and ratio metrics. Otherwise null. */
  quantity: number | null;
  observed_at: string;
  /** §6.1: measured from one connected system — B. A cross-check upgrades a FIGURE, never an event. */
  grade: Grade;
  source: "measured";
  /** Plain words for the provenance record: "Stripe, 2026-10-03". */
  source_detail: string;
}

export interface ActionResult {
  ok: boolean;
  detail: string;
}

export interface Connector {
  id: string;
  label: string;
  authorize(): Promise<AuthResult>;
  health(): Promise<ConnectorHealth>;
  pull(since: string): Promise<NormalisedEvent[]>;
  push?(action: unknown): Promise<ActionResult>;
  capabilities(): Capability[];
  cost_model(): CostModel;
}

/**
 * Which side of the business a metric is on (the multi-market spec §E.3):
 * money in, money out, or neither. The diagnosis reads sides, never sources.
 */
export function sideOf(metric: MetricKey): "revenue" | "cost" | "other" {
  switch (metric) {
    case "revenue.daily":
    case "revenue.hourly":
    case "booking_revenue.daily":
      return "revenue";
    case "purchases.daily":
    case "ad_spend.daily":
    case "ad_spend.campaign.daily":
      return "cost";
    default:
      return "other";
  }
}

// ── Data: what each connector reads and costs ─────────────────────────────

/**
 * The metrics each provider emits, as data. connector-contract.test checks
 * these against what the providers actually emit in their own suites'
 * fixtures, so the declaration can't drift from the code silently.
 */
export const CONNECTOR_READS: Readonly<Record<ProviderId, readonly MetricKey[]>> = {
  fixture: ["revenue.daily", "orders.daily", "ad_spend.daily"],
  stripe: ["revenue.daily", "orders.daily", "revenue.hourly", "orders.hourly"],
  shopify: [
    "revenue.daily",
    "orders.daily",
    "units.daily",
    "revenue.hourly",
    "orders.hourly",
    "stock.on_hand",
    "stock.value_at_cost",
    "stock.value_at_price",
    "stock.unit_cost",
  ],
  woocommerce: [
    "revenue.daily",
    "orders.daily",
    "units.daily",
    "stock.on_hand",
    "stock.value_at_price",
  ],
  ga4: [
    "sessions.daily",
    "sessions.hourly",
    "landing_sessions.daily",
    "landing_bounces.daily",
    "site_search.daily",
  ],
  meta_ads: [
    "ad_spend.daily",
    "ad_purchases.daily",
    "ad_spend.campaign.daily",
    "ad_purchase_value.campaign.daily",
  ],
  search_console: [
    "search_impressions.daily",
    "search_clicks.daily",
    "search_position_weighted.daily",
  ],
  square: [
    "revenue.daily",
    "orders.daily",
    "revenue.hourly",
    "orders.hourly",
    "appointments_completed.daily",
    "appointments_no_show.daily",
    "appointments_cancelled.daily",
    "booking_revenue.daily",
  ],
};

const FREE = money(0, "EUR");

/**
 * Every provider here is free to read; none publishes a fixed quota with a
 * reset SYB depends on (each paces itself and retries with a hard cap), so
 * quota and reset_at are null rather than a number we'd have to invent.
 */
export const CONNECTOR_COSTS: Readonly<Record<ProviderId, CostModel>> = Object.fromEntries(
  (Object.keys(SCOPE_REGISTRY) as ProviderId[]).map((id) => [
    id,
    { per_call: FREE, quota: null, reset_at: null },
  ]),
) as Record<ProviderId, CostModel>;

/** The registry's scopes a provider can't work without: those the guide doesn't call optional. */
export function scopesNeeded(provider: ProviderId): string[] {
  return SCOPE_GUIDE[provider].filter((g) => !/\(optional/i.test(g.grant)).map((g) => g.scope);
}

// ── Normalising ───────────────────────────────────────────────────────────

const MEASURED: Grade = provenanceGrade({ source: "measured" });

function eventId(connector: string, o: Observation): string {
  const dims = Object.keys(o.dimensions)
    .sort()
    .map((k) => `${k}=${(o.dimensions as Record<string, string>)[k]}`)
    .join("&");
  return createHash("sha256")
    .update(`${connector}|${o.metric_key}|${o.period_date}|${dims}`)
    .digest("hex")
    .slice(0, 32);
}

/** One provider observation → one normalised event, graded at the boundary. */
export function normalise(connector: string, label: string, o: Observation): NormalisedEvent {
  const isMoney = MONEY_METRICS.has(o.metric_key);
  if (isMoney && (o.value_minor === undefined || o.dimensions.currency === undefined)) {
    throw new ProviderError(`${label} sent ${o.metric_key} without an amount and currency`);
  }
  return {
    id: eventId(connector, o),
    metric: o.metric_key,
    day: o.period_date,
    dimensions: o.dimensions,
    amount: isMoney ? money(o.value_minor!, o.dimensions.currency!) : null,
    quantity: isMoney ? null : (o.value_num ?? null),
    observed_at: o.observed_at,
    grade: MEASURED,
    source: "measured",
    source_detail: `${label}, ${o.period_date}`,
  };
}

// ── A Phase 2 provider, wrapped ───────────────────────────────────────────

/** A hard cap on pages per pull (CLAUDE.md: every loop over a provider is capped). */
export const MAX_CONTRACT_PAGES = 500;

export interface ProviderConnectorOptions {
  /** The decrypted credential. Never logged, never in an error. */
  secret: string;
  /** The stored connection, when there is one: its health comes from here. */
  connection?: {
    status: string;
    granted_scopes: readonly string[];
    last_sync_at: string | null;
    failure_count: number;
  };
  now?: () => Date;
}

export function fromProvider(provider: Provider, options: ProviderConnectorOptions): Connector {
  const now = options.now ?? (() => new Date());
  let latency: number | null = null;
  let lastSuccess: string | null = options.connection?.last_sync_at ?? null;
  let lastFailed = false;
  let held: string[] = [...(options.connection?.granted_scopes ?? [])];

  async function timed<T>(work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const out = await work();
      lastSuccess = now().toISOString();
      lastFailed = false;
      return out;
    } catch (error) {
      lastFailed = true;
      throw error;
    } finally {
      latency = Date.now() - started;
    }
  }

  return {
    id: provider.id,
    label: provider.label,

    async authorize() {
      try {
        const { granted_scopes } = await timed(() => provider.connect(options.secret));
        verifyGrantedScopes(provider.id, granted_scopes);
        held = [...granted_scopes];
        return { ok: true, scopes_held: held };
      } catch (error) {
        if (error instanceof ProviderError || error instanceof ScopeViolationError) {
          return { ok: false, reason: error.message };
        }
        return { ok: false, reason: `${provider.label} couldn't be reached — try again shortly` };
      }
    },

    async health() {
      const c = options.connection;
      const needed = scopesNeeded(provider.id);
      const missing = needed.some((s) => !held.includes(s));
      let status: HealthStatus;
      if (c && c.status === "disconnected") status = "not_connected";
      else if (c && c.status === "failed") status = "failed";
      else if (lastFailed || missing || (c !== undefined && c.failure_count > 0))
        status = "degraded";
      else status = "healthy";
      return {
        status,
        last_success_at: lastSuccess,
        latency_ms: latency,
        scopes_held: held,
        scopes_needed: needed,
      };
    },

    async pull(since) {
      const events: NormalisedEvent[] = [];
      let cursor: string | null = null;
      const at = now();
      for (let page = 0; page < MAX_CONTRACT_PAGES; page++) {
        const result = await timed(() =>
          provider.pull(options.secret, cursor, at, { granted_scopes: held }),
        );
        for (const o of result.observations) {
          if (o.period_date >= since) events.push(normalise(provider.id, provider.label, o));
        }
        cursor = result.cursor;
        if (result.done) return events;
      }
      throw new ProviderError(`${provider.label} had more to read than one pull takes`);
    },

    capabilities() {
      return CONNECTOR_READS[provider.id].map((metric) => ({ kind: "read", metric }));
    },

    cost_model() {
      return CONNECTOR_COSTS[provider.id];
    },
  };
}

// ── A bank statement, parsed ──────────────────────────────────────────────

export const BANK_STATEMENT_CONNECTOR = "bank_statement";

/**
 * The bank-statement parser behind the same contract (§11.3: Stripe + bank
 * statement parsing are v1's revenue-side connectors). It reads what
 * lib/balance/import reads — each day's closing balance — and nothing more;
 * no bank is connected and nothing can be pushed. A file that doesn't parse
 * cleanly fails authorize() and reports itself failed, in plain words.
 */
export function bankStatementConnector(
  csv: string,
  options: Omit<BalanceImportOptions, "now"> & { now?: () => Date },
): Connector {
  const now = options.now ?? (() => new Date());
  const label = "Bank statement";

  function parse() {
    const { now: _clock, ...rest } = options;
    void _clock;
    return statementBalances(csv, { ...rest, today: now().toISOString().slice(0, 10) });
  }

  return {
    id: BANK_STATEMENT_CONNECTOR,
    label,

    async authorize() {
      try {
        parse();
        return { ok: true, scopes_held: [] };
      } catch (error) {
        if (error instanceof BalanceImportError) return { ok: false, reason: error.message };
        throw error;
      }
    },

    async health() {
      let status: HealthStatus = "healthy";
      let through: string | null = null;
      try {
        through = parse().through;
      } catch (error) {
        if (!(error instanceof BalanceImportError)) throw error;
        status = "failed";
      }
      return {
        status,
        last_success_at: through === null ? null : `${through}T23:59:59.000Z`,
        latency_ms: null,
        scopes_held: [],
        scopes_needed: [],
      };
    },

    async pull(since) {
      const parsed = parse();
      const currency = options.currency.trim().toUpperCase();
      const observedAt = now().toISOString();
      const detail = `${label}, ${parsed.from} to ${parsed.through}`;
      const events = (
        metric: typeof BALANCE_METRIC | typeof MONEY_IN_METRIC,
        days: Map<string, number>,
      ) =>
        [...days.entries()]
          .filter(([day]) => day >= since)
          .map(([day, minor]) => ({
            ...normalise(BANK_STATEMENT_CONNECTOR, label, {
              metric_key: metric,
              period_date: day,
              dimensions: { currency },
              value_minor: minor,
              observed_at: observedAt,
            }),
            source_detail: detail,
          }));
      // D52: the money in beside the balances, when the file has a money-in column.
      return [
        ...events(BALANCE_METRIC, parsed.closing),
        ...events(MONEY_IN_METRIC, parsed.moneyIn),
      ];
    },

    capabilities() {
      return [
        { kind: "read", metric: BALANCE_METRIC },
        { kind: "read", metric: MONEY_IN_METRIC },
      ];
    },

    cost_model() {
      return { per_call: FREE, quota: null, reset_at: null };
    },
  };
}
