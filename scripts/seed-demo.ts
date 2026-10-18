// LOCAL-ONLY demo seed: "Fernhill Ceramics", a fictional Shopify stoneware
// studio, on a fresh account (demo@syb.test), filled so every owner screen
// has realistic data.
//
//   npm run db:seed-demo             seed once, print a sign-in link
//   npm run db:seed-demo -- --link   already seeded: print a fresh link
//   npm run db:seed-demo -- --fresh  the demo is anchored to the day it was
//                                    seeded; this archives the current demo
//                                    owner (renamed, nothing deleted) and
//                                    seeds a new one around today
//
// The rules it keeps (CLAUDE.md):
//   · It refuses any DATABASE_URL that is not localhost / 127.0.0.1 / ::1.
//   · It never calls a model: ANTHROPIC_API_KEY is removed from its own
//     environment before anything loads, so a stray model call fails loudly
//     instead of spending. Every model seam the services expose is given a
//     deterministic stand-in with hand-written text, and the facts those
//     seams would normally produce (hard limits, the parsed opening hours)
//     are written as inferred facts whose method says they were transcribed
//     by hand.
//   · It never touches the network: global fetch is replaced with one that
//     throws, and the connectors run their real provider code against the
//     in-repo recorded-shape fakes (lib/connectors/providers/*-fake.ts).
//   · Every fact goes through the real write path (intake → writeField,
//     the goal, mapping, derivation and correction services), so it carries
//     provenance and supersedes rather than overwrites.
//   · Nothing is deleted. A second run finds demo@syb.test and stops;
//     --fresh renames that user (demo-archived-<when>@syb.test) — the old
//     account and its append-only log stay, unreachable by the demo login.
//
// Time: the story is a business that did its intake 26 days ago, connected
// its shop 22 days ago and has been watched for 19 days. The services read
// the clock themselves, so each step runs under a simulated clock (a Date
// shim), and the few columns Postgres stamps with its own now() are moved
// to the simulated time afterwards. The decision log is the exception: it
// is append-only and keeps the real time each entry was written — except
// the day-zero entry, which is inserted with its simulated time because
// care is counted from it.

import "dotenv/config";
import { localDatabaseHost } from "./seed-demo-guard";

const DEMO_EMAIL = "demo@syb.test";
const DAY_MS = 86_400_000;

/* ── the simulated clock ── */

const RealDate = Date;
let offsetMs = 0;

class SimulatedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + offsetMs);
    else super(...(args as [string | number | Date]));
  }
  static override now(): number {
    return RealDate.now() + offsetMs;
  }
}

function installClock(): void {
  globalThis.Date = SimulatedDate as unknown as DateConstructor;
}

/* ── no network, no models, no email ── */

function sealOutside(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    throw new Error(`seed-demo makes no network calls (refused: ${url})`);
  }) as typeof fetch;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.RESEND_API_KEY;
  process.env.INTERVIEWER_MODE = "deterministic";
}

function log(line: string): void {
  console.log(`seed-demo · ${line}`);
}

async function main(): Promise<void> {
  const verdict = localDatabaseHost(process.env.DATABASE_URL);
  if (!verdict.ok) {
    console.error(`seed-demo: refusing to run — ${verdict.reason}.`);
    console.error(
      "seed-demo: this script writes a fictional business and is for a local database only.",
    );
    process.exit(1);
  }
  if (!process.env.CONNECTOR_KEY) {
    console.error(
      "seed-demo: CONNECTOR_KEY is not set — the demo connections need it (see .env.example).",
    );
    process.exit(1);
  }
  sealOutside();

  const { eq } = await import("drizzle-orm");
  const { db } = await import("../db");
  const { users } = await import("../db/schema");

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, DEMO_EMAIL));
  if (existing && process.argv.includes("--fresh")) {
    const archived = `demo-archived-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}@syb.test`;
    await db.update(users).set({ email: archived }).where(eq(users.id, existing.id));
    log(`archived the previous demo owner as ${archived} (its account is kept, nothing deleted).`);
  } else if (existing) {
    log(
      `demo already seeded (${DEMO_EMAIL}) — nothing written. Re-seed around today with --fresh.`,
    );
    await printSignIn();
    process.exit(0);
  }
  if (!existing && process.argv.includes("--link")) {
    console.error(`seed-demo: ${DEMO_EMAIL} does not exist yet — run without --link first.`);
    process.exit(1);
  }

  installClock();
  await seed();
  await printSignIn();
  process.exit(0);
}

async function printSignIn(): Promise<void> {
  offsetMs = 0;
  const { requestLogin, LOGIN_TTL_MINUTES } = await import("../lib/auth/service");
  const login = await requestLogin(DEMO_EMAIL, null);
  const origin = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  console.log("");
  console.log(`Sign in as ${DEMO_EMAIL} (one use, expires in ${LOGIN_TTL_MINUTES} minutes):`);
  console.log(`  ${origin}/api/auth/redeem?token=${login.token}`);
  console.log("A fresh link any time: npm run db:seed-demo -- --link");
}

/* ── the seed ── */

async function seed(): Promise<void> {
  const { sql, eq, and, desc } = await import("drizzle-orm");
  const { db } = await import("../db");
  const schema = await import("../db/schema");
  const data = await import("./seed-demo-data");

  const { bootstrapIntake, submitAnswer, submitEntities } = await import("../lib/intake/service");
  const { signInWithEmail } = await import("../lib/auth/service");
  const { createField } = await import("../lib/core/field");
  const { fieldId } = await import("../lib/core/ids");
  const { isoDateTime } = await import("../lib/core/iso");
  const { money } = await import("../lib/core/money");
  const { readCurrentField, writeField } = await import("../lib/profile/field-store");
  const { ensureSnapshot, listSnapshots, diffSnapshots, takeSnapshot } =
    await import("../lib/profile/snapshot");
  const { HARD_LIMITS_KEY, BOUNDARIES_KEY } = await import("../lib/proposals/hard-limits");
  const { SCHEDULE_KEY, HOURS_KEY } = await import("../lib/hours/schedule");
  const { ensureTimezone } = await import("../lib/hours/timezone");
  const { connect } = await import("../lib/connectors/service");
  const { syncConnection } = await import("../lib/connectors/sync");
  const { overrideProviderForTests } = await import("../lib/connectors/registry");
  const { createShopifyProvider } = await import("../lib/connectors/providers/shopify");
  const { fakeShopify, FAKE_SHOPIFY_CREDENTIAL } =
    await import("../lib/connectors/providers/shopify-fake");
  const { createMetaAdsProvider } = await import("../lib/connectors/providers/meta-ads");
  const { fakeMeta, FAKE_META_SECRET } = await import("../lib/connectors/providers/meta-fake");
  const { createGa4Provider } = await import("../lib/connectors/providers/ga4");
  const { fakeGa4, makeServiceAccount } = await import("../lib/connectors/providers/ga4-fake");
  const { confirmMapping } = await import("../lib/connectors/mapping");
  const { deriveFactsFromObservations } = await import("../lib/connectors/derive");
  const { generateReport, respondToRecommendation } = await import("../lib/report/service");
  const { assembleInputs } = await import("../lib/mode/inputs");
  const { decideMode } = await import("../lib/mode/decide");
  const { overrideWatch } = await import("../lib/mode/service");
  const { hashTakeoverPayload, careState } = await import("../lib/care/day-zero");
  const { setGoalMeasure } = await import("../lib/care/goal-measure");
  const { checkGoal } = await import("../lib/care/progress");
  const { updateGoal } = await import("../lib/content/goals");
  const { logHoursFindings } = await import("../lib/watch/job");
  const { ensureSupportSettings } = await import("../lib/crm/support-settings");
  const { proposeKnowledgeEntries, proposeCustomKnowledge, publishKnowledgeFromProposal } =
    await import("../lib/crm/knowledge");
  const { startConversation, postCustomerMessage } = await import("../lib/support/chat");
  const { listTickets, resolveTicket } = await import("../lib/support/tickets");
  const { proposeContentPlan } = await import("../lib/content/plan");
  const { produceFromProposal } = await import("../lib/content/produce");
  const { runSiteChecks } = await import("../lib/blindspots/checks");
  const { proposeSiteChange } = await import("../lib/site/changes");
  const { importContacts } = await import("../lib/crm/import");
  const { proposeFromSegments } = await import("../lib/crm/segment-proposals");
  const { draftCampaign } = await import("../lib/crm/campaign-draft");
  const { generateProposals } = await import("../lib/proposals/generate");
  const { approveProposal, rejectProposal } = await import("../lib/proposals/service");

  type AnswerAction = Parameters<typeof submitAnswer>[3];

  const today = new RealDate().toISOString().slice(0, 10);
  /** A simulated instant: `days` before today at a local-ish hour (UTC). */
  const at = (days: number, hhmm = "09:00"): string =>
    new RealDate(`${data.shiftDay(today, -days)}T${hhmm}:00Z`).toISOString();

  const ids = { account: "", profile: "", user: "" };

  /* ── the clock, phase by phase ── */

  // Columns Postgres stamps with now(): moved to the simulated time after a
  // phase, for this demo's rows only. The decision log is not here — it is
  // append-only and a trigger refuses any UPDATE, which is the point.
  const STAMPED: readonly {
    table: string;
    column: string;
    scope: "profile" | "account" | "self";
  }[] = [
    { table: "accounts", column: "created_at", scope: "self" },
    { table: "business_profiles", column: "created_at", scope: "self" },
    { table: "offers", column: "created_at", scope: "profile" },
    { table: "suppliers", column: "created_at", scope: "profile" },
    { table: "channels", column: "created_at", scope: "profile" },
    { table: "competitors", column: "created_at", scope: "profile" },
    { table: "staff_roles", column: "created_at", scope: "profile" },
    { table: "cost_items", column: "created_at", scope: "profile" },
    { table: "customer_segments", column: "created_at", scope: "profile" },
    { table: "goals", column: "created_at", scope: "profile" },
    { table: "validation_findings", column: "detected_at", scope: "profile" },
    { table: "intake_events", column: "at", scope: "profile" },
    { table: "profile_snapshots", column: "taken_at", scope: "profile" },
    { table: "diagnosis_reports", column: "generated_at", scope: "profile" },
    { table: "mode_decisions", column: "decided_at", scope: "profile" },
    { table: "watch_activity", column: "at", scope: "profile" },
    { table: "connections", column: "created_at", scope: "account" },
    { table: "connector_syncs", column: "started_at", scope: "account" },
    { table: "anomalies", column: "detected_at", scope: "profile" },
    { table: "proposals", column: "created_at", scope: "profile" },
    { table: "content_items", column: "created_at", scope: "profile" },
    { table: "knowledge_entries", column: "published_at", scope: "profile" },
    { table: "support_settings", column: "created_at", scope: "profile" },
    { table: "support_tickets", column: "created_at", scope: "profile" },
  ];

  async function dbNow(): Promise<string> {
    const result = await db.execute(sql`select now()::text as now`);
    return String((result.rows[0] as { now: string }).now);
  }

  async function restamp(since: string, shiftMs: number): Promise<void> {
    for (const t of STAMPED) {
      const scopeColumn =
        t.scope === "self" ? "id" : t.scope === "profile" ? "profile_id" : "account_id";
      const scopeValue =
        t.scope === "self"
          ? t.table === "accounts"
            ? ids.account
            : ids.profile
          : t.scope === "profile"
            ? ids.profile
            : ids.account;
      if (!scopeValue) continue;
      await db.execute(
        sql`update ${sql.identifier(t.table)} set ${sql.identifier(t.column)} = ${sql.identifier(t.column)} - (${shiftMs}::bigint * interval '1 millisecond') where ${sql.identifier(scopeColumn)} = ${scopeValue} and ${sql.identifier(t.column)} >= ${since}::timestamptz`,
      );
    }
  }

  async function phase<T>(label: string, when: string, run: () => Promise<T>): Promise<T> {
    const since = await dbNow();
    offsetMs = RealDate.parse(when) - RealDate.now();
    log(`${when.slice(0, 16).replace("T", " ")} · ${label}`);
    try {
      return await run();
    } finally {
      const shift = -offsetMs;
      offsetMs = 0;
      if (shift > 0) await restamp(since, shift);
    }
  }

  /* ── 1. intake, 26 days ago ── */

  const answer = (qid: string, wire: unknown, estimate = false) => {
    const action: AnswerAction = estimate
      ? { kind: "value", wire, estimate: true }
      : { kind: "value", wire };
    return submitAnswer(ids.account, ids.profile, qid, action);
  };
  const dontKnow = (qid: string) =>
    submitAnswer(ids.account, ids.profile, qid, { kind: "unknown" });
  const skip = (qid: string) => submitAnswer(ids.account, ids.profile, qid, { kind: "skip" });
  const entities = (qid: string, rows: Record<string, unknown>[]) =>
    submitEntities(ids.account, ids.profile, qid, rows);
  const entityIds = async (key: string): Promise<string[]> => {
    const f = await readCurrentField<{ entity_ids: string[] }>(ids.profile, key);
    return f?.value?.entity_ids ?? [];
  };
  const eur = (major: number) => ({ amount_major: major, currency: "EUR" });
  /** An owner statement written straight through the store (plain codes; see channels below). */
  const ownerFact = async (key: string, value: unknown, note: string | null = null) => {
    const now = isoDateTime(new Date().toISOString());
    await writeField(
      ids.profile,
      createField<unknown>({
        id: fieldId(key),
        value,
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: now,
        recorded_at: now,
        note,
      }),
    );
  };

  const offerIds = new Map<string, string>();
  const channelIds = new Map<string, string>();
  const goalIds: string[] = [];

  await phase("intake: identity, presence and offers", at(26, "19:30"), async () => {
    const boot = await bootstrapIntake();
    ids.account = boot.account_id;
    ids.profile = boot.profile_id;
    // The owner, signed in through the same path a magic link takes. The
    // address is a placeholder until the end: demo@syb.test existing means
    // the seed finished, so a crash halfway never passes for a demo.
    const session = await signInWithEmail(
      `demo-seeding-${crypto.randomUUID()}@syb.test`,
      ids.profile,
    );
    ids.user = session.user_id;
    await db
      .update(schema.users)
      .set({ display_name: "Aoife" })
      .where(eq(schema.users.id, ids.user));

    await answer("1.1", "Fernhill Ceramics");
    await answer("1.1b", "Ireland");
    await answer("1.2", "ecommerce_store");
    await answer(
      "1.3",
      "Small-batch stoneware made by hand in our Kilkenny studio — mugs, plates, bowls and vases in our own speckled glazes, sold through our Shopify store and in the studio shop at weekends.",
    );
    await answer("1.4", ["physical_products"]);
    await answer("1.5", "growing");
    await answer("1.5b", "2021-03-01");
    await answer("1.5.1", ["increase_revenue", "improve_profit"]);
    await answer("1.6", 2);
    await answer("2.1", "both");
    await answer("2.1.1.1", 1);
    await answer("2.1.1.2", "studio");
    await answer("2.1.1.3", true);
    await answer(
      "2.1.1.7",
      "Thursday to Saturday 10am–6pm, Sunday 12–5pm. Closed Monday to Wednesday — that's when we throw and fire.",
    );
    await answer("2.1.1.7a", eur(38));
    await answer(
      "2.1.1.8",
      "About twelve people in the shop at once; the kilns cap us at roughly 600 pieces a week.",
    );
    await answer("2.1.2.1", data.SITE);
    await answer("2.1.2.2", true);
    await answer("2.1.2.4", ["shopify"]);
    await answer("2.2.1", "international");
    await answer("2.2.3", "sales");

    await entities(
      "3.1",
      data.PRODUCTS.map((p) => ({
        name: p.name,
        kind: "physical",
        description: p.description,
        price: eur(p.price_minor / 100),
        price_model: "one_time",
        cost_to_deliver: eur(p.cost_minor / 100),
        volume_period: p.stated_volume,
        purchase_type: p.purchase_type,
        lifecycle: "active",
        problems: p.problems,
      })),
    );
    const offers = await entityIds("offers");
    data.PRODUCTS.forEach((p, i) => offerIds.set(p.key, offers[i] as string));
    const offer = (key: string) => offerIds.get(key) as string;

    await answer("3.2", offer("mug"));
    await answer("3.3", offer("pourover"));
    await dontKnow("3.4");
    await answer("1.4.1.2", "yes");
    await answer("1.4.1.2.1a", "ecommerce_platform");
    await answer("1.4.1.2.1b", "weekly");
    await answer("1.4.1.2.1c", [offer("mug"), offer("pourover")]);
    await answer("1.4.1.2.1d", [offer("bowl")]);
    await skip("1.4.1.2.1e");
    await dontKnow("1.4.1.2.1f");
    await entities("1.4.1.3", [
      {
        name: "Midland Clay Supplies",
        country: "United Kingdom",
        supplies_offers: [...offerIds.values()],
        purchase_price: eur(410),
        moq: 250,
        lead_time_days: 10,
        payment_terms: "30 days",
        reliability_issues: "Deliveries slipped twice last winter.",
        has_alternative: false,
        import_duties_apply: true,
      },
      {
        name: "Nore Valley Packaging",
        country: "Ireland",
        supplies_offers: [...offerIds.values()],
        lead_time_days: 4,
        has_alternative: true,
        import_duties_apply: false,
      },
    ]);
    await answer("1.4.1.4", true);
    await answer("1.4.1.4a", "Around 600 pieces a week across two glaze firings.");
    await answer(
      "1.4.1.4b",
      "Glazing. Every piece is dipped by hand and the glaze kiln fires twice a week, so a sell-out on mugs takes about ten days to restock.",
    );
    await answer("1.4.1.5", true);
    await answer("1.4.1.5a", "An Post for Ireland, DPD for the UK and EU since August");
    await answer("1.4.1.5b", "free_over_threshold");
    await answer(
      "1.4.1.5c",
      "Breakage in transit has gone up since we moved UK and EU parcels to DPD in August — roughly one parcel in twenty-five now arrives with something chipped, and we refund or remake it.",
    );
    await answer("1.4.1.6", false);
  });

  await phase("intake: revenue, costs, customers, channels", at(26, "20:10"), async () => {
    await answer("4.1", "yes");
    await answer("4.1a", eur(38_000), true);
    await answer("4.1b", 560, true);
    await answer("4.1c", "growing");
    await dontKnow("4.1d");
    await answer(
      "4.1e",
      "November and December are double any other month; January and February are the quietest.",
    );
    await answer("4.1f", "strong");
    await answer("4.2a", ["card", "online_payment"]);
    await answer("4.2b", "shopify_payments");
    await answer(
      "4.2c",
      "Returns within 30 days for anything unused. If a piece arrives broken, send us a photo and we'll refund or remake it — no need to send it back.",
    );
    await answer(
      "4.3a",
      "Mugs went from €28 to €34 in March 2025; nothing else has moved since 2023.",
    );
    await answer("4.3b", "too_low");

    await entities("5.1", [
      { category: "rent", label: "Studio and shop unit", amount: eur(1450), cadence: "monthly" },
      {
        category: "salaries",
        label: "Studio assistant (24 h/week)",
        amount: eur(1900),
        cadence: "monthly",
      },
      {
        category: "utilities",
        label: "Kiln electricity and heating",
        amount: eur(640),
        cadence: "monthly",
      },
      { category: "software", label: "Shopify and apps", amount: eur(120), cadence: "monthly" },
      { category: "accounting", label: "Accountant", amount: eur(150), cadence: "monthly" },
      {
        category: "insurance",
        label: "Studio and stock insurance",
        amount: eur(1140),
        cadence: "annual",
      },
    ]);
    await entities("5.2", [
      {
        category: "materials",
        label: "Clay and glaze per piece",
        amount: eur(3.2),
        cadence: "per_unit",
      },
      {
        category: "packaging",
        label: "Boxes, paper and tape per piece",
        amount: eur(2.1),
        cadence: "per_unit",
      },
      {
        category: "shipping",
        label: "Courier label per parcel",
        amount: eur(7.4),
        cadence: "per_job",
      },
      {
        category: "payment_fees",
        label: "Shopify Payments per order",
        amount: eur(1.4),
        cadence: "per_job",
      },
    ]);
    await answer("5.3a", 62, true);
    await answer("5.3b", false);
    await answer("5.3c", eur(12_000));
    await answer(
      "5.3d",
      "Breakages in transit — every chipped parcel costs us the piece, the postage twice and a refund.",
    );
    await skip("5.4");

    await answer("6.1a", "both");
    await answer(
      "6.1b",
      "Everyday pieces that feel special — the mug you reach for first every morning, or a gift that is obviously handmade.",
    );
    await answer(
      "6.1c",
      "Price compared to high-street mugs, and whether handmade pieces are dishwasher safe.",
    );
    await answer(
      "6.1d",
      "Mostly women 28–55 in Ireland and the UK, a lot of them buying gifts; a growing group in Germany and the Netherlands.",
    );
    await answer(
      "6.1e",
      "Eight stockists — gift shops and two cafés — who buy wholesale at half of retail.",
    );
    await entities("6.2", [
      {
        name: "Gift buyers",
        who_they_are: "People buying a present for someone else, mostly from Instagram.",
        what_they_buy: "Bud vase trios and mugs in pairs",
        purchase_frequency: "occasional",
        average_spend: eur(58),
        acquisition_source: "Instagram and Google",
      },
      {
        name: "Collectors",
        who_they_are:
          "Customers who buy every seasonal glaze and come back through the newsletter.",
        what_they_buy: "Mugs, plates and the seconds box",
        purchase_frequency: "monthly",
        average_spend: eur(96),
        acquisition_source: "The newsletter",
      },
      {
        name: "Stockists",
        who_they_are: "Independent gift shops and cafés.",
        what_they_buy: "Mugs and plates by the dozen",
        purchase_frequency: "occasional",
        average_spend: eur(620),
        acquisition_source: "Trade fairs",
      },
    ]);
    await answer(
      "6.3a",
      "Instagram first, then searches like 'handmade mugs Ireland', and the newsletter brings them back.",
    );
    await answer(
      "6.3b",
      "A day or two for themselves; gift baskets can sit for a week before Christmas.",
    );
    await answer("6.3c", true);
    await answer("6.4", true);
    await answer("6.4a", 3400);
    await answer("6.4b", "explicit_consent");

    // Channel type and platform are written as plain codes after the rows:
    // the content planner (lib/content/plan.ts) reads them as strings, while
    // the intake's select fields store {code} objects — see the report.
    const channelRows: {
      key: string;
      type: string;
      platform: string | null;
      row: Record<string, unknown>;
    }[] = [
      {
        key: "website",
        type: "website",
        platform: null,
        row: {
          monthly_sales: 520,
          revenue_monthly: eur(33_000),
          cost_monthly: eur(120),
          effort_level: "medium",
          customer_quality: "good",
          trend: "growing",
        },
      },
      {
        key: "instagram",
        type: "social_organic",
        platform: "instagram",
        row: {
          cost_monthly: eur(0),
          effort_level: "high",
          customer_quality: "good",
          trend: "stable",
        },
      },
      {
        key: "ads",
        type: "paid_ads",
        platform: "meta_ads",
        row: {
          monthly_sales: 55,
          cost_monthly: eur(1200),
          effort_level: "low",
          customer_quality: "mixed",
          trend: "declining",
        },
      },
      {
        key: "studio",
        type: "physical_store",
        platform: "in_person",
        row: {
          monthly_sales: 60,
          revenue_monthly: eur(3600),
          effort_level: "medium",
          customer_quality: "excellent",
          trend: "stable",
        },
      },
      {
        key: "email",
        type: "email",
        platform: null,
        row: {
          monthly_sales: 70,
          cost_monthly: eur(25),
          effort_level: "low",
          customer_quality: "excellent",
          trend: "growing",
        },
      },
      {
        key: "stockists",
        type: "resellers",
        platform: null,
        row: {
          monthly_sales: 8,
          revenue_monthly: eur(2400),
          effort_level: "medium",
          customer_quality: "good",
          trend: "stable",
        },
      },
    ];
    await entities(
      "7.1",
      channelRows.map((c) => c.row),
    );
    const channels = await entityIds("channels");
    for (const [i, c] of channelRows.entries()) {
      const id = channels[i] as string;
      channelIds.set(c.key, id);
      await ownerFact(`channels.${id}.type`, c.type);
      if (c.platform) await ownerFact(`channels.${id}.platform`, c.platform);
    }
    await answer("7.3a", channelIds.get("website"));
    await answer("7.3b", channelIds.get("ads"));
    await answer(
      "7.4",
      "Customers buy straight from the website or in the studio; stockists email a wholesale order and we invoice on 30 days.",
    );
    await answer("7.5", ["product_pages", "price_lists"]);
  });

  await phase(
    "intake: marketing, operations, tooling, legal, competition, goals",
    at(26, "20:50"),
    async () => {
      await answer("8.1", "yes");
      await answer("8.1a", eur(1200), true);
      await answer("8.1i", eur(1800));
      await answer("8.1b", ["facebook_ads", "instagram_ads"]);
      await dontKnow("8.1c");
      await answer("8.1e", true);
      await answer("8.1f", "several_weekly");
      await answer(
        "8.1g",
        "Reels of glazes coming out of the kiln — the reveal videos get ten times the views of product photos.",
      );
      await answer("8.1h", "@fernhillceramics on Instagram and TikTok");
      await answer("8.2a", true);
      await answer(
        "8.2b",
        "Pottery made to be used every day, by the two people whose hands you can see in the photos.",
      );
      await answer("8.2d", "Aoife, the owner — she's in most of the videos.");
      await answer("8.3a", true);
      await answer("8.3b", "About 410 reviews on the Shopify store at 4.8, and 96 on Google.");

      await answer("9.1", "operating");
      await answer(
        "9.1a",
        "Mornings: pack and ship yesterday's orders. Middle of the day: throwing, trimming or glazing, depending on the kiln. Evenings: photos, Instagram and messages.",
      );
      await answer(
        "9.1b",
        "Packing — wrapping each piece properly takes longer than making some of them.",
      );
      await answer("9.1c", "Couriers. And the glaze kiln's thermocouple, twice this year.");
      await entities("9.2", [
        {
          role_title: "Owner and potter",
          engagement: "owner",
          main_tasks: "Making, glaze development, photos, marketing, the books.",
          hours_per_week: 55,
          replaceability: "single_point_of_failure",
        },
        {
          role_title: "Studio assistant",
          engagement: "employee",
          main_tasks: "Packing, glazing and the studio shop at weekends.",
          hours_per_week: 24,
          cost_monthly: eur(1900),
          replaceability: "hard",
        },
      ]);
      await answer("9.2b", "Everything that isn't packing.");
      await answer("9.3a", ["email", "social_dm", "in_person"]);
      await answer("9.3b", false);
      await answer(
        "9.3c",
        "Is it dishwasher safe? When will the speckled mugs be back? Do you ship to the UK and what does it cost?",
      );
      await answer("9.3d", "Chipped pieces on arrival, and slow restocks of the speckled mugs.");
      await answer("9.4a", false);
      await answer(
        "9.4b",
        "The November–December rush: sixty orders a day while keeping the kilns full.",
      );

      await answer(
        "10.1",
        "Shopify, Shopify Email, Meta Business Suite, Google Analytics, Canva, and a spreadsheet for glaze recipes and wholesale orders.",
      );
      await answer("10.1b", [
        "website_platform",
        "payments",
        "email_marketing",
        "analytics",
        "ads_manager",
        "design",
        "spreadsheets",
      ]);
      await answer("10.1c", false);
      await answer("10.2", [
        "answering_messages",
        "order_processing",
        "posting_content",
        "checking_stock",
      ]);
      await answer("10.3", "Answering the same three questions in DMs every day.");
      await answer(
        "10.4a",
        "Shopify sales, Instagram insights, and a spreadsheet of wholesale orders.",
      );
      await answer("10.4b", true);

      await answer("11.1a", "sole_trader");
      await answer("11.1b", "registered");
      await skip("11.1c");
      await answer("11.1d", true);
      await answer("11.1e", "Unit 4, Fernhill Craft Yard, Kilkenny, Ireland");
      await answer("11.2a", "Shopify for the shop, Instagram for most new customers.");
      await answer("11.2b", "A kiln failure in November.");
      await answer("11.3", "None that I know of.");

      // No competitor opening hours: the hours screen would parse them with a model.
      await entities("12.1", [
        {
          name: "Saltmarsh Pottery",
          url: "https://saltmarsh-pottery.example",
          what_they_sell: "Coastal-glaze mugs and bowls, mostly online.",
          price_points: "Mugs €30–36, bowls €70–95",
          delivery_promise: "Free EU shipping over €60",
          strengths: "Fast shipping and a big Instagram following.",
          weaknesses: "Glazes look the same season to season.",
        },
        {
          name: "Bluestone Clayworks",
          what_they_sell: "Tableware sets for restaurants and homes.",
          price_points: "Plates €38–48",
          delivery_promise: "Ships within 2 days",
          strengths: "Wholesale and restaurant contracts.",
          weaknesses: "No studio to visit.",
        },
        {
          name: "Hearth & Kiln Co.",
          what_they_sell: "Factory-made 'handmade-look' mugs on Amazon.",
          price_points: "Mugs €18–22",
          strengths: "Price.",
          weaknesses: "Not actually handmade.",
        },
      ]);
      await answer(
        "12.2a",
        "Our own speckled glazes, and that every piece is made in a studio customers can visit.",
      );
      await answer("12.2b", "Collectors who buy every seasonal glaze, and the reviews.");
      await answer("12.2c", "Delivery: slower restocks and more breakage than the bigger studios.");
      await answer("12.3a", "growing");
      await answer("12.3b", false);

      // Goals: the owner's words in the intake; horizon and area are set
      // through the goals service below, which stores them as plain codes.
      await entities("13.1", [
        { statement: "Grow online revenue to €50,000 a month", target_value: "€50,000 a month" },
        { statement: "Reach 750 orders a month", target_value: "750 orders a month" },
        {
          statement: "Get website visits to 50,000 a month",
          target_value: "50,000 visits a month",
        },
        { statement: "Cut breakage refunds to under 1 in 100 parcels", target_value: "1 in 100" },
      ]);
      goalIds.push(...(await entityIds("goals.list")));
      await answer("13.2", "lack_of_time");
      await answer("13.3a", "TikTok ads last spring, and a wholesale fair in Frankfurt.");
      await answer("13.3b", "The TikTok ads brought views but almost no sales.");
      await answer(
        "13.3c",
        "Discount codes for influencers — the codes ended up on voucher sites.",
      );
      await answer("13.4", ["new_markets", "more_automation"]);
      await answer(
        "13.5",
        "No site-wide sales or discount codes — our stockists would see it. No cold emailing people who never bought from us. Nothing goes out under my name without me reading it first.",
      );
      await answer("14.1b", ["product_photos", "videos", "logo", "testimonials", "price_list"]);

      const horizons = ["6_months", "6_months", "3_months", "12_months"];
      const areas = ["increase_revenue", "increase_revenue", "improve_marketing", "improve_profit"];
      for (const [i, goalId] of goalIds.entries()) {
        await updateGoal(ids.profile, goalId, {
          horizon: horizons[i] as string,
          area: areas[i] as string,
        });
      }

      // Facts the services would get from a model, transcribed by hand
      // (inferred, naming their source and that method — rule 6).
      const boundaries = await readCurrentField<string>(ids.profile, BOUNDARIES_KEY);
      const hours = await readCurrentField<string>(ids.profile, HOURS_KEY);
      const now = isoDateTime(new Date().toISOString());
      await writeField(
        ids.profile,
        createField({
          id: fieldId(HARD_LIMITS_KEY),
          value: [
            {
              code: "no_discounts",
              quote: "No site-wide sales or discount codes — our stockists would see it.",
              enforcement: "auto",
            },
            {
              code: "no_cold_outreach",
              quote: "No cold emailing people who never bought from us.",
              enforcement: "auto",
            },
            {
              code: "other",
              quote: "Nothing goes out under my name without me reading it first.",
              enforcement: "manual",
            },
          ],
          status: "inferred",
          confidence: 0.7,
          source: {
            kind: "inferred",
            derived_from: [fieldId(BOUNDARIES_KEY)],
            method: "demo seed: transcribed by hand from the owner's boundaries (no model call)",
          },
          observed_at: boundaries?.observed_at ?? now,
          recorded_at: now,
        }),
      );
      const open = (o: string, c: string) => [{ open: o, close: c }];
      await writeField(
        ids.profile,
        createField({
          id: fieldId(SCHEDULE_KEY),
          value: {
            days: {
              mon: [],
              tue: [],
              wed: [],
              thu: open("10:00", "18:00"),
              fri: open("10:00", "18:00"),
              sat: open("10:00", "18:00"),
              sun: open("12:00", "17:00"),
            },
            unstated: [],
            unparsed: [],
          },
          status: "inferred",
          confidence: 0.7,
          source: {
            kind: "inferred",
            derived_from: [fieldId(HOURS_KEY)],
            method: "demo seed: transcribed by hand from the owner's opening hours (no model call)",
          },
          observed_at: hours?.observed_at ?? now,
          recorded_at: now,
        }),
      );
      await ensureTimezone(ids.profile);
    },
  );

  /* ── 2. connectors, 22 days ago ── */

  const orders = data.shopOrders(today);
  const shop = fakeShopify({
    orders,
    products: [...data.SHOPIFY_PRODUCTS],
    scopes: ["read_orders", "read_products", "read_all_orders"],
  });
  const noSleep = async () => {};
  overrideProviderForTests("shopify", createShopifyProvider({ fetch: shop.fetch, sleep: noSleep }));
  const meta = data.metaInsights(today);
  const metaFake = fakeMeta({ days: meta.days, campaigns: meta.campaigns, currency: "EUR" });
  overrideProviderForTests(
    "meta_ads",
    createMetaAdsProvider({ fetch: metaFake.fetch, sleep: noSleep }),
  );
  const serviceAccount = makeServiceAccount(
    "fernhill-reader@fernhill-ceramics.iam.gserviceaccount.com",
  );
  const ga4Fake = fakeGa4({
    account: serviceAccount,
    propertyId: "412345678",
    rows: data.ga4Rows(today),
    timeZone: data.ZONE,
  });
  overrideProviderForTests("ga4", createGa4Provider({ fetch: ga4Fake.fetch, sleep: noSleep }));

  const conns = { shopify: "", meta: "", ga4: "" };
  await phase(
    "connect Shopify, Meta Ads and Google Analytics; first sync",
    at(22, "08:15"),
    async () => {
      const shopSecret = JSON.stringify({
        shop: "fernhill-ceramics.myshopify.com",
        client_id: FAKE_SHOPIFY_CREDENTIAL.client_id,
        client_secret: FAKE_SHOPIFY_CREDENTIAL.client_secret,
      });
      conns.shopify = (await connect(ids.account, "shopify", shopSecret)).id;
      conns.meta = (await connect(ids.account, "meta_ads", FAKE_META_SECRET)).id;
      conns.ga4 = (
        await connect(
          ids.account,
          "ga4",
          JSON.stringify({ property_id: "412345678", service_account_json: serviceAccount.json }),
        )
      ).id;
      for (const id of Object.values(conns)) {
        const outcome = await syncConnection(id, new Date());
        if (!outcome.ok)
          throw new Error(`first sync of ${outcome.provider} failed: ${outcome.error}`);
        log(
          `  ${outcome.provider}: ${outcome.observations} observations, ${outcome.derived.filter((d) => d.outcome === "written").length} facts`,
        );
      }

      // The owner matches Shopify's products to their offers, and GA4's
      // channels to theirs; the next derivation measures each one.
      for (const p of data.PRODUCTS) {
        await confirmMapping({
          accountId: ids.account,
          connectionId: conns.shopify,
          entityId: offerIds.get(p.key) as string,
          ref: p.ref,
        });
      }
      const ga4Channels: [string, string][] = [
        ["instagram", "Organic Social"],
        ["ads", "Paid Social"],
        ["email", "Email"],
        ["website", "Organic Search"],
      ];
      for (const [key, ref] of ga4Channels) {
        await confirmMapping({
          accountId: ids.account,
          connectionId: conns.ga4,
          entityId: channelIds.get(key) as string,
          ref,
        });
      }
      for (const id of [conns.shopify, conns.ga4]) await deriveFactsFromObservations(id);
    },
  );

  /* ── 3. the diagnosis, 21 days ago ── */

  const offer = (key: string) => offerIds.get(key) as string;
  const report = await phase(
    "diagnosis report (hand-written findings, computed economics)",
    at(21, "10:00"),
    async () => {
      const pick = (user: string, keys: string[]) => {
        const known = new Set([...user.matchAll(/^(\S+) = /gm)].map((m) => m[1]));
        return keys.filter((k) => known.has(k));
      };
      const findingsLlm = async ({ user }: { user: string }) => ({
        calls: [],
        text: JSON.stringify({
          summary:
            "Fernhill sells well and its best seller is priced below what customers already pay for it. Breakage since the courier change is now the biggest leak, and one of the two ad campaigns is costing more than it brings in. Nobody yet knows what a repeat customer is worth, which caps how far any of this can be planned.",
          findings: [
            {
              area: "operations",
              title: "Breakage in transit is now the biggest leak",
              detail:
                "Since UK and EU parcels moved to the new courier, about one parcel in twenty-five arrives chipped, and each one costs the piece, the postage twice and a refund. The owner names it as the biggest leak.",
              evidence: pick(user, [
                "fulfilment.return_problems",
                "costs.biggest_leak",
                "fulfilment.shipping_providers",
                "revenue.monthly_revenue",
              ]),
              severity: "high",
              confidence: 0.75,
            },
            {
              area: "marketing",
              title: "Ad spend runs above what the owner thinks it is",
              detail:
                "Measured spend is above the stated monthly figure, and cost per purchase was not known before Meta was connected. One of the two campaigns carries most of that spend.",
              evidence: pick(user, [
                "marketing.monthly_ad_spend",
                "marketing.cost_per_purchase",
                "marketing.monthly_ad_ceiling",
                "marketing.ad_platforms",
              ]),
              severity: "high",
              confidence: 0.9,
            },
            {
              area: "finance",
              title: "The best seller is priced below its market",
              detail:
                "The Speckled Everyday Mug sells the most units, is out of stock regularly, and the owner feels prices are too low; comparable handmade mugs sell in the same range or above.",
              evidence: pick(user, [
                `offers.${offer("mug")}.price`,
                `offers.${offer("mug")}.cost_to_deliver`,
                `offers.${offer("mug")}.volume_period`,
                "revenue.price_confidence",
                "offers.physical.inventory.stockout_items",
              ]),
              severity: "medium",
              confidence: 0.8,
            },
            {
              area: "product",
              title: "The serving bowl is slow to sell and the most fragile in the post",
              detail:
                "The Large Serving Bowl is listed as slow-moving and hard to deliver, and it is the piece most likely to arrive chipped.",
              evidence: pick(user, [
                `offers.${offer("bowl")}.problems`,
                "offers.physical.inventory.slow_moving_items",
                `offers.${offer("bowl")}.price`,
                `offers.${offer("bowl")}.volume_period`,
              ]),
              severity: "medium",
              confidence: 0.7,
            },
            {
              area: "customers",
              title: "What a repeat customer is worth is unknown",
              detail:
                "The repeat customer rate is unknown, so the value of the newsletter and of win-back emails cannot be weighed against new-customer ads.",
              evidence: pick(user, [
                "revenue.repeat_customer_rate",
                "customers.has_contact_database",
                "customers.contact_count",
              ]),
              severity: "low",
              confidence: 0.6,
            },
          ],
        }),
      });
      const recommendationsLlm = async () => ({
        calls: [],
        text: JSON.stringify({
          recommendations: [
            {
              addresses: [2],
              title: "Raise the Speckled Everyday Mug price by 8%",
              rationale:
                "It sells out, the owner already feels it is underpriced, and competitors' handmade mugs sit in the same band. A small rise tests how much of the demand is price-sensitive.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind:
                "Change the price back in Shopify; nobody who bought at the higher price is affected.",
              scenario: {
                kind: "price_change",
                offer_id: offer("mug"),
                change_pct: 8,
                volume_response_base_pct: -3,
                volume_response_downside_pct: -9,
                volume_response_upside_pct: 0,
                gap_field_keys: null,
                gap_why: null,
              },
            },
            {
              addresses: [3],
              title: "Run a 20% off sale on the Large Serving Bowl",
              rationale:
                "The bowl is slow-moving; a time-limited sale would clear stock before the Christmas glaze runs.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind: "End the sale early; the price returns to normal.",
              scenario: {
                kind: "price_change",
                offer_id: offer("bowl"),
                change_pct: -20,
                volume_response_base_pct: 30,
                volume_response_downside_pct: 8,
                volume_response_upside_pct: 55,
                gap_field_keys: null,
                gap_why: null,
              },
            },
            {
              addresses: [3],
              title: "Lower the Bud Vase Trio price by 10%",
              rationale:
                "The trio is the entry gift; a lower price could pull more first-time buyers into the newsletter.",
              effort: "low",
              reversibility_level: "moderate",
              if_you_change_your_mind:
                "Raise it back — but customers who saw the lower price may wait for it to return.",
              scenario: {
                kind: "price_change",
                offer_id: offer("vase"),
                change_pct: -10,
                volume_response_base_pct: 12,
                volume_response_downside_pct: 2,
                volume_response_upside_pct: 22,
                gap_field_keys: null,
                gap_why: null,
              },
            },
            {
              addresses: [4],
              title: "Find out what a repeat customer is worth",
              rationale:
                "Export the customer list with order counts once; the repeat rate decides whether win-back email beats new-customer ads.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind: "Nothing to undo — it is a number recorded in the profile.",
              scenario: {
                kind: "close_gap",
                offer_id: null,
                change_pct: null,
                volume_response_base_pct: null,
                volume_response_downside_pct: null,
                volume_response_upside_pct: null,
                gap_field_keys: ["revenue.repeat_customer_rate"],
                gap_why:
                  "The repeat customer rate is the number every retention decision rests on.",
              },
            },
          ],
        }),
      });
      const generated = await generateReport({
        accountId: ids.account,
        profileId: ids.profile,
        findingsLlm,
        recommendationsLlm,
      });
      log(
        `  report: ${generated.report.findings.length} findings, ${generated.report.recommendations.length} recommendations`,
      );
      return generated.report;
    },
  );
  await phase("owner marks the mug price rise 'look into it'", at(20, "21:05"), async () => {
    await respondToRecommendation({
      profileId: ids.profile,
      reportId: report.id,
      index: 0,
      response: "look_into",
    });
  });

  /* ── 4. the mode decision, 19 days ago ── */

  await phase("mode decision: watching, then shortened to 4 weeks", at(19, "09:30"), async () => {
    // decideForProfile's own steps, so the day-zero entry carries this day
    // (the log cannot be corrected later — that is the point of it).
    const { inputs, ad_spend_minor } = await assembleInputs(ids.profile);
    const ruling = decideMode(inputs, ad_spend_minor);
    if ("deferred" in ruling) throw new Error(`mode decision deferred: ${ruling.reasoning}`);
    const decidedAt = new Date().toISOString();
    const weeks = ruling.watch_weeks ?? 1;
    const reviewAt = new Date(Date.parse(decidedAt) + weeks * 7 * DAY_MS).toISOString();
    const [decision] = await db
      .insert(schema.modeDecisions)
      .values({
        profile_id: ids.profile,
        mode: ruling.mode,
        watch_weeks: ruling.watch_weeks,
        decided_at: decidedAt,
        inputs: { ...inputs, ad_spend_minor, reasons: ruling.reasons },
        reasoning: ruling.reasoning,
        confidence: ruling.confidence.toFixed(3),
        review_at: reviewAt,
      })
      .returning();
    if (!decision) throw new Error("mode decision insert failed");
    const snapshot = await takeSnapshot(ids.profile, "day_zero");
    const goalRows = await db
      .select({ id: schema.goals.id })
      .from(schema.goals)
      .where(eq(schema.goals.profile_id, ids.profile));
    await db.insert(schema.decisionLog).values({
      profile_id: ids.profile,
      at: decidedAt,
      actor: "system",
      kind: "takeover",
      ref_id: snapshot.id,
      payload_hash: hashTakeoverPayload({
        profile_id: ids.profile,
        decision_id: decision.id,
        snapshot_id: snapshot.id,
        content_hash: snapshot.content_hash,
        goal_ids: goalRows.map((g) => g.id),
      }),
    });
    if (ruling.mode === "watching") {
      await db.insert(schema.watchActivity).values({
        profile_id: ids.profile,
        at: decidedAt,
        kind: "watch_started",
        detail: `Started watching: ${ruling.watch_weeks} weeks, reviewing ${reviewAt.slice(0, 10)}.`,
        meta: { decision_id: decision.id },
      });
    }
    log(`  ruling: ${ruling.mode} ${ruling.watch_weeks ?? ""} weeks`);
    if (ruling.mode === "watching" && ruling.watch_weeks !== 4) {
      await overrideWatch({
        profileId: ids.profile,
        toWeeks: 4,
        userId: ids.user,
        acknowledgementText:
          "I know the figures need eight weeks to settle. I want proposals before the Christmas rush and I'll read every one myself.",
      });
    }
  });

  /* ── 5. goals made measurable, 17 days ago ── */

  await phase("goals made measurable", at(17, "20:00"), async () => {
    const now = new Date();
    const measures = [
      { metric: "revenue", target_per_30d: 5_000_000, currency: "EUR" },
      { metric: "orders", target_per_30d: 750, currency: null },
      { metric: "sessions", target_per_30d: 50_000, currency: null },
    ];
    for (const [i, m] of measures.entries()) {
      const result = await setGoalMeasure(
        ids.profile,
        goalIds[i] as string,
        { ...m, direction: "increase" },
        now,
      );
      log(
        `  goal ${m.metric}: baseline ${result.baseline?.per_30d ?? "none"} (${result.baseline_note ?? "measured"})`,
      );
    }
  });

  /* ── 6. the support assistant's knowledge, 16 days ago ── */

  await phase("support: approved answers published", at(16, "18:40"), async () => {
    await ensureSupportSettings(ids.profile);
    const fromFacts = await proposeKnowledgeEntries(ids.profile);
    const custom = [
      await proposeCustomKnowledge(ids.profile, {
        question: "Are your pieces dishwasher safe?",
        answer:
          "Yes — everything we make is fired to stoneware temperature, so it's dishwasher and microwave safe. The gold-rim pieces are the exception: wash those by hand.",
      }),
      await proposeCustomKnowledge(ids.profile, {
        question: "Do you sell wholesale to shops and cafés?",
        answer:
          "Yes. Wholesale orders start at €400 and we invoice on 30 days. Email the studio with your shop's name and what you're looking for.",
      }),
      await proposeCustomKnowledge(ids.profile, {
        question: "When will the Speckled Everyday Mug be back in stock?",
        answer:
          "We glaze twice a week, so sold-out mugs are usually back within ten days. Sign up for the newsletter and you'll hear the day they land.",
      }),
    ];
    for (const p of [fromFacts, ...custom]) {
      await approveProposal({ proposalId: p.id, userId: ids.user, profileId: ids.profile });
      await publishKnowledgeFromProposal(p.id, { expectedProfileId: ids.profile });
    }
  });

  /* ── 7. the weeks of watching ── */

  const weeklyCheck = async () => {
    const care = await careState(ids.profile);
    for (const goalId of goalIds.slice(0, 3))
      await checkGoal(ids.profile, goalId, care, new Date(), null);
  };
  // runWeeklyWatch's body for this one profile (the job itself walks every business).
  const weeklySnapshot = async () => {
    await logHoursFindings(ids.profile, new Date());
    const before = await listSnapshots(ids.profile);
    const summary = await ensureSnapshot(ids.profile, "watching_weekly");
    const previous = before[0];
    if (before.some((s) => s.id === summary.id) || !previous) {
      await db.insert(schema.watchActivity).values({
        profile_id: ids.profile,
        kind: "snapshot_taken",
        detail: "Weekly check: the profile held steady — nothing changed since last week.",
        meta: { snapshot_id: summary.id },
      });
      return;
    }
    const diff = await diffSnapshots(previous.id, summary.id);
    const parts: string[] = [];
    if (diff.changed.length > 0) parts.push(`${diff.changed.length} changed`);
    if (diff.added.length > 0) parts.push(`${diff.added.length} new`);
    if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
    await db.insert(schema.watchActivity).values({
      profile_id: ids.profile,
      kind: "diff_computed",
      detail: `Weekly snapshot: ${parts.join(", ") || "no field movement"} since last week.`,
      meta: {
        snapshot_id: summary.id,
        against: previous.id,
        changed_keys: diff.changed.map((c) => c.field_key).slice(0, 20),
      },
    });
  };

  await phase("weekly goal check", at(14, "07:00"), weeklyCheck);
  await phase("weekly snapshot and trading hours", at(12, "07:00"), weeklySnapshot);
  await phase("owner corrects the gross margin", at(10, "21:30"), async () => {
    await ownerFact(
      "costs.gross_margin",
      58,
      "corrected by the owner: 62% was before counting breakage refunds",
    );
  });
  await phase("owner corrects the pour-over set's cost", at(9, "12:15"), async () => {
    await ownerFact(
      `offers.${offer("pourover")}.cost_to_deliver`,
      money(4100, "EUR"),
      "clay price went up in September; the carafe alone is now €19 in materials and firing",
    );
  });
  await phase("weekly goal check", at(7, "07:00"), weeklyCheck);
  await phase("weekly snapshot and trading hours", at(5, "07:00"), weeklySnapshot);

  /* ── 8. customer conversations, the last week ── */

  const entryIdFor = (system: string, needle: string): string | null => {
    for (const m of system.matchAll(/\[([0-9a-f-]{36})\] Q: ([^\n]*)/g)) {
      if ((m[2] ?? "").toLowerCase().includes(needle)) return m[1] ?? null;
    }
    return null;
  };
  const chat = async (
    when: string,
    turns: { text: string; intent: "question" | "social"; needle?: string; reply?: string }[],
  ) =>
    phase(`support conversation: "${turns[0]?.text.slice(0, 40)}…"`, when, async () => {
      const settings = await ensureSupportSettings(ids.profile);
      const t0 = RealDate.parse(when);
      let step = 0;
      const clock = () => new RealDate(t0 + step * 70_000);
      const started = await startConversation(settings.site_key, { now: clock });
      for (const turn of turns) {
        step += 1;
        await postCustomerMessage(started.token, turn.text, {
          now: clock,
          intentLlm: async () => ({ text: JSON.stringify({ intent: turn.intent }), calls: [] }),
          answerLlm: async ({ system }) => {
            const id = turn.needle ? entryIdFor(system, turn.needle) : null;
            return {
              calls: [],
              text: JSON.stringify(
                id && turn.reply
                  ? { answer: turn.reply, grounded: true, used: [id] }
                  : { answer: "", grounded: false, used: [] },
              ),
            };
          },
        });
      }
    });

  await chat(at(6, "13:12"), [
    {
      text: "Hi! Are the mugs dishwasher safe?",
      intent: "question",
      needle: "dishwasher",
      reply:
        "Yes — everything Fernhill makes is fired to stoneware temperature, so it's dishwasher and microwave safe. The only exception is the gold-rim pieces, which should be washed by hand.",
    },
    { text: "Brilliant, thank you!", intent: "social" },
  ]);
  await chat(at(4, "10:41"), [
    {
      text: "What time are you open on Sunday?",
      intent: "question",
      needle: "opening hours",
      reply:
        "On Sundays the studio shop is open from 12 to 5pm. The full hours are Thursday to Saturday 10am–6pm and Sunday 12–5pm; it's closed Monday to Wednesday.",
    },
  ]);
  await chat(at(2, "20:47"), [
    { text: "Do you ship to Canada? How long would it take to arrive?", intent: "question" },
  ]);
  await phase("owner answers the Canada shipping question", at(1, "08:20"), async () => {
    const open = (await listTickets(ids.profile)).filter(
      (t) => t.status === "open" && t.summary.includes("Canada"),
    );
    for (const t of open) {
      await resolveTicket(
        ids.profile,
        t.id,
        "answered",
        "Yes — we ship to Canada with DPD. It takes 6–9 working days, shipping is €24, and import duties are paid on delivery.",
      );
    }
  });

  await chat(at(1, "18:05"), [
    {
      text: "My serving bowl arrived cracked (order 2231). Can I speak to a real person please?",
      intent: "question",
    },
  ]);

  /* ── 9. content and the website, the last few days ── */

  const drafts: Record<string, string[]> = {
    email: [
      "The speckled mugs are back.\n\nThis week's glaze firing came out of the kiln on Tuesday, and the oatmeal speckle is on the shelves again — along with the first plates in the winter glaze. If you've been waiting since the last sell-out, now is the time: the last batch went in four days.\n\nAoife",
      "Packing for winter.\n\nA small change you'll notice: every parcel now goes out double-boxed. Breakage in the post has been our biggest headache this autumn, and a chipped mug on Christmas morning is the last thing we want to send you.\n\nAoife",
    ],
    post: [
      "Every Speckled Everyday Mug is thrown, trimmed and dipped by hand here in Kilkenny. The speckle comes from iron in the clay rising through the glaze in the kiln, which is why no two match. Back in stock this week.",
      "Behind the counter at the studio: Thursday to Saturday 10–6, Sunday 12–5. Come and pick a mug off the shelf yourself — the seconds box lives by the door.",
    ],
  };
  const used: Record<string, number> = { email: 0, post: 0 };
  const draftLlm = async ({ user }: { user: string }) => {
    const format = /Format: email/.test(user) ? "email" : "post";
    const list = drafts[format] as string[];
    const text = list[(used[format] ?? 0) % list.length] as string;
    used[format] = (used[format] ?? 0) + 1;
    return { text };
  };

  const plan = await phase("content calendar proposed", at(4, "19:00"), () =>
    proposeContentPlan(ids.profile, { weeks: 2, now: new Date() }),
  );
  await phase("content calendar approved and drafted", at(3, "08:45"), async () => {
    await approveProposal({ proposalId: plan.id, userId: ids.user, profileId: ids.profile });
    const produced = await produceFromProposal(plan.id, {
      draftLlm,
      expectedProfileId: ids.profile,
    });
    log(`  content: ${produced.items.length} items`);
  });

  const fixtureFetcher = async (url: string) => {
    const normalised = url.replace(/\/$/, "") === data.SITE ? `${data.SITE}/` : url;
    const html = data.SITE_PAGES[normalised];
    return {
      url: normalised,
      status: html ? 200 : 404,
      html: html ?? "<!doctype html><title>Not found</title><h1>Not found</h1>",
      headers: { "content-type": "text/html; charset=utf-8", "x-shopid": "fernhill-ceramics" },
      duration_ms: 240,
    };
  };
  await phase("website checked for what customers look for", at(2, "06:30"), async () => {
    const checked = await runSiteChecks(ids.profile, { fetcher: fixtureFetcher, now: new Date() });
    if ("reason" in checked) throw new Error(`site checks: ${checked.reason}`);
  });

  /* ── 10. today ── */

  log("today · sync, customers, proposals and decisions");
  for (const id of Object.values(conns)) {
    const outcome = await syncConnection(id, new Date());
    if (!outcome.ok) throw new Error(`sync of ${outcome.provider} failed: ${outcome.error}`);
    const detected = outcome.anomalies.filter((a) => a.outcome === "detected").length;
    log(
      `  ${outcome.provider}: ${outcome.observations} observations, ${detected} anomalies opened`,
    );
  }

  const people = data.demoContacts(today);
  await importContacts(
    ids.account,
    data.contactsCsv(people.explicit),
    {
      status: "explicit_consent",
      statement:
        "Shopify customer export, filtered to customers who ticked 'email me news and offers' at checkout",
    },
    { currency: "EUR" },
  );
  await importContacts(
    ids.account,
    data.contactsCsv(people.studio),
    {
      status: "implied_consent",
      statement: "Studio shop customers who gave an email for their receipt; no newsletter box",
    },
    { currency: "EUR" },
  );

  const segments = await proposeFromSegments(ids.profile);
  const vip = segments.created.find(
    (p) => (p.action as { detail?: { segment?: string } }).detail?.segment === "vip",
  );
  if (vip) {
    await approveProposal({ proposalId: vip.id, userId: ids.user, profileId: ids.profile });
    await draftCampaign(vip.id, {
      expectedProfileId: ids.profile,
      draftLlm: async () => ({
        text: "Thank you.\n\nYou're one of the people who keeps coming back to the studio, and it's because of you that we can keep making things slowly. The winter glazes go up on the shop next week — you'll hear first.\n\nAoife and Niall",
      }),
    });
  }

  const classify = async ({ user }: { user: string }) => {
    const title = user.split("\n")[0] ?? "";
    const kind = /^Raise/.test(title)
      ? "price_increase"
      : /sale|% off/i.test(title)
        ? "discount_or_promotion"
        : /^Lower/.test(title)
          ? "price_decrease"
          : "operations_change";
    return { text: JSON.stringify({ kind }) };
  };
  const generated = await generateProposals(ids.profile, { classify });
  const vase = generated.created.find((p) =>
    (p.action as { summary?: string }).summary?.startsWith("Lower the Bud Vase"),
  );
  if (vase) {
    await rejectProposal({
      proposalId: vase.id,
      userId: ids.user,
      profileId: ids.profile,
      reason:
        "The trio is already our entry gift — any cheaper and it stops feeling handmade. Our stockists sell it at full price too.",
    });
  }

  await proposeSiteChange(ids.profile, {
    url: `${data.SITE}/products/speckled-everyday-mug`,
    find: "dipped in our oatmeal speckle glaze. Every one is slightly different.",
    replace:
      "dipped in our oatmeal speckle glaze. Dishwasher and microwave safe. Every one is slightly different.",
    fetcher: fixtureFetcher,
  });

  await weeklyCheck();

  // The demo's connections were fed by in-process fakes. Their fake
  // credentials are not kept: a "Sync now" in the app then fails locally
  // ("no credential at rest") instead of sending them to Shopify, Meta or
  // Google. The rows, their scopes and every observation stay.
  await db
    .update(schema.connections)
    .set({ encrypted_secret: null })
    .where(
      and(
        eq(schema.connections.account_id, ids.account),
        eq(schema.connections.purpose, "measure"),
      ),
    );

  // Finished: the demo address now exists, so a re-run stops at the door.
  await db.update(schema.users).set({ email: DEMO_EMAIL }).where(eq(schema.users.id, ids.user));

  const [latest] = await db
    .select({ id: schema.diagnosisReports.id })
    .from(schema.diagnosisReports)
    .where(eq(schema.diagnosisReports.profile_id, ids.profile))
    .orderBy(desc(schema.diagnosisReports.generated_at))
    .limit(1);
  const stats = data.orderStats(orders, data.shiftDay(today, -28), data.shiftDay(today, -1));
  log(
    `done · account ${ids.account} · profile ${ids.profile} · report ${latest?.id ?? "none"} · last 28 days: ${stats.orders} orders, €${Math.round(stats.revenue_minor / 100).toLocaleString("en-IE")} net, ${stats.refunded_orders} refunded`,
  );
}

main().catch((error: unknown) => {
  offsetMs = 0;
  console.error("seed-demo failed:", error);
  process.exit(1);
});
