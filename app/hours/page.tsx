// /hours — Insights · Trading hours (Phase 2 Session F, P2-26..30; the
// owner's Trading hours design).
//
// The stated cost of one open hour is read here, on the server, behind
// the same door every profile route uses (lib/auth/access): the grid nets
// each hour against it, and /api/hours doesn't carry it.

import type { Metadata } from "next";
import type { HourCost } from "../../components/hours/HoursScreen";
import { HoursScreen } from "../../components/hours/HoursScreen";
import { resolveAccess } from "../../lib/auth/access";
import { logSafeError } from "../../lib/core/log-safe";
import { OPEN_HOUR_COST_KEY } from "../../lib/hours/trading";
import { readCurrentField } from "../../lib/profile/field-store";

export const metadata: Metadata = { title: "Trading hours — SYB" };
export const dynamic = "force-dynamic";

async function hourCost(): Promise<HourCost | null> {
  const access = await resolveAccess();
  if (!access) return null;
  const field = await readCurrentField<{ amount_minor: number; currency: string }>(
    access.profile_id,
    OPEN_HOUR_COST_KEY,
  );
  // Only an answered cost: the same rule the closing signal uses (openHourCost).
  if (field?.status !== "answered" || !field.value) return null;
  const { amount_minor, currency } = field.value;
  return Number.isInteger(amount_minor) && typeof currency === "string"
    ? { amount_minor, currency }
    : null;
}

export default async function HoursPage() {
  let cost: HourCost | null = null;
  try {
    cost = await hourCost();
  } catch (error) {
    console.error(JSON.stringify({ event: "hour_cost_read_failed", ...logSafeError(error) }));
  }
  return <HoursScreen cost={cost} />;
}
