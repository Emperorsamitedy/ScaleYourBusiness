// The nine validation rules — data-model-v1.md §7, P0-79 (steps 32-33).
//
// Declarative and versioned (P0-78): each rule names its kind, severity,
// and the field-key prefixes that trigger re-evaluation. Everything here
// is arithmetic over the current profile — never an LLM call (CLAUDE.md
// cost discipline: condition evaluation is deterministic code).
//
// A rule that cannot see all of its inputs does not fire. Missing data
// is the completeness scorer's finding, not a contradiction — except for
// the four "gap" rules, whose whole point is a dangerous absence next to
// a recorded presence.

import { perUnit, ratioBp, scaleMinor } from "../core/money";
import { presentAmount } from "../i18n/format";

export const RULES_VERSION = "1.0.0";

export type FindingKind = "gap" | "contradiction" | "implausible" | "stale";
export type FindingSeverity = "blocking" | "high" | "medium" | "low";

export interface RuleFiring {
  /** Stable identities of the fields involved (record ids churn). */
  field_keys: string[];
  /** message.en — both statements, factual; the panel adds the tone. */
  message: string;
  /**
   * L-4a: the figures in the message, unformatted (money as integer minor
   * units with its currency), stored beside the English as message.args so
   * the reader's language can say it again (lib/validation/words).
   */
  args?: Record<string, number | MoneyValue>;
}

export interface RuleContext {
  /** Value of the current record for a key, only if status "answered". */
  scalar(key: string): Promise<unknown>;
  /** observed_at of the current answered record for a key, if any. */
  observedAt(key: string): Promise<string | null>;
  /** Per-entity sub-values: entityId → subKey → value ("offers", "costs", …). */
  entities(spine: string): Promise<Map<string, Record<string, unknown>>>;
  /** Spine-table row count for an entity type. */
  entityCount(spine: "offers" | "suppliers"): Promise<number>;
  now(): Date;
}

export interface ValidationRule {
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  /** Re-evaluate when a written field_key starts with any of these. */
  triggers: string[];
  evaluate(ctx: RuleContext): Promise<RuleFiring | null>;
}

/* ---------- value coercions (wire shapes per lib/core) ---------- */

interface MoneyValue {
  amount_minor: number;
  currency: string;
}

function asMoney(v: unknown): MoneyValue | null {
  if (v === null || typeof v !== "object") return null;
  const m = v as { amount_minor?: unknown; currency?: unknown };
  return typeof m.amount_minor === "number" && typeof m.currency === "string"
    ? { amount_minor: m.amount_minor, currency: m.currency }
    : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asCode(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && typeof (v as { code?: unknown }).code === "string") {
    return (v as { code: string }).code;
  }
  return null;
}

function asBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function fmtMoney(m: MoneyValue): string {
  // Whole major units from the integer's digits, by the currency table (hard rule 1).
  return `${presentAmount(m, "en", { whole: true })} ${m.currency}`;
}

/** Offer margin in percentage points, when both sides are priceable. */
function offerMarginPct(row: Record<string, unknown>): number | null {
  const price = asMoney(row["price"]);
  const cost = asMoney(row["cost_to_deliver"]);
  if (!price || !cost) return null;
  if (price.currency !== cost.currency || price.amount_minor <= 0) return null;
  const marginBp = ratioBp(price.amount_minor - cost.amount_minor, price.amount_minor);
  return marginBp / 100; // percentage points, from exact basis points
}

/** Normalize a cost row to monthly minor units; null when not normalizable. */
function monthlyCostMinor(row: Record<string, unknown>): number | null {
  const amount = asMoney(row["amount"]);
  if (!amount) return null;
  switch (asCode(row["cadence"])) {
    case "monthly":
      return amount.amount_minor;
    case "quarterly":
      return perUnit(amount.amount_minor, 3);
    case "annual":
      return perUnit(amount.amount_minor, 12);
    default:
      return null; // per_unit / per_job depend on volume — not comparable
  }
}

/* ---------- the nine rules ---------- */

export const RULES: readonly ValidationRule[] = [
  {
    id: "margin_mismatch",
    kind: "contradiction",
    severity: "high",
    triggers: ["costs.gross_margin", "offers."],
    async evaluate(ctx) {
      const stated = asNumber(await ctx.scalar("costs.gross_margin"));
      if (stated === null) return null;
      const offers = await ctx.entities("offers");
      const margins: number[] = [];
      for (const row of offers.values()) {
        const m = offerMarginPct(row);
        if (m !== null) margins.push(m);
      }
      if (margins.length === 0) return null;
      const computed = margins.reduce((a, b) => a + b, 0) / margins.length;
      if (Math.abs(stated - computed) <= 10) return null;
      return {
        field_keys: ["costs.gross_margin", "offers"],
        message: `You told me your gross margin is about ${Math.round(stated)}%. Your offer prices and costs work out to about ${Math.round(computed)}%.`,
        args: { stated: Math.round(stated), computed: Math.round(computed) },
      };
    },
  },
  {
    id: "revenue_vs_offers",
    kind: "contradiction",
    severity: "high",
    triggers: ["revenue.monthly_revenue", "offers."],
    async evaluate(ctx) {
      const stated = asMoney(await ctx.scalar("revenue.monthly_revenue"));
      if (!stated || stated.amount_minor <= 0) return null;
      const offers = await ctx.entities("offers");
      let sum = 0;
      let counted = 0;
      for (const row of offers.values()) {
        const price = asMoney(row["price"]);
        const volume = asNumber(row["volume_period"]);
        if (!price || volume === null) continue;
        if (price.currency !== stated.currency) return null; // not comparable
        sum += scaleMinor(price.amount_minor, volume);
        counted += 1;
      }
      if (counted === 0) return null;
      // Within 20% of the statement, compared in integers (basis points).
      if (Math.abs(sum - stated.amount_minor) * 10_000 <= 2_000 * stated.amount_minor) return null;
      return {
        field_keys: ["revenue.monthly_revenue", "offers"],
        message: `You told me revenue is about ${fmtMoney(stated)} a month. Your offers' prices times volumes add up to about ${fmtMoney({ amount_minor: sum, currency: stated.currency })}.`,
        args: { stated, sum: { amount_minor: sum, currency: stated.currency } },
      };
    },
  },
  {
    id: "costs_exceed_revenue",
    kind: "implausible",
    severity: "high",
    triggers: ["costs.", "revenue.monthly_revenue", "revenue.trend"],
    async evaluate(ctx) {
      const revenue = asMoney(await ctx.scalar("revenue.monthly_revenue"));
      const trend = asCode(await ctx.scalar("revenue.trend"));
      if (!revenue || trend !== "growing") return null;
      const costs = await ctx.entities("costs");
      let total = 0;
      let counted = 0;
      for (const row of costs.values()) {
        const monthly = monthlyCostMinor(row);
        const amount = asMoney(row["amount"]);
        if (monthly === null || !amount) continue;
        if (amount.currency !== revenue.currency) return null; // not comparable
        total += monthly;
        counted += 1;
      }
      if (counted === 0 || total <= revenue.amount_minor) return null;
      return {
        field_keys: ["costs", "revenue.monthly_revenue", "revenue.trend"],
        message: `Your monthly costs add up to about ${fmtMoney({ amount_minor: total, currency: revenue.currency })}, more than the ${fmtMoney(revenue)} coming in — while revenue is marked as growing.`,
        args: { total: { amount_minor: total, currency: revenue.currency }, revenue },
      };
    },
  },
  {
    id: "inventory_without_supplier",
    kind: "gap",
    severity: "medium",
    triggers: ["offers.physical.holds_inventory", "suppliers"],
    async evaluate(ctx) {
      const holds = asCode(await ctx.scalar("offers.physical.holds_inventory"));
      if (holds !== "yes" && holds !== "partly") return null;
      if ((await ctx.entityCount("suppliers")) > 0) return null;
      return {
        field_keys: ["offers.physical.holds_inventory", "suppliers"],
        message: "Your products hold inventory, but I have no supplier recorded yet.",
      };
    },
  },
  {
    id: "channel_without_revenue",
    kind: "gap",
    severity: "medium",
    triggers: ["channels."],
    async evaluate(ctx) {
      const primary = await ctx.scalar("channels.primary_id");
      if (primary === null || primary === undefined) return null;
      const channels = await ctx.entities("channels");
      for (const row of channels.values()) {
        if (asMoney(row["revenue_monthly"])) return null;
      }
      return {
        field_keys: ["channels.primary_id", "channels"],
        message: "You marked a primary sales channel, but it has no revenue figure yet.",
      };
    },
  },
  {
    id: "key_person_undocumented",
    kind: "gap",
    severity: "high",
    triggers: ["service.key_person_dependency", "operations.has_sops"],
    async evaluate(ctx) {
      const dependency = asCode(await ctx.scalar("service.key_person_dependency"));
      const sops = asBool(await ctx.scalar("operations.has_sops"));
      if (dependency !== "hard" && dependency !== "single_point_of_failure") return null;
      if (sops !== false) return null;
      return {
        field_keys: ["service.key_person_dependency", "operations.has_sops"],
        message: "The service depends heavily on one person, and no written procedures exist yet.",
      };
    },
  },
  {
    id: "stage_vs_revenue",
    kind: "contradiction",
    severity: "medium",
    triggers: ["identity.stage", "revenue.generates_revenue", "revenue.monthly_revenue"],
    async evaluate(ctx) {
      const stage = asCode(await ctx.scalar("identity.stage"));
      if (stage !== "idea") return null;
      const generates = asCode(await ctx.scalar("revenue.generates_revenue"));
      const revenue = asMoney(await ctx.scalar("revenue.monthly_revenue"));
      const hasRevenue = generates === "yes" || (revenue !== null && revenue.amount_minor > 0);
      if (!hasRevenue) return null;
      return {
        field_keys: ["identity.stage", "revenue.generates_revenue"],
        message:
          "You described the business as an idea. You also told me revenue is already coming in.",
      };
    },
  },
  {
    id: "stale_financials",
    kind: "stale",
    severity: "low",
    triggers: ["revenue.monthly_revenue"],
    async evaluate(ctx) {
      const observed = await ctx.observedAt("revenue.monthly_revenue");
      if (observed === null) return null;
      const ageDays = (ctx.now().getTime() - new Date(observed).getTime()) / 86_400_000;
      if (ageDays <= 90) return null;
      return {
        field_keys: ["revenue.monthly_revenue"],
        message: `The newest revenue figure I have was observed ${Math.round(ageDays)} days ago.`,
        args: { days: Math.round(ageDays) },
      };
    },
  },
  {
    id: "single_supplier_top_offer",
    kind: "gap",
    severity: "medium",
    triggers: ["suppliers"],
    async evaluate(ctx) {
      if ((await ctx.entityCount("suppliers")) !== 1) return null;
      const suppliers = await ctx.entities("suppliers");
      for (const row of suppliers.values()) {
        if (asBool(row["has_alternative"]) === true) return null;
      }
      return {
        field_keys: ["suppliers"],
        message: "Everything rests on a single supplier, with no alternative recorded.",
      };
    },
  },
];
