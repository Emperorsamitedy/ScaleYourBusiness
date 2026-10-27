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
/** P4-17: the second demo owner, whose campaign has gone out and been read back. */
const OUTBOUND_EMAIL = "demo-outbound@syb.test";
/** The charts' booking business: a salon whose numbers live in its bookings export. */
const SALON_EMAIL = "demo-salon@syb.test";
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
    const [second] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, OUTBOUND_EMAIL));
    if (second) {
      await db
        .update(users)
        .set({ email: archived.replace("demo-archived-", "demo-outbound-archived-") })
        .where(eq(users.id, second.id));
    }
    const [salon] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, SALON_EMAIL));
    if (salon) {
      await db
        .update(users)
        .set({ email: archived.replace("demo-archived-", "demo-salon-archived-") })
        .where(eq(users.id, salon.id));
    }
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
  const { db } = await import("../db");
  const { users } = await import("../db/schema");
  const { eq } = await import("drizzle-orm");
  const [second] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, OUTBOUND_EMAIL));
  if (second) {
    const other = await requestLogin(OUTBOUND_EMAIL, null);
    console.log(`Sign in as ${OUTBOUND_EMAIL}: a campaign that went out, read back on /customers:`);
    console.log(`  ${origin}/api/auth/redeem?token=${other.token}`);
  }
  const [salon] = await db.select({ id: users.id }).from(users).where(eq(users.email, SALON_EMAIL));
  if (salon) {
    const third = await requestLogin(SALON_EMAIL, null);
    console.log(
      `Sign in as ${SALON_EMAIL}: a salon read from its bookings export, on /profile and /team:`,
    );
    console.log(`  ${origin}/api/auth/redeem?token=${third.token}`);
  }
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
  const { setReplyHours } = await import("../lib/crm/support-settings");
  const { receiveInboundEmail, inboundAddress } = await import("../lib/support/email-tickets");
  const { normaliseReceived, parseReceivedEvent } = await import("../lib/support/inbound");
  const { receivedEvent, receivedEmail } = await import("../lib/support/resend-fixtures");
  const { draftReply } = await import("../lib/support-desk/draft");
  const { proposeContentPlan } = await import("../lib/content/plan");
  const { produceFromProposal } = await import("../lib/content/produce");
  const { runSiteChecks } = await import("../lib/blindspots/checks");
  const { proposeSiteChange } = await import("../lib/site/changes");
  const { importContacts } = await import("../lib/crm/import");
  const { proposeFromSegments } = await import("../lib/crm/segment-proposals");
  const { draftCampaign, campaignDraftFor } = await import("../lib/crm/campaign-draft");
  const { approveCampaignEmail, campaignGates } = await import("../lib/crm/campaign-send");
  const { consentToCampaignEmail } = await import("../lib/execution/email-consent");
  const { sha256: sha256Hex } = await import("../lib/execution/providers/email-campaign");
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
    { table: "support_replies", column: "created_at", scope: "profile" },
    { table: "executions", column: "started_at", scope: "profile" },
    { table: "campaign_sends", column: "created_at", scope: "profile" },
    { table: "contacts", column: "consent_captured_at", scope: "account" },
    { table: "contacts", column: "first_seen_at", scope: "account" },
  ];

  async function dbNow(): Promise<string> {
    const result = await db.execute(sql`select now()::text as now`);
    return String((result.rows[0] as { now: string }).now);
  }

  async function restamp(
    since: string,
    shiftMs: number,
    who: { account: string; profile: string } = ids,
  ): Promise<void> {
    for (const t of STAMPED) {
      const scopeColumn =
        t.scope === "self" ? "id" : t.scope === "profile" ? "profile_id" : "account_id";
      const scopeValue =
        t.scope === "self"
          ? t.table === "accounts"
            ? who.account
            : who.profile
          : t.scope === "profile"
            ? who.profile
            : who.account;
      if (!scopeValue) continue;
      await db.execute(
        sql`update ${sql.identifier(t.table)} set ${sql.identifier(t.column)} = ${sql.identifier(t.column)} - (${shiftMs}::bigint * interval '1 millisecond') where ${sql.identifier(scopeColumn)} = ${scopeValue} and ${sql.identifier(t.column)} >= ${since}::timestamptz`,
      );
    }
  }

  async function phase<T>(
    label: string,
    when: string,
    run: () => Promise<T>,
    who: { account: string; profile: string } = ids,
  ): Promise<T> {
    const since = await dbNow();
    offsetMs = RealDate.parse(when) - RealDate.now();
    log(`${when.slice(0, 16).replace("T", " ")} · ${label}`);
    try {
      return await run();
    } finally {
      const shift = -offsetMs;
      offsetMs = 0;
      if (shift > 0) await restamp(since, shift, who);
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

  /* ── 8b. support email (P4-09..11): three emailed tickets, no network, no model ── */

  // The owner states a reply time; the tickets are measured against it.
  await phase("owner sets a reply time of 24 hours", at(3, "09:10"), async () => {
    await setReplyHours(ids.profile, 24);
  });
  // Recorded-shape Resend payloads, filed through the real inbound path.
  const DEMO_INBOUND_DOMAIN = "inbound.syb.test";
  const emailIn = async (args: {
    from: string;
    subject: string;
    text: string;
    hoursAgo: number;
  }): Promise<string> => {
    const settings = await ensureSupportSettings(ids.profile);
    const createdAt = new RealDate(RealDate.now() - args.hoursAgo * 3_600_000).toISOString();
    const f = {
      email_id: crypto.randomUUID(),
      from: args.from,
      to: ["hello@fernhillceramics.example"],
      received_for: [inboundAddress(settings.inbound_token, DEMO_INBOUND_DOMAIN)],
      subject: args.subject,
      text: args.text,
      message_id: `<${crypto.randomUUID()}@mail.example.com>`,
      created_at: createdAt,
    };
    const email = normaliseReceived(parseReceivedEvent(receivedEvent(f))!, receivedEmail(f));
    if (!email) throw new Error("demo email did not normalise");
    const out = await receiveInboundEmail(email, DEMO_INBOUND_DOMAIN);
    if (out.kind !== "filed") throw new Error(`demo email not filed: ${out.kind}`);
    return out.ticket_id;
  };
  // Overdue: two days old against a 24-hour reply time.
  const hoursAgo = (h: number) => new RealDate(RealDate.now() - h * 3_600_000).toISOString();
  await phase("support email: a chipped plate (overdue)", hoursAgo(46), async () => {
    await emailIn({
      from: "Niamh Byrne <niamh.byrne@example.ie>",
      subject: "Chipped plate in my order #2219",
      text: "Hi Fernhill team,\n\nMy order #2219 arrived on Saturday and one of the four dinner plates has a chip on the rim. The box looked fine. Could you send a replacement, or should I send it back first?\n\nThanks,\nNiamh",
      hoursAgo: 46,
    });
  });
  // Due soon: twenty hours into the twenty-four.
  await phase("support email: a wholesale enquiry (due soon)", hoursAgo(20), async () => {
    await emailIn({
      from: "Orla Quinn <orla@thelittlecafe.example>",
      subject: "Wholesale mugs for our café",
      text: "Hello,\n\nWe're opening a small café in Waterford in December and love your speckled mugs. Do you sell wholesale, and what would 60 mugs look like?\n\nBest,\nOrla Quinn\nThe Little Café",
      hoursAgo: 20,
    });
  });
  // In time, with an AI draft awaiting the owner's approval. The "model" is a
  // stand-in: it cites the approved dishwasher answer it is offered and repeats it.
  await phase("support email: a dishwasher question, drafted", hoursAgo(2), async () => {
    const ticketId = await emailIn({
      from: "Jonas Weber <jonas.weber@example.de>",
      subject: "Dishwasher safe?",
      text: "Hallo! Before I order the serving bowl as a gift: can it go in the dishwasher? Thanks, Jonas",
      hoursAgo: 3,
    });
    const out = await draftReply({
      profileId: ids.profile,
      ticketId,
      llm: async ({ system }) => {
        const m = /\[([0-9a-f-]{36})\] Q: ([^\n]*dishwasher[^\n]*)\nA: ([^\n]*)/i.exec(system);
        return {
          calls: [],
          text: JSON.stringify(
            m
              ? {
                  answer: `Hi Jonas,\n\nThanks for asking before you order. ${m[3]}\n\nWarm wishes from the studio`,
                  grounded: true,
                  used: [m[1]],
                }
              : { answer: "", grounded: false, used: [] },
          ),
        };
      },
    });
    if (!out.drafted) throw new Error(`demo draft refused: ${out.message}`);
  });

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

  // No content calendar for Fernhill: it is still in its watch, and nothing
  // is proposed during one, whoever asks (rule 15; P3-36). The calendar is
  // demonstrated on Emberworks below, which is past its watch.

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
    // P4-15: the owner grants campaign email and approves the drafted email
    // itself. Nothing is sent: the seed never asks for a send, and the engine
    // would hold it anyway (the business is still being watched, the real-send
    // switch is off, no law review is on record locally). The card on
    // /customers shows those gates in words. No network, no model.
    await consentToCampaignEmail({
      accountId: ids.account,
      senderName: "Fernhill Ceramics",
      replyTo: "studio@fernhill-ceramics.example",
      confirmation: "allow campaign email",
    });
    const vipDraft = await campaignDraftFor(vip.id);
    if (vipDraft) {
      await approveCampaignEmail({
        profileId: ids.profile,
        proposalId: vip.id,
        userId: ids.user,
        subject: "Thank you, from the studio",
        bodySha256: sha256Hex(vipDraft.body),
      });
    }
    const [vipRow] = await db
      .select()
      .from(schema.proposals)
      .where(eq(schema.proposals.id, vip.id));
    if (vipRow) {
      const gates = await campaignGates(vipRow, ids.account);
      log(`  thank-you campaign approved and held: ${gates.map((g) => g.code).join(", ")}`);
    }
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

  // P3-50/51, the creative studio: the niche's ads read from the in-repo
  // recorded-shape Ad Library (fictional Irish studios; the global fetch
  // stays sealed, the fake is passed in), and one stored brief. The brief
  // goes through the real checks — citations, lengths, the five-word copy
  // check against those ads — with hand-written text standing in for
  // Sonnet, citing the ids the real prompt numbered. No network, no model.
  {
    const { readNicheAds } = await import("../lib/research/niche");
    const { FAKE_AD_LIBRARY_TOKEN, ceramicsNiche, fakeAdLibrary } =
      await import("../lib/research/ad-library-fake");
    const { writeBrief } = await import("../lib/content/brief");
    const niche = await readNicheAds({
      profileId: ids.profile,
      accountId: ids.account,
      terms: ["mug", "pottery"],
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fakeAdLibrary({ ads: ceramicsNiche(today) }).fetch,
    });
    if (niche.status !== "read") throw new Error(`niche read: ${niche.status}`);
    const mugId = offerIds.get("mug") as string;
    const standIn = async ({ user }: { user: string }) => {
      const lines = [...user.matchAll(/^\[([A-Z]\d+)\] (.*)$/gm)].map((m) => ({
        id: m[1] as string,
        text: m[2] as string,
      }));
      const find = (test: (text: string) => boolean, prefix: string) =>
        lines.find((l) => l.id.startsWith(prefix) && test(l.text))?.id ??
        lines.find((l) => l.id.startsWith(prefix))?.id ??
        (lines.find((l) => l.id.startsWith("F"))?.id as string);
      const mug = find((t) => t.startsWith(`offers.${mugId}.name`), "F");
      const price = find((t) => t.startsWith(`offers.${mugId}.price`), "F");
      const who = find((t) => /^customer(s|_segments)\./.test(t), "F");
      const voice = find(() => true, "V");
      const salt = find((t) => t.startsWith("Saltmarsh Pottery"), "A");
      const furnace = find((t) => t.startsWith("Little Furnace"), "A");
      const finding = find(() => true, "D");
      const shot = (s: string, why: string, cites: string[]) => ({ shot: s, why, cites });
      return {
        text: JSON.stringify({
          audience: {
            text: "People who already buy handmade pieces online and come back for each seasonal glaze, plus gift buyers who want something a person made.",
            cites: [who, finding],
          },
          offer: {
            text: "The Speckled Everyday Mug, thrown and glazed in the Kilkenny studio, from the shop.",
            cites: [mug, price],
          },
          hooks: [
            {
              hook: "No two of these mugs come out of our kiln alike.",
              script:
                "This is the Speckled Everyday Mug. Aoife throws each one on the wheel here in Kilkenny, Niall dips it in our oatmeal glaze, and the fire decides the rest. Some speckle heavily, some hardly at all. Pick the one that looks like your mornings.",
              cites: [salt, mug, voice],
              shots: [
                shot(
                  "Hands centring clay on the wheel, close, no intro card.",
                  "Long-running videos in the niche open on the making, not a logo.",
                  [salt],
                ),
                shot(
                  "The mug dipped into the oatmeal glaze bucket, one smooth pull.",
                  "The glaze is what makes yours different; show it happening.",
                  [mug],
                ),
                shot(
                  "Three finished mugs side by side, turned slowly to the light.",
                  "Shows the variation the script promises.",
                  [mug, voice],
                ),
              ],
            },
            {
              hook: "Twelve hours in the kiln. Here is the moment we open it.",
              script:
                "We load the kiln on Wednesday night and wait. Twelve hours later the door opens and we find out what the glaze did. This shelf is this week's batch of Speckled Everyday Mugs, and these are the ones going up on the shop.",
              cites: [furnace, mug],
              shots: [
                shot(
                  "The kiln door, closed, a hand on the latch.",
                  "A reveal held for a second keeps people watching.",
                  [furnace],
                ),
                shot(
                  "The door swinging open on a full shelf, heat haze if there is any.",
                  "The payoff of the hook, filmed for real.",
                  [furnace],
                ),
                shot(
                  "Lifting one mug off the shelf and turning it in your hand.",
                  "Brings it from the kiln to the customer's eye line.",
                  [mug],
                ),
              ],
            },
            {
              hook: "Why a mug made by hand costs what it does.",
              script:
                "Every Speckled Everyday Mug is thrown, trimmed, handled, glazed and fired by the two of us. That is most of a week before it reaches you. You are paying for that week, and for a mug nobody else has. It is in the shop now.",
              cites: [mug, price, finding],
              shots: [
                shot(
                  "A quick cut through each step: throwing, trimming, the handle going on.",
                  "The price makes sense once the work is visible.",
                  [price],
                ),
                shot(
                  "You, to camera, saying the last line plainly.",
                  "The owner saying it reads as honest, not as an ad.",
                  [voice],
                ),
                shot(
                  "The mug on a breakfast table with coffee in it.",
                  "Ends on the mug in use, the thing being bought.",
                  [mug],
                ),
              ],
            },
          ],
        }),
        cost_eur: 0,
        model: "seed-stand-in (no model call)",
      };
    };
    const written = await writeBrief({
      profileId: ids.profile,
      accountId: ids.account,
      campaign: { label: "Winter glazes: the everyday mug" },
      llm: standIn,
    });
    log(
      `  creative studio: ${niche.read.ads.length} niche ads read from the fake Ad Library; one brief stored (${written.attempts} attempt)`,
    );
  }

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

  /* ── 11. a second, smaller business: a campaign that went out, and its readback (P4-17) ── */

  // Fernhill is still being watched, so nothing of its can have been sent
  // (rule 15) — a sent campaign there would teach the wrong story. The
  // readback lives on a second demo owner, "Emberworks Candles", past its
  // watch: a win-back sent 42 days ago through the real engine and executor
  // with an in-process fake email service (the global fetch stays sealed;
  // the key and address set for that one step are placeholders the fake
  // never checks), delivery events from recorded-shape fixtures, one
  // unsubscribe through the real link, and the shop export six days ago
  // that shows who came back. No network, no model.
  const outbound = { account: "", profile: "", user: "" };
  {
    const { consentToCampaignEmail: grant } = await import("../lib/execution/email-consent");
    const { dbCampaignBackend, sendCampaignNow } = await import("../lib/crm/campaign-send");
    const { campaignReviewVerdict } = await import("../lib/crm/campaign-review");
    const { createEmailCampaignExecutor } =
      await import("../lib/execution/providers/email-campaign");
    const { jurisdictionTableHash, lawReviewVerdict } = await import("../lib/crm/law-review");
    const { applyDeliveryEvent, parseDeliveryEvent } = await import("../lib/crm/campaign-events");
    const { deliveryEvent } = await import("../lib/crm/resend-event-fixtures");
    const { unsubscribe } = await import("../lib/unsubscribe/unsubscribe");
    const { emailCampaignOutcome } = await import("../lib/trust/email-readback");

    const YES = [
      "Maeve",
      "Cian",
      "Orla",
      "Darragh",
      "Niamh",
      "Eoin",
      "Sadhbh",
      "Ronan",
      "Clodagh",
      "Tadhg",
      "Grainne",
      "Fiachra",
    ];
    const UNSURE = [
      "Siobhan",
      "Colm",
      "Una",
      "Padraig",
      "Roisin",
      "Diarmuid",
      "Ailbhe",
      "Cormac",
      "Brid",
      "Lorcan",
    ];
    const address = (name: string, i: number) => `${name.toLowerCase()}.${i}@example.org`;
    const csv = (
      names: readonly string[],
      offset: number,
      lastOrder: (i: number) => string,
      orders: (i: number) => number,
    ) =>
      [
        "Name,Email,Orders Count,Last Order Date",
        ...names.map((n, i) => `${n},${address(n, i + offset)},${orders(i)},${lastOrder(i)}`),
      ].join("\n");
    const lapsedDay = (i: number) => data.shiftDay(today, -(260 + i * 9));
    const who = { account: "", profile: "" };

    await phase(
      "Emberworks: intake answers and the shop export",
      at(70, "10:00"),
      async () => {
        const boot = await bootstrapIntake();
        outbound.account = who.account = boot.account_id;
        outbound.profile = who.profile = boot.profile_id;
        const session = await signInWithEmail(
          `demo-outbound-seeding-${crypto.randomUUID()}@syb.test`,
          outbound.profile,
        );
        outbound.user = session.user_id;
        await db
          .update(schema.users)
          .set({ display_name: "Ciara" })
          .where(eq(schema.users.id, outbound.user));
        await submitAnswer(outbound.account, outbound.profile, "1.1", {
          kind: "value",
          wire: "Emberworks Candles",
        });
        await submitAnswer(outbound.account, outbound.profile, "1.1b", {
          kind: "value",
          wire: "Ireland",
        });
        // One channel the content calendar can plan onto (type and platform
        // as plain codes, as for Fernhill's channels above).
        // Written as a row plus its type and platform facts: 7.1 isn't askable
        // on this minimal intake, and the planner reads the channels table.
        const [row] = await db
          .insert(schema.channels)
          .values({ profile_id: outbound.profile })
          .returning({ id: schema.channels.id });
        const channel = row?.id;
        if (!channel) throw new Error("Emberworks: the channel row didn't land");
        for (const [key, value] of [
          [`channels.${channel}.type`, "social_organic"],
          [`channels.${channel}.platform`, "instagram"],
        ] as const) {
          const now = isoDateTime(new Date().toISOString());
          await writeField(
            outbound.profile,
            createField<unknown>({
              id: fieldId(key),
              value,
              status: "answered",
              confidence: 0.75,
              source: { kind: "owner_input" },
              observed_at: now,
              recorded_at: now,
              note: null,
            }),
          );
        }
        await importContacts(
          outbound.account,
          csv(YES, 0, lapsedDay, (i) => 1 + (i % 3)),
          {
            status: "explicit_consent",
            statement: "Shopify export, customers who ticked 'email me news' at checkout",
          },
        );
        await importContacts(
          outbound.account,
          csv(UNSURE, 100, lapsedDay, (i) => 1 + (i % 2)),
          { status: "unsure", statement: "market-stall customers who gave an email for a receipt" },
        );
      },
      who,
    );

    await phase(
      "Emberworks: the watch ended — instant mode",
      at(50, "09:00"),
      async () => {
        await db.insert(schema.modeDecisions).values({
          profile_id: outbound.profile,
          mode: "instant",
          watch_weeks: null,
          decided_at: new Date().toISOString(),
          inputs: { reasons: ["demo: a second business, past its watch"] },
          reasoning: "Demo fixture: the four-week watch ended without a concern.",
          confidence: "0.800",
          review_at: new Date(Date.now() + 42 * DAY_MS).toISOString(),
        });
      },
      who,
    );

    await phase(
      "Emberworks: content calendar proposed, approved and drafted",
      at(6, "09:30"),
      async () => {
        const plan = await proposeContentPlan(outbound.profile, { weeks: 2, now: new Date() });
        await approveProposal({
          proposalId: plan.id,
          userId: outbound.user,
          profileId: outbound.profile,
        });
        const produced = await produceFromProposal(plan.id, {
          draftLlm,
          expectedProfileId: outbound.profile,
        });
        log(`  content: ${produced.items.length} items`);
      },
      who,
    );

    const saved = {
      SESSION_D_REAL_WRITES: process.env.SESSION_D_REAL_WRITES,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      APP_URL: process.env.APP_URL,
      EMAIL_FROM: process.env.EMAIL_FROM,
    };
    const sentTo: { to: string; text: string }[] = [];
    let winbackId = "";
    await phase(
      "Emberworks: win-back proposed, approved, drafted and sent",
      at(42, "10:30"),
      async () => {
        const proposed = await proposeFromSegments(outbound.profile, {
          limitLlm: async () => ({ text: JSON.stringify({ limits: [] }), calls: [] }),
        });
        const winback = proposed.created.find(
          (p) => (p.action as { detail?: { segment?: string } }).detail?.segment === "lapsed",
        );
        if (!winback) throw new Error("Emberworks: no win-back proposed");
        winbackId = winback.id;
        await approveProposal({
          proposalId: winback.id,
          userId: outbound.user,
          profileId: outbound.profile,
        });
        await draftCampaign(winback.id, {
          expectedProfileId: outbound.profile,
          draftLlm: async () => ({
            text: "It's been a while.\n\nThe autumn candles are poured: fig and cedar, and the smoked-oak one people kept asking about. If you've run out, they're on the shop this week.\n\nCiara",
          }),
        });
        await grant({
          accountId: outbound.account,
          senderName: "Emberworks Candles",
          replyTo: "hello@emberworks-candles.example",
          confirmation: "allow campaign email",
        });
        const draft = await campaignDraftFor(winback.id);
        if (!draft) throw new Error("Emberworks: no draft");
        await approveCampaignEmail({
          profileId: outbound.profile,
          proposalId: winback.id,
          userId: outbound.user,
          subject: "The autumn candles are poured",
          bodySha256: sha256Hex(draft.body),
        });
        // For this one step only: placeholders the in-process fake never checks.
        process.env.SESSION_D_REAL_WRITES = "on";
        process.env.RESEND_API_KEY = "re_demo_in_process_fake";
        process.env.APP_URL = "https://demo.syb.test";
        process.env.EMAIL_FROM = "SYB <campaigns@syb.test>";
        const current = lawReviewVerdict(
          { table_sha256: jurisdictionTableHash(), reviewed_on: today },
          jurisdictionTableHash(),
        );
        try {
          const run = await sendCampaignNow({
            profileId: outbound.profile,
            proposalId: winback.id,
            sleep: async () => undefined,
            provider: createEmailCampaignExecutor({
              sleep: async () => undefined,
              // Stand-ins, like the law review: the demo records no operator's review
              // of this account's first campaign (review 2026-10-23, #5c).
              backend: dbCampaignBackend({
                lawReview: async () => current,
                campaignReview: async () => campaignReviewVerdict({ reviewed_on: today }),
              }),
              fetch: async (_url, init) => {
                const body = JSON.parse(String(init.body)) as { to: string[]; text: string };
                sentTo.push({ to: body.to[0] ?? "", text: body.text });
                return new Response(JSON.stringify({ id: crypto.randomUUID() }), { status: 200 });
              },
            }),
          });
          if (run.result !== "sent") throw new Error(`Emberworks send: ${run.message}`);
        } finally {
          for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
        log(`  win-back sent to ${sentTo.length} (a fake email service, in process)`);
      },
      who,
    );

    await phase(
      "Emberworks: delivery reports and one unsubscribe",
      at(41, "08:00"),
      async () => {
        const sends = await db
          .select()
          .from(schema.campaignSends)
          .where(eq(schema.campaignSends.proposal_id, winbackId));
        const bounced = address(YES[11] as string, 11);
        for (const row of sends) {
          if (!row.provider_message_id || row.contact_id === null) continue;
          const [c] = await db
            .select({ email: schema.contacts.email })
            .from(schema.contacts)
            .where(eq(schema.contacts.id, row.contact_id));
          const type = c?.email === bounced ? "email.bounced" : "email.delivered";
          const event = parseDeliveryEvent(
            deliveryEvent(type, row.provider_message_id, { at: new Date().toISOString() }),
          );
          if (event) await applyDeliveryEvent(event);
        }
        const leaving = sentTo.find((m) => m.to === address(YES[7] as string, 7));
        const token = leaving ? /\/u\/([A-Za-z0-9_-]{43})/.exec(leaving.text)?.[1] : undefined;
        if (token) await unsubscribe(token);
      },
      who,
    );

    await phase(
      "Emberworks: the October shop export",
      at(6, "18:00"),
      async () => {
        // Four of the twelve came back after the email; one of the ten who never said yes did.
        await importContacts(
          outbound.account,
          csv(
            YES,
            0,
            (i) => (i < 4 ? data.shiftDay(today, -(30 - i * 5)) : lapsedDay(i)),
            (i) => 1 + (i % 3) + (i < 4 ? 1 : 0),
          ),
          { status: "implied_consent", statement: "the October Shopify export" },
        );
        await importContacts(
          outbound.account,
          csv(
            UNSURE,
            100,
            (i) => (i === 0 ? data.shiftDay(today, -20) : lapsedDay(i)),
            (i) => 1 + (i % 2) + (i === 0 ? 1 : 0),
          ),
          { status: "implied_consent", statement: "the October market-stall list" },
        );
      },
      who,
    );

    const outcome = await emailCampaignOutcome({
      id: winbackId,
      action: { detail: { segment: "lapsed" } },
    });
    log(`  Emberworks win-back readback: ${outcome.verdict}. ${outcome.arithmetic}`);
    await db
      .update(schema.users)
      .set({ email: OUTBOUND_EMAIL })
      .where(eq(schema.users.id, outbound.user));
  }

  /* ── 12. a booking business: the salon the charts read from its bookings (no network, no model) ── */

  // Lumen Hair Studio: a three-chair salon whose numbers live in its booking
  // system. The owner answers who they are and how many appointments they
  // can take a week, then imports a Fresha-shaped export through the real
  // import path (client emails hashed on the way in), which measures the
  // days and runs the anomaly layer. One proposal waits, priced from the
  // salon's own measured no-shows, its one unmeasured assumption saying so.
  // Its three roles and the team module, switched on, give /team its
  // role-level Saturday note (P5-20): the export's Saturdays fill 10:00–14:00.
  {
    const salon = { account: "", profile: "", user: "" };
    const who = { account: "", profile: "" };
    const { importBookings, CAPACITY_KEY } = await import("../lib/bookings/store");
    const { TEAM_MODULE } = await import("../lib/team/module");
    const { createProposal } = await import("../lib/proposals/service");

    await phase(
      "Lumen Hair Studio: who they are and their weekly capacity",
      at(30, "20:00"),
      async () => {
        const boot = await bootstrapIntake();
        salon.account = who.account = boot.account_id;
        salon.profile = who.profile = boot.profile_id;
        const session = await signInWithEmail(
          `demo-salon-seeding-${crypto.randomUUID()}@syb.test`,
          salon.profile,
        );
        salon.user = session.user_id;
        await db
          .update(schema.users)
          .set({ display_name: "Niamh" })
          .where(eq(schema.users.id, salon.user));
        const say = (qid: string, wire: unknown) =>
          submitAnswer(salon.account, salon.profile, qid, { kind: "value", wire });
        await say("1.1", "Lumen Hair Studio");
        await say("1.1b", "Ireland");
        await say("1.2", "salon_beauty");
        await say("1.4", ["services"]);
        // P5-20: who works in the salon, as roles (9.2), and the team module
        // switched on the way the owner would on /watch (it is off by
        // default, rule 28). Coverage reads each row's role and hours only.
        await say("1.6", 3);
        await submitEntities(salon.account, salon.profile, "9.2", [
          {
            role_title: "Owner and stylist",
            engagement: "owner",
            main_tasks: "Colour, cuts, the books and the rota.",
            hours_per_week: 40,
            replaceability: "single_point_of_failure",
          },
          {
            role_title: "Stylist",
            engagement: "employee",
            main_tasks: "Cuts, colour and blow-dries.",
            hours_per_week: 38,
            replaceability: "hard",
          },
          {
            role_title: "Stylist",
            engagement: "employee",
            main_tasks: "Cuts and blow-dries, and the Saturday book.",
            hours_per_week: 32,
            replaceability: "hard",
          },
        ]);
        await db
          .insert(schema.accountModules)
          .values({ account_id: salon.account, module: TEAM_MODULE, enabled: true });
        // The weekly capacity is the owner's own figure, written through the
        // store like any answer (1.4.2.3b isn't askable this early on).
        const now = isoDateTime(new Date().toISOString());
        await writeField(
          salon.profile,
          createField<unknown>({
            id: fieldId(CAPACITY_KEY),
            value: data.SALON_CAPACITY_PER_WEEK,
            status: "answered",
            confidence: 0.75,
            source: { kind: "owner_input" },
            observed_at: now,
            recorded_at: now,
            note: null,
          }),
        );
        await db.insert(schema.modeDecisions).values({
          profile_id: salon.profile,
          mode: "instant",
          watch_weeks: null,
          decided_at: new Date().toISOString(),
          inputs: { reasons: ["demo: a booking business, read from its bookings export"] },
          reasoning: "Demo fixture: the bookings history is long enough to read straight away.",
          confidence: "0.800",
          review_at: new Date(Date.now() + 42 * DAY_MS).toISOString(),
        });
      },
      who,
    );

    const imported = await phase(
      "Lumen Hair Studio: the bookings export imported",
      new RealDate(RealDate.now() - 60_000).toISOString(),
      async () =>
        importBookings(
          salon.account,
          data.salonBookingsCsv(today),
          { platform: "fresha", currency: "EUR", dateOrder: null },
          new Date(),
        ),
      who,
    );
    log(
      `  salon: ${imported.rows_read} rows read, ${imported.added} appointments, measured ${imported.measured_days?.from} to ${imported.measured_days?.to}`,
    );

    // The proposal's gain rests on the salon's own last 28 days — no-shows ×
    // the average completed price — and one assumption nobody measured (the
    // share a deposit prevents), which says so.
    const [conn] = await db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.account_id, salon.account),
          eq(schema.connections.provider, "bookings_import"),
        ),
      );
    const rows = conn
      ? await db
          .select({
            metric_key: schema.metricObservations.metric_key,
            value_minor: schema.metricObservations.value_minor,
            value_num: schema.metricObservations.value_num,
            period_date: schema.metricObservations.period_date,
          })
          .from(schema.metricObservations)
          .where(eq(schema.metricObservations.connection_id, conn.id))
      : [];
    const from28 = data.shiftDay(today, -28);
    const total = (metric: string) =>
      rows
        .filter((r) => r.metric_key === metric && r.period_date >= from28)
        .reduce((n, r) => n + (r.value_minor ?? Number(r.value_num ?? 0)), 0);
    const noShows = total("appointments_no_show.daily");
    const completed = total("appointments_completed.daily");
    const avg = completed > 0 ? Math.round(total("booking_revenue.daily") / completed) : 0;
    const monthlyLoss = Math.round((noShows * avg * 30) / 28);
    const share = (pct: number) => money(Math.round((monthlyLoss * pct) / 100), "EUR");
    const whole = (minor: number) => `€${Math.round(minor / 100)}`;
    const formula = (pct: number) =>
      `${noShows} no-shows × ${whole(avg)} × 30 ÷ 28 × ${pct}% = ${whole(share(pct).amount_minor)}`;
    await phase(
      "Lumen Hair Studio: a deposit rule proposed",
      new RealDate(RealDate.now() - 30_000).toISOString(),
      async () => {
        await createProposal({
          profile_id: salon.profile,
          module: "diagnosis",
          action: {
            kind: "operations_change",
            summary: "Take a €15 deposit when a new client books",
            detail: {
              rationale:
                "No-shows are the largest measured leak; a small deposit, taken off the bill, is the usual remedy.",
            },
          },
          scenario: {
            assumptions: [
              {
                statement: `${noShows} no-shows in the last 28 days`,
                value: noShows,
                source_field: null,
                measured: "your bookings export, the last 28 days",
                sensitivity: "medium",
              },
              {
                statement: `the average completed appointment is ${whole(avg)}`,
                value: money(avg, "EUR"),
                source_field: null,
                measured: "your bookings export, the last 28 days",
                sensitivity: "low",
              },
              {
                statement:
                  "a deposit prevents a third of no-shows (downside a tenth, upside half) — assumed: nobody has measured it here yet",
                value: 33,
                source_field: null,
                sensitivity: "high",
              },
            ],
            base_case: {
              case: "base",
              statement: `a third fewer no-shows → +${whole(share(33).amount_minor)}/month`,
              profit_delta_monthly: share(33),
              formula: formula(33),
            },
            downside_case: {
              case: "downside",
              statement: `a tenth fewer → +${whole(share(10).amount_minor)}/month`,
              profit_delta_monthly: share(10),
              formula: formula(10),
            },
            upside_case: {
              case: "upside",
              statement: `half as many → +${whole(share(50).amount_minor)}/month`,
              profit_delta_monthly: share(50),
              formula: formula(50),
            },
            breakeven_condition: "costs nothing unless new clients stop booking because of it",
          },
          reversibility: {
            level: "easy",
            if_you_change_your_mind:
              "Turn the deposit off in your booking system; nothing else changes.",
          },
          expires_at: new Date(Date.now() + 14 * DAY_MS).toISOString(),
        });
      },
      who,
    );
    await db
      .update(schema.users)
      .set({ email: SALON_EMAIL })
      .where(eq(schema.users.id, salon.user));
  }

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
