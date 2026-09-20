// Phase 1 Session A — P1-06. The three promises a snapshot makes:
// it reproduces its inputs byte for byte, its hash is stable under
// everything except a real change, and a diff says exactly what moved.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  offers,
  profileSnapshots,
  suppliers,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { writeField } from "./field-store";
import { diffSnapshots, listSnapshots, readSnapshot, takeSnapshot } from "./snapshot";

let accountId: string;
let profileId: string;

async function w(key: string, value: unknown, status: "answered" | "unknown" = "answered") {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value: status === "answered" ? value : null,
      status,
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

beforeAll(async () => {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  accountId = account.id;
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");
  profileId = profile.id;
});

afterAll(async () => {
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db.delete(suppliers).where(eq(suppliers.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("P1-02/03 — freezing and content addressing", () => {
  it("re-snapshotting an unchanged profile gives the same hash; one changed value changes it", async () => {
    await w("identity.legal_name", "Szörp Kft.");
    await w("revenue.monthly_revenue", money(450_000_000, "HUF"));

    const first = await takeSnapshot(profileId, "report");
    const second = await takeSnapshot(profileId, "manual");
    expect(second.content_hash).toBe(first.content_hash);
    expect(second.id).not.toBe(first.id); // a distinct snapshot, same content
    expect(first.fact_count).toBe(2);

    await w("revenue.monthly_revenue", money(460_000_000, "HUF"));
    const third = await takeSnapshot(profileId);
    expect(third.content_hash).not.toBe(first.content_hash);
  });

  it("counts entity rows and records why it was taken", async () => {
    await db.insert(offers).values({ profile_id: profileId, kind: "physical" });
    const snap = await takeSnapshot(profileId, "watching_weekly");
    expect(snap.entity_count).toBe(1);
    expect(snap.reason).toBe("watching_weekly");
  });
});

describe("P1-04 — a snapshot reproduces its inputs, whatever happened since", () => {
  it("reads back the exact values, ignoring later writes", async () => {
    await w("costs.gross_margin", 40);
    const before = await takeSnapshot(profileId, "report");

    // The owner corrects themselves twice after the report was produced.
    await w("costs.gross_margin", 31);
    await w("costs.gross_margin", 23);

    const view = await readSnapshot(before.id);
    expect(view.facts.get("costs.gross_margin")?.value).toBe(40);
    expect(view.summary.content_hash).toBe(before.content_hash);

    // Money survives the round trip as minor units plus its currency.
    expect(view.facts.get("revenue.monthly_revenue")?.value).toEqual(money(460_000_000, "HUF"));

    // And the live profile has moved on.
    const now = await takeSnapshot(profileId);
    const live = await readSnapshot(now.id);
    expect(live.facts.get("costs.gross_margin")?.value).toBe(23);
  });

  it("refuses an unknown snapshot id rather than returning an empty profile", async () => {
    await expect(readSnapshot(crypto.randomUUID())).rejects.toThrow(/no snapshot/);
  });
});

describe("P1-05 — diffing two snapshots", () => {
  it("reports added, changed and removed facts, and new entities", async () => {
    const before = await takeSnapshot(profileId, "watching_weekly");

    await w("costs.gross_margin", 27); // changed
    await w("revenue.order_count_monthly", 310); // added
    await db.insert(suppliers).values({ profile_id: profileId }); // new entity

    const after = await takeSnapshot(profileId, "watching_weekly");
    const diff = await diffSnapshots(before.id, after.id);

    expect(diff.identical).toBe(false);
    expect(diff.added).toContain("revenue.order_count_monthly");
    expect(diff.changed.map((c) => c.field_key)).toContain("costs.gross_margin");
    const margin = diff.changed.find((c) => c.field_key === "costs.gross_margin");
    expect(margin?.before).toBe(23);
    expect(margin?.after).toBe(27);
    expect(diff.entities_added.map((e) => e.spine)).toContain("suppliers");
    expect(diff.entities_removed).toEqual([]);
  });

  it("argument order does not matter — before is always the older side", async () => {
    const a = await takeSnapshot(profileId);
    await w("identity.legal_name", "Szörp és Társa Kft.");
    const b = await takeSnapshot(profileId);

    const forward = await diffSnapshots(a.id, b.id);
    const backward = await diffSnapshots(b.id, a.id);
    expect(backward.changed).toEqual(forward.changed);
    const change = forward.changed.find((c) => c.field_key === "identity.legal_name");
    expect(change?.before).toBe("Szörp Kft.");
    expect(change?.after).toBe("Szörp és Társa Kft.");
  });

  it("two snapshots of an unmoved profile are identical", async () => {
    const a = await takeSnapshot(profileId);
    const b = await takeSnapshot(profileId);
    const diff = await diffSnapshots(a.id, b.id);
    expect(diff.identical).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("a status change with no value change still counts as movement", async () => {
    await w("marketing.monthly_ad_spend", money(5_000_00, "HUF"));
    const a = await takeSnapshot(profileId);
    await w("marketing.monthly_ad_spend", null, "unknown");
    const b = await takeSnapshot(profileId);

    const diff = await diffSnapshots(a.id, b.id);
    const change = diff.changed.find((c) => c.field_key === "marketing.monthly_ad_spend");
    expect(change?.before_status).toBe("answered");
    expect(change?.after_status).toBe("unknown");
  });
});

describe("listing", () => {
  it("returns this profile's snapshots newest first", async () => {
    const all = await listSnapshots(profileId);
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < all.length; i++) {
      expect(Date.parse(all[i - 1]!.taken_at)).toBeGreaterThanOrEqual(Date.parse(all[i]!.taken_at));
    }
    expect(all.some((s) => s.reason === "report")).toBe(true);
  });
});

afterAll(async () => {
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
});
