// Feature 34 — clearing slow stock, as proposals. What must hold, against
// the database with the global fetch stubbed to fail if touched and no
// model anywhere (the hard-limit parse is a stand-in seam):
//   · slow items become PENDING proposals with their evidence (the item's
//     numbers), scenario and reversibility, the top items only;
//   · a markdown is refused by a "we never discount" standing rule — born
//     blocked with the owner's words, visible, never silently dropped;
//   · the email goes through the campaign path's own module and kind, to
//     consented customers only, one for the items together;
//   · three declines of a kind silence it (P3-28);
//   · nothing executes: no execution rows, nothing approved, no network;
//   · a watched business, or one that holds no stock, gets nothing.

import "dotenv/config";
process.env.CONNECTOR_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  connections,
  contacts,
  executions,
  fieldRecords,
  intakeEvents,
  metricObservations,
  modeDecisions,
  proposals,
  users,
} from "../../db/schema";
import { upsertObservations } from "../connectors/service";
import type { Observation } from "../connectors/provider";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { importContacts } from "../crm/import";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { shiftDay } from "./assess";
import { loadStock } from "./load";
import { proposeClearance } from "./propose";

const TODAY = "2026-10-22";
const NOW = new Date(`${TODAY}T08:00:00Z`);

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });
const neverDiscount: LimitLlm = async () => ({
  text: JSON.stringify({ limits: [{ code: "no_discounts", quote: "We never discount." }] }),
  calls: [],
});

let realFetchUsed = false;
beforeEach(() => {
  realFetchUsed = false;
  vi.stubGlobal("fetch", async () => {
    realFetchUsed = true;
    throw new Error("no real network in tests");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(realFetchUsed).toBe(false);
});

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const conns = await db
    .select({ id: connections.id })
    .from(connections)
    .where(inArray(connections.account_id, accountIds));
  if (conns.length > 0) {
    await db.delete(metricObservations).where(
      inArray(
        metricObservations.connection_id,
        conns.map((c) => c.id),
      ),
    );
    await db.delete(connections).where(inArray(connections.account_id, accountIds));
  }
  await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(channels).where(inArray(channels.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.8),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const BOWL = "gid://shopify/Product/1";
const MUG = "gid://shopify/Product/2";
const VASE = "gid://shopify/Product/3";

/** A stocked shop in care: a stuck bowl, a slow vase, a selling mug, 120 days measured. */
async function shop(
  opts: { sells?: string[]; mode?: "instant" | "watching"; customers?: number } = {},
) {
  const s = await bootstrapIntake();
  created.push(s);
  await answer(
    s.profile_id,
    "identity.sells",
    (opts.sells ?? ["physical_products"]).map((code) => ({ code })),
  );
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: opts.mode ?? "instant",
    watch_weeks: opts.mode === "watching" ? 6 : null,
    inputs: {},
    reasoning: "fixture",
    confidence: "0.800",
    review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
  });
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: s.profile_id })
    .returning({ id: channels.id });
  await answer(s.profile_id, `channels.${ch!.id}.type`, { code: "social_organic" });
  await answer(s.profile_id, `channels.${ch!.id}.platform`, { code: "instagram" });

  const [conn] = await db
    .insert(connections)
    .values({ account_id: s.account_id, provider: "shopify" })
    .returning({ id: connections.id });
  const obs: Observation[] = [];
  const at = NOW.toISOString();
  for (let i = 1; i <= 120; i++) {
    const day = shiftDay(TODAY, -i);
    obs.push({
      metric_key: "orders.daily",
      period_date: day,
      dimensions: {},
      value_num: 3,
      observed_at: at,
    });
    obs.push({
      metric_key: "units.daily",
      period_date: day,
      dimensions: { product_ref: MUG },
      value_num: 3,
      observed_at: at,
    });
    if (i % 30 === 0) {
      obs.push({
        metric_key: "units.daily",
        period_date: day,
        dimensions: { product_ref: VASE },
        value_num: 1,
        observed_at: at,
      });
    }
  }
  const snap = (ref: string, name: string, q: number, cost: number, price: number) => {
    const dims = { product_ref: ref, item_name: name };
    obs.push({
      metric_key: "stock.on_hand",
      period_date: TODAY,
      dimensions: dims,
      value_num: q,
      observed_at: at,
    });
    obs.push({
      metric_key: "stock.value_at_cost",
      period_date: TODAY,
      dimensions: { ...dims, currency: "EUR" },
      value_minor: q * cost,
      observed_at: at,
    });
    obs.push({
      metric_key: "stock.value_at_price",
      period_date: TODAY,
      dimensions: { ...dims, currency: "EUR" },
      value_minor: q * price,
      observed_at: at,
    });
  };
  snap(BOWL, "Large Serving Bowl", 40, 2_600, 8_900); // no sale in 120 days: STUCK, €1,040 tied up
  snap(VASE, "Bud Vase Trio", 30, 1_100, 4_800); // 3 in 90 days: 900 days of cover, SLOW
  snap(MUG, "Speckled Everyday Mug", 60, 980, 3_400); // 3 a day: selling
  await upsertObservations(conn!.id, "shopify", obs);

  const n = opts.customers ?? 100;
  if (n > 0) {
    const rows = Array.from(
      { length: n },
      (_, i) => `c${i}-${s.account_id.slice(0, 8)}@example.test,4`,
    );
    await importContacts(s.account_id, ["email,orders", ...rows].join("\n"), {
      status: "explicit_consent",
      statement: "checkout checkbox, fixture",
    });
  }
  return s;
}

const kindOf = (p: typeof proposals.$inferSelect) => (p.action as { kind: string }).kind;
const detailOf = (p: typeof proposals.$inferSelect) =>
  (p.action as { detail: Record<string, unknown> }).detail;

describe("the slow stock, read back", () => {
  it("flags the stuck bowl and the slow vase, most cash first, and leaves the mug", async () => {
    const s = await shop({ customers: 0 });
    const view = await loadStock(s.account_id, s.profile_id, NOW);
    expect(
      view.slow.map((r) => [r.item.name, r.assessment.flag, r.assessment.cash_tied_minor]),
    ).toEqual([
      ["Large Serving Bowl", "STUCK", 104_000],
      ["Bud Vase Trio", "SLOW", 33_000],
    ]);
    expect(view.items.find((r) => r.item.ref === MUG)?.assessment.flag).toBeNull();
  });
});

describe("proposeClearance", () => {
  it("creates pending proposals with their evidence, scenario and reversibility — and executes nothing", async () => {
    const s = await shop();
    const run = await proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.blocked).toHaveLength(0);
    for (const p of run.created) expect(p.status).toBe("pending");

    const rows = await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id));
    // Per item: post, pairing, markdown, sell-off (4 × 2); plus one email for both.
    expect(rows).toHaveLength(9);
    expect(rows.map((p) => p.status).every((st) => st === "pending")).toBe(true);
    expect(rows.every((p) => p.requires_approval === true)).toBe(true);

    const markdown = rows.find(
      (p) =>
        kindOf(p) === "discount_or_promotion" &&
        detailOf(p).stock &&
        (detailOf(p).stock as { ref: string }).ref === BOWL,
    )!;
    expect(markdown.module).toBe("stock");
    expect(detailOf(markdown)).toMatchObject({
      option: "markdown",
      stock: { name: "Large Serving Bowl", on_hand: 40, cash_tied_minor: 104_000, flag: "STUCK" },
      before: { amount_minor: 8_900, currency: "EUR" },
      after: { amount_minor: 6_675, currency: "EUR" },
    });
    expect(detailOf(markdown).evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining("40 on hand"),
        expect.stringContaining("€1,040.00 tied up at cost"),
      ]),
    );
    expect(markdown.scenario).toMatchObject({
      base_case: { formula: expect.stringContaining("sold at 25% off") },
    });
    expect(markdown.reversibility).toMatchObject({ level: "moderate" });

    // The post rides the content calendar path; the email the campaign path.
    // One post per item, in no guaranteed order: pick the bowl's by its focus.
    const posts = rows.filter((p) => p.module === "content");
    expect(posts).toHaveLength(2);
    const post = posts.find(
      (p) => (detailOf(p).items as { focus: string }[])[0]!.focus === "Large Serving Bowl",
    )!;
    expect(post).toBeDefined();
    expect(kindOf(post)).toBe("content_publishing");
    const email = rows.filter((p) => p.module === "crm");
    expect(email).toHaveLength(1);
    expect(kindOf(email[0]!)).toBe("customer_email");
    expect(detailOf(email[0]!)).toMatchObject({ segment: "vip" });
    expect((detailOf(email[0]!).contact_ids as string[]).length).toBe(100);
    expect(email[0]!.reversibility).toMatchObject({ level: "hard" });

    // The selling mug is the pairing's best seller, never a slow item itself.
    expect(rows.some((p) => JSON.stringify(p.action).includes(`"ref":"${MUG}"`))).toBe(false);

    // Nothing executes (rule 12): no execution row, nothing past pending.
    const ran = await db
      .select({ id: executions.id })
      .from(executions)
      .where(
        inArray(
          executions.proposal_id,
          rows.map((p) => p.id),
        ),
      );
    expect(ran).toHaveLength(0);

    // Idempotent: a second run this month proposes nothing new.
    const again = await proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(again.created).toHaveLength(0);
    expect(again.skipped.some((x) => x.reason === "already proposed this month")).toBe(true);
  });

  it('a "we never discount" rule refuses the markdown — born blocked, in the owner\'s words', async () => {
    const s = await shop({ customers: 0 });
    await answer(s.profile_id, "goals.owner_boundaries", "We never discount.");
    const run = await proposeClearance(s.profile_id, { now: NOW, limitLlm: neverDiscount });
    expect(run.blocked.length).toBe(2);
    for (const p of run.blocked) {
      expect(kindOf(p)).toBe("discount_or_promotion");
      expect(p.status).toBe("blocked");
      expect(p.blocked_by_limit).toBe("13.5: We never discount.");
    }
    // Everything else still goes through.
    expect(run.created.every((p) => kindOf(p) !== "discount_or_promotion")).toBe(true);
    expect(run.created.length).toBeGreaterThan(0);
  });

  it("three declines of a kind silence it, saying why", async () => {
    const s = await shop({ customers: 0 });
    const [owner] = await db
      .insert(users)
      .values({
        account_id: s.account_id,
        email: `stock-${crypto.randomUUID()}@test.local`,
        display_name: "Stock owner",
        role: "owner",
      })
      .returning({ id: users.id });
    // Three sell-off advices declined before, with the owner's reasons on the rows.
    for (const n of [1, 2, 3]) {
      await db.insert(proposals).values({
        profile_id: s.profile_id,
        module: "stock",
        originating_finding: `fixture:decline-${n}`,
        action: { kind: "operations_change", summary: `older advice ${n}` },
        scenario: {},
        reversibility: { level: "hard", if_you_change_your_mind: "" },
        status: "rejected",
        decided_by: owner!.id,
        decided_at: NOW.toISOString(),
        rejection_reason: "I'd rather keep it",
        expires_at: NOW.toISOString(),
      });
    }
    const run = await proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created.some((p) => kindOf(p) === "operations_change")).toBe(false);
    expect(run.skipped.some((x) => /declined operations change 3 times/.test(x.reason))).toBe(true);
    // Other kinds are not silenced by it.
    expect(run.created.some((p) => kindOf(p) === "offer_change")).toBe(true);
  });

  it("two runs racing past the read create each proposal once (review 2026-10-23, #22)", async () => {
    const s = await shop();
    const [a, b] = await Promise.all([
      proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits }),
      proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits }),
    ]);
    const rows = await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id));
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((r) => r.originating_finding)).size).toBe(9);
    expect(a.created.length + b.created.length).toBe(9);
    // The loser of each race says so rather than failing.
    const skipped = [...a.skipped, ...b.skipped].filter(
      (x) => x.reason === "already proposed this month",
    );
    expect(skipped.length).toBe(9);
  });

  it("the database refuses a duplicate stock ref outright", async () => {
    const s = await shop({ customers: 0 });
    const run = await proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits });
    const first = run.created[0]!;
    await expect(
      db.insert(proposals).values({
        profile_id: s.profile_id,
        module: first.module,
        originating_finding: first.originating_finding,
        action: first.action,
        scenario: first.scenario,
        reversibility: first.reversibility,
        status: "pending",
        expires_at: first.expires_at,
      }),
    ).rejects.toThrow();
    // A ref outside "stock:" is not held to it.
    const other = { ...first, originating_finding: "utterance:x" };
    for (let i = 0; i < 2; i++) {
      await db.insert(proposals).values({
        profile_id: s.profile_id,
        module: other.module,
        originating_finding: other.originating_finding,
        action: other.action,
        scenario: other.scenario,
        reversibility: other.reversibility,
        status: "pending",
        expires_at: other.expires_at,
      });
    }
  });

  it("a watched business gets nothing (rule 15)", async () => {
    const s = await shop({ mode: "watching", customers: 0 });
    const run = await proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created).toHaveLength(0);
    expect(run.skipped[0]?.reason).toMatch(/I'm watching until/);
  });

  it("a services-only business never gets a stock proposal, whatever the data", async () => {
    const s = await shop({ sells: ["services"], customers: 0 });
    const run = await proposeClearance(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(run.created).toHaveLength(0);
    expect(run.skipped[0]?.reason).toBe("the business doesn't hold stock");
  });
});
