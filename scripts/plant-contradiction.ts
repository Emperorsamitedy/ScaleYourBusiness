// Dev-only helper: plant the stage_vs_revenue contradiction on the
// newest profile so the reconcile panel can be exercised in a browser.
// Not part of the app. Usage: npx tsx scripts/plant-contradiction.ts
import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { businessProfiles } from "../db/schema";
import { createField } from "../lib/core/field";
import { fieldId } from "../lib/core/ids";
import { isoDateTime } from "../lib/core/iso";
import { writeField } from "../lib/profile/field-store";

async function main(): Promise<void> {
  const wanted = process.argv[2];
  const [profile] = wanted
    ? await db.select().from(businessProfiles).where(eq(businessProfiles.id, wanted))
    : await db.select().from(businessProfiles).orderBy(desc(businessProfiles.created_at)).limit(1);
  if (!profile) throw new Error("no profile");
  const at = isoDateTime(new Date().toISOString());
  for (const [key, value] of [
    ["identity.stage", { code: "idea" }],
    ["revenue.generates_revenue", { code: "yes" }],
  ] as const) {
    await writeField(
      profile.id,
      createField<unknown>({
        id: fieldId(key),
        value,
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );
  }
  console.log("planted on", profile.id);
  process.exit(0);
}
void main();
