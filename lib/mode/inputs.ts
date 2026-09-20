// Assembling ModeDecisionInputs from the profile — Session H (P1-42).
//
// §9 keeps the input set explicit and small; this module is the only
// place that knows which field keys feed the decision. Missing fields
// become honest nulls/defaults, never invented values — the deferral
// rule (completeness) is what guards against deciding on too little.

import type { EnumValue } from "../core/enum-value";
import type { Money } from "../core/money";
import { readCurrentField } from "../profile/field-store";
import { computeCompleteness } from "../scorer/completeness";
import { applicableQuestions } from "../resolver/applicability";
import { db } from "../../db";
import { fieldRecords } from "../../db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import type { ModeDecisionInputs } from "./decide";

const asCode = (v: unknown): string | null => {
  if (typeof v === "string" && v !== "") return v;
  if (v !== null && typeof v === "object" && typeof (v as EnumValue).code === "string") {
    return (v as EnumValue).code;
  }
  return null;
};

const asNumber = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const asBoolean = (v: unknown): boolean => v === true;

function monthsSince(iso: string | null): number | null {
  if (!iso) return null;
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((Date.now() - start) / (30.44 * 86_400_000)));
}

/** Mean confidence over responded core-question fields (§9 data_confidence). */
async function coreDataConfidence(profileId: string): Promise<number> {
  const core = (await applicableQuestions(profileId)).filter((q) => q.priority === "core");
  if (core.length === 0) return 0;
  const keys = core.map((q) => q.writes_to);
  const rows = await db
    .select({ confidence: fieldRecords.confidence, status: fieldRecords.status })
    .from(fieldRecords)
    .where(
      and(
        eq(fieldRecords.profile_id, profileId),
        inArray(fieldRecords.field_key, keys),
        isNull(fieldRecords.superseded_at),
      ),
    );
  const responded = rows.filter(
    (r) => r.status === "answered" || r.status === "inferred" || r.status === "unknown",
  );
  if (responded.length === 0) return 0;
  const sum = responded.reduce((a, r) => a + Number(r.confidence), 0);
  return sum / responded.length;
}

export interface AssembledInputs {
  inputs: ModeDecisionInputs;
  /** marketing.monthly_ad_spend in minor units, when given — feeds the 8-week rule. */
  ad_spend_minor: number | null;
}

export async function assembleInputs(profileId: string): Promise<AssembledInputs> {
  const [
    stage,
    generates,
    orders,
    founded,
    teamSize,
    adStatus,
    adSpend,
    support,
    automations,
    completeness,
    confidence,
  ] = await Promise.all([
    readCurrentField<unknown>(profileId, "identity.stage"),
    readCurrentField<unknown>(profileId, "revenue.generates_revenue"),
    readCurrentField<unknown>(profileId, "revenue.order_count_monthly"),
    readCurrentField<unknown>(profileId, "identity.founded"),
    readCurrentField<unknown>(profileId, "identity.team_size"),
    readCurrentField<unknown>(profileId, "marketing.advertising_status"),
    readCurrentField<unknown>(profileId, "marketing.monthly_ad_spend"),
    readCurrentField<unknown>(profileId, "operations.has_support_process"),
    readCurrentField<unknown>(profileId, "tooling.has_automations"),
    computeCompleteness(profileId),
    coreDataConfidence(profileId),
  ]);

  const teamSizeValue = asNumber(teamSize?.value ?? null);
  const spend = (adSpend?.value ?? null) as Money | null;

  return {
    inputs: {
      stage: asCode(stage?.value ?? null),
      has_revenue: asCode(generates?.value ?? null) === "yes",
      monthly_order_count: asNumber(orders?.value ?? null),
      months_operating: monthsSince(typeof founded?.value === "string" ? founded.value : null),
      // team_size includes the owner (1.6 asks "including you"); §9's
      // employee_count does not. A solo founder is zero employees.
      employee_count: teamSizeValue === null ? 0 : Math.max(0, teamSizeValue - 1),
      has_active_ad_spend: asCode(adStatus?.value ?? null) === "yes",
      has_customer_support_process: asBoolean(support?.value ?? null),
      has_existing_automations: asBoolean(automations?.value ?? null),
      data_confidence: confidence,
      completeness: completeness.overall,
    },
    ad_spend_minor:
      spend !== null && typeof spend === "object" && typeof spend.amount_minor === "number"
        ? spend.amount_minor
        : null,
  };
}
