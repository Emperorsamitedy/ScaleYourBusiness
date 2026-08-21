// P0-25 — the Session D gate: a full profile round-trips through the real
// database without losing a single field or its provenance.
//
// Runs against live Postgres (docker compose locally, service container in
// CI). Deliberately exercises the profile shapes the design exists for:
// a two-currency profile, an explicit unknown, a conversation-sourced fact
// pointing at its utterance, and an inferred value naming its formula.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  offers,
  users,
  utterances,
} from "../../db/schema";
import { createField } from "../core/field";
import type { Field } from "../core/field";
import { fieldId, utteranceId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { Money } from "../core/money";
import { money } from "../core/money";
import { offerFieldKey } from "./offer";
import type { FieldRecordRow } from "./field-codec";
import { fieldToRow, rowToField } from "./field-codec";

const OBSERVED = isoDateTime("2026-08-19T09:00:00.000Z");
const RECORDED = isoDateTime("2026-08-20T14:30:00.000Z");

let accountId: string;
let profileId: string;
let offerId: string;
let utteranceRowId: string;

beforeAll(async () => {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert returned nothing");
  accountId = account.id;

  const [user] = await db
    .insert(users)
    .values({
      account_id: accountId,
      email: `owner-${accountId}@example.test`,
      display_name: "Test Owner",
      role: "owner",
    })
    .returning();
  if (!user) throw new Error("user insert returned nothing");
  await db.update(accounts).set({ owner_user_id: user.id }).where(eq(accounts.id, accountId));

  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: accountId, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert returned nothing");
  profileId = profile.id;

  const [offer] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  if (!offer) throw new Error("offer insert returned nothing");
  offerId = offer.id;

  const [utterance] = await db
    .insert(utterances)
    .values({
      profile_id: profileId,
      thread_id: crypto.randomUUID(),
      role: "owner",
      text: "we put prices up about 15% last month",
      at: RECORDED,
      intent: "tell",
      cost_eur: "0.004000",
    })
    .returning();
  if (!utterance) throw new Error("utterance insert returned nothing");
  utteranceRowId = utterance.id;
});

afterAll(async () => {
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(utterances).where(eq(utterances.profile_id, profileId));
  await db.delete(offers).where(eq(offers.id, offerId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.update(accounts).set({ owner_user_id: null }).where(eq(accounts.id, accountId));
  await db.delete(users).where(eq(users.account_id, accountId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

function fieldsUnderTest(): Field<unknown>[] {
  return [
    // A plain answered string.
    createField<string>({
      id: fieldId("identity.legal_name"),
      value: "Szörp Kft.",
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: OBSERVED,
      recorded_at: RECORDED,
      note: null,
    }),
    // HUF revenue …
    createField<Money>({
      id: fieldId("revenue.monthly_revenue"),
      value: money(420_000_000, "HUF"),
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: OBSERVED,
      recorded_at: RECORDED,
      note: "roughly, before VAT",
    }),
    // … and EUR ad spend in the same profile — the two-currency case.
    createField<Money>({
      id: fieldId("costs.ads_monthly"),
      value: money(25_000, "EUR"),
      status: "answered",
      confidence: 0.7,
      source: { kind: "conversation", utterance_id: utteranceId(utteranceRowId) },
      observed_at: OBSERVED,
      recorded_at: RECORDED,
      note: null,
    }),
    // An explicit "I don't know" — a real answer, value null, note kept.
    createField<number>({
      id: fieldId("revenue.repeat_customer_rate"),
      value: null,
      status: "unknown",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: OBSERVED,
      recorded_at: RECORDED,
      note: "owner: 'no idea, we never tracked it'",
    }),
    // An inferred margin naming its inputs and formula.
    createField<number>({
      id: fieldId(offerFieldKey(offerId, "physical", ["margin_computed"])),
      value: 0.31,
      status: "inferred",
      confidence: 0.675,
      source: {
        kind: "inferred",
        derived_from: [
          fieldId(offerFieldKey(offerId, "physical", ["price"])),
          fieldId(offerFieldKey(offerId, "physical", ["cost_to_deliver"])),
        ],
        method: "margin = (price - cost_to_deliver) / price",
      },
      observed_at: OBSERVED,
      recorded_at: RECORDED,
      note: null,
    }),
  ];
}

describe("P0-25 — profile round-trip", () => {
  it("writes five representative fields and reads them back without loss", async () => {
    const written = fieldsUnderTest();

    await db
      .insert(fieldRecords)
      .values(written.map((f) => fieldToRow(profileId, f) as typeof fieldRecords.$inferInsert));

    const rows = await db.select().from(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
    expect(rows).toHaveLength(written.length);

    const byKey = new Map(rows.map((r) => [r.field_key, r]));
    for (const original of written) {
      const row = byKey.get(original.id);
      expect(row, `missing row for ${original.id}`).toBeDefined();
      const restored = rowToField(row as unknown as FieldRecordRow);
      // The full Field comes back identical: value, status, confidence,
      // source (including utterance pointer and derivation), note — and
      // the timestamps as the same instants.
      expect(restored).toEqual(original);
    }
  });

  it("preserves the two-currency profile exactly — HUF fillér and EUR cents untouched", async () => {
    const rows = await db.select().from(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
    const revenue = rows.find((r) => r.field_key === "revenue.monthly_revenue");
    const ads = rows.find((r) => r.field_key === "costs.ads_monthly");
    expect(revenue?.value).toEqual({ amount_minor: 420_000_000, currency: "HUF" });
    expect(ads?.value).toEqual({ amount_minor: 25_000, currency: "EUR" });
  });

  it("keeps the conversation-sourced fact pointing at its exact utterance", async () => {
    const rows = await db
      .select()
      .from(fieldRecords)
      .where(eq(fieldRecords.field_key, "costs.ads_monthly"));
    const source = rows[0]?.source as { kind: string; utterance_id: string };
    expect(source.kind).toBe("conversation");
    expect(source.utterance_id).toBe(utteranceRowId);
  });
});
