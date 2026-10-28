// The demo business's raw material (scripts/seed-demo.ts): Fernhill
// Ceramics, a fictional two-person stoneware studio in Kilkenny selling on
// Shopify and in its own studio shop. Everything here is deterministic —
// a seeded generator, keyed to the run date — so two runs on the same day
// produce the same shop, and the numbers agree with each other: the orders
// Shopify reports are the orders the products and the hours add up to.
//
// Nothing in this file touches the database or the network.

import type {
  FakeShopifyLine,
  FakeShopifyOrder,
  FakeShopifyProduct,
} from "../lib/connectors/providers/shopify-fake";
import type { FakeMetaCampaignDay, FakeMetaDay } from "../lib/connectors/providers/meta-fake";
import type { FakeGa4Row } from "../lib/connectors/providers/ga4-fake";
import { utcOfZonedHour } from "../lib/connectors/hourly";

export const ZONE = "Europe/Dublin";
export const CURRENCY = "EUR";
/** Days of shop history before today: a full year, so every baseline and chart has its past. */
export const HISTORY_DAYS = 365;
/** The recent stretch the story happens in: conversion drifting, refunds rising. */
export const RECENT_DAYS = 75;

const DAY_MS = 86_400_000;

export function shiftDay(day: string, by: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);
}

/** mulberry32 — small, fast, and the same sequence for the same seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seedOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function weighted<T>(rand: () => number, items: readonly { item: T; weight: number }[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = rand() * total;
  for (const i of items) {
    r -= i.weight;
    if (r <= 0) return i.item;
  }
  return (items[items.length - 1] as { item: T }).item;
}

const euros = (minor: number): string => (minor / 100).toFixed(2);

/* ── the catalogue ── */

export interface DemoProduct {
  key: string;
  /** The owner's name for it (offers.<id>.name). */
  name: string;
  /** Shopify's title — near enough to the owner's name for the mapping to suggest it. */
  shopify_title: string;
  ref: string;
  price_minor: number;
  cost_minor: number;
  /** What the owner believes sells per month — an estimate, superseded by measurement. */
  stated_volume: number;
  /** Share of units sold online. */
  weight: number;
  description: string;
  problems: string[];
  purchase_type: "one_time" | "repeat";
  /** Feature 34: units on hand when Shopify's stock is read. */
  on_hand: number;
}

export const PRODUCTS: readonly DemoProduct[] = [
  {
    key: "mug",
    name: "Speckled Everyday Mug",
    shopify_title: "Speckled Everyday Mug",
    ref: "gid://shopify/Product/7720001",
    price_minor: 3400,
    cost_minor: 980,
    stated_volume: 350,
    weight: 0.46,
    description: "350 ml thrown mug in the oatmeal speckle glaze. Our best seller since 2022.",
    problems: ["too_cheap"],
    purchase_type: "repeat",
    on_hand: 140,
  },
  {
    key: "plate",
    name: "Stoneware Dinner Plate",
    shopify_title: "Stoneware Dinner Plate — 27 cm",
    ref: "gid://shopify/Product/7720002",
    price_minor: 4200,
    cost_minor: 1250,
    stated_volume: 180,
    weight: 0.23,
    description: "27 cm dinner plate, sold singly; most people buy two or four.",
    problems: ["none"],
    purchase_type: "repeat",
    on_hand: 90,
  },
  {
    key: "bowl",
    name: "Large Serving Bowl",
    shopify_title: "Large Serving Bowl",
    ref: "gid://shopify/Product/7720003",
    price_minor: 8900,
    cost_minor: 2600,
    stated_volume: 50,
    weight: 0.07,
    description: "30 cm serving bowl. Slow to glaze and the piece most likely to chip in transit.",
    problems: ["hard_to_deliver", "too_many_refunds"],
    purchase_type: "one_time",
    // Over-made in the spring: far more than it sells, so it reads as slow stock.
    on_hand: 420,
  },
  {
    key: "vase",
    name: "Bud Vase Trio",
    shopify_title: "Bud Vase Trio (set of 3)",
    ref: "gid://shopify/Product/7720004",
    price_minor: 4800,
    cost_minor: 1100,
    stated_volume: 100,
    weight: 0.13,
    description:
      "Three small bud vases in mixed glazes — the gift people buy without thinking twice.",
    problems: ["none"],
    purchase_type: "one_time",
    on_hand: 60,
  },
  {
    key: "pourover",
    name: "Pour-Over Coffee Set",
    shopify_title: "Pour-Over Coffee Set",
    ref: "gid://shopify/Product/7720005",
    price_minor: 11800,
    cost_minor: 3800,
    stated_volume: 40,
    weight: 0.05,
    description: "Dripper, carafe and two cups. The highest margin per piece we make.",
    problems: ["too_manual"],
    purchase_type: "one_time",
    on_hand: 24,
  },
  {
    key: "seconds",
    name: "Seconds Box",
    shopify_title: "Seconds Box — imperfect pieces",
    ref: "gid://shopify/Product/7720006",
    price_minor: 5500,
    cost_minor: 1500,
    stated_volume: 30,
    weight: 0.045,
    description:
      "A box of four pieces with small glaze flaws. Released once a month and gone in a day.",
    problems: ["low_margin"],
    purchase_type: "repeat",
    on_hand: 0,
  },
];

/** Shopify carries two things the owner never listed as offers: these stay unmatched. */
export const SHOPIFY_PRODUCTS: readonly FakeShopifyProduct[] = [
  ...PRODUCTS.map((p) => ({
    id: p.ref,
    title: p.shopify_title,
    status: "ACTIVE",
    // Feature 34: Shopify's stock, valued at the product's price and its cost.
    variants: [{ quantity: p.on_hand, price: euros(p.price_minor), cost: euros(p.cost_minor) }],
  })),
  // A gift card has no stock to count: it reads as untracked.
  { id: "gid://shopify/Product/7720007", title: "Gift Card", status: "DRAFT" },
  // Archived, never sold online, and still on the shelf: stuck stock.
  {
    id: "gid://shopify/Product/7720008",
    title: "Glaze Test Tile",
    status: "ARCHIVED",
    variants: [{ quantity: 120, price: "6.00", cost: "1.50" }],
  },
];

/** Online shipping: €6.50 under the free-shipping threshold of €75. */
export const SHIPPING_MINOR = 650;
export const FREE_SHIPPING_FROM_MINOR = 7500;

/* ── the calendar ── */

/** Day d of the history, oldest first: D-365 … D-1. */
export function historyDays(today: string): string[] {
  return Array.from({ length: HISTORY_DAYS }, (_, i) => shiftDay(today, i - HISTORY_DAYS));
}

/** The studio shop's hours, as the owner states them (2.1.1.7) — local time. */
export const STUDIO_HOURS: Readonly<Record<number, readonly [number, number] | null>> = {
  0: [12, 17], // Sunday
  1: null,
  2: null,
  3: null,
  4: [10, 18], // Thursday
  5: [10, 18],
  6: [10, 18],
};

/** Online orders by local hour: lunch, then the evening scroll. */
const ONLINE_HOUR_WEIGHTS = [
  0.6, 0.3, 0.15, 0.1, 0.1, 0.15, 0.4, 0.9, 1.4, 1.8, 2.0, 2.1, 2.6, 2.7, 2.2, 2.0, 2.0, 2.2, 2.8,
  3.6, 4.2, 4.0, 3.0, 1.6,
];

/** By UTC weekday, 0 = Sunday. Sunday evenings are the online shop's best. */
const ONLINE_WEEKDAY = [1.12, 1.04, 0.95, 0.93, 0.96, 0.9, 1.08];
/** In-person orders a studio day averages. */
const STUDIO_ORDERS = [3, 0, 0, 0, 2, 2, 4];

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** By calendar month (0 = January): Christmas doubles the shop, January and February are quiet. */
const SEASON = [0.7, 0.72, 0.85, 0.9, 0.92, 0.88, 0.86, 0.97, 1.0, 1.03, 1.6, 1.9];

/**
 * The shop's underlying level on a day, as a multiple of today's: the
 * season, a year of growth (+15%), and — over the recent stretch only —
 * the slow conversion drift (orders ease off 8% while visits keep rising).
 */
function demandLevel(day: string, today: string, drift: number): number {
  const month = Number(day.slice(5, 7)) - 1;
  // Christmas ends on the 22nd: the last posting day.
  const season = month === 11 && Number(day.slice(8, 10)) > 22 ? 0.75 : (SEASON[month] ?? 1);
  const daysAgo = (Date.parse(today) - Date.parse(day)) / DAY_MS;
  const growth = 1 - 0.13 * (daysAgo / HISTORY_DAYS);
  const recent = daysAgo <= RECENT_DAYS ? 1 + drift * (1 - daysAgo / RECENT_DAYS) : 1;
  return (season / (SEASON[9] ?? 1)) * growth * recent;
}

/** A local wall-clock time on `day` as a UTC ISO instant. */
function localInstant(day: string, hour: number, minute: number): string {
  const at =
    utcOfZonedHour(day, hour, ZONE) ?? new Date(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  return new Date(at.getTime() + minute * 60_000).toISOString();
}

/* ── Shopify orders ── */

export interface OrderStats {
  orders: number;
  revenue_minor: number;
  refunded_orders: number;
}

/**
 * Every order of the last year. Over the recent stretch conversion drifts
 * down slowly (visits rise, orders don't), and refunds climb from 2% to
 * about 6% of orders over the last three weeks: the courier breakage the
 * owner describes.
 */
/**
 * Idea 48: what customers buy together, on top of the independent picks. A
 * pour-over set often goes out with a bud vase trio (the gift pairing), and
 * a serving bowl with a dinner plate. Drawn from its own random stream, so
 * the main stream — and every other number of the demo's story — is the
 * same as without it. The bowl is the second item of neither pair: its slow
 * stock stays slow.
 */
export const AFFINITY: readonly { with: string; add: string; share: number }[] = [
  { with: "pourover", add: "vase", share: 0.35 },
  { with: "bowl", add: "plate", share: 0.45 },
];

export function shopOrders(today: string): FakeShopifyOrder[] {
  const rand = prng(seedOf(`orders:${today}`));
  const together = prng(seedOf(`together:${today}`));
  const days = historyDays(today);
  const orders: FakeShopifyOrder[] = [];
  let sequence = 1000;
  const breakageFrom = shiftDay(today, -24);

  const pickLines = (): FakeShopifyLine[] => {
    const lineCount = weighted(rand, [
      { item: 1, weight: 78 },
      { item: 2, weight: 18 },
      { item: 3, weight: 4 },
    ]);
    const chosen = new Map<string, number>();
    for (let i = 0; i < lineCount; i++) {
      const p = weighted(
        rand,
        PRODUCTS.map((product) => ({ item: product, weight: product.weight })),
      );
      const qty = (p.key === "mug" || p.key === "plate") && rand() < 0.15 ? 2 : 1;
      chosen.set(p.ref, (chosen.get(p.ref) ?? 0) + qty);
    }
    for (const a of AFFINITY) {
      const base = PRODUCTS.find((p) => p.key === a.with)!;
      const add = PRODUCTS.find((p) => p.key === a.add)!;
      if (chosen.has(base.ref) && !chosen.has(add.ref) && together() < a.share) {
        chosen.set(add.ref, 1);
      }
    }
    return [...chosen.entries()].map(([productId, quantity]) => ({ productId, quantity }));
  };

  const subtotalOf = (lines: FakeShopifyLine[]): number =>
    lines.reduce(
      (s, l) => s + (PRODUCTS.find((p) => p.ref === l.productId)?.price_minor ?? 0) * l.quantity,
      0,
    );

  days.forEach((day) => {
    const wd = weekdayOf(day);
    const refundRate =
      day < breakageFrom
        ? 0.02
        : 0.02 + 0.04 * ((Date.parse(day) - Date.parse(breakageFrom)) / (24 * DAY_MS));
    const level = demandLevel(day, today, -0.08);
    const online = Math.round(22.3 * (ONLINE_WEEKDAY[wd] ?? 1) * level * (0.94 + 0.12 * rand()));
    const studio = Math.round((STUDIO_ORDERS[wd] ?? 0) * level * (0.7 + 0.6 * rand()));

    const place = (kind: "online" | "studio") => {
      const lines = pickLines();
      const subtotal = subtotalOf(lines);
      const shipping =
        kind === "online" && subtotal < FREE_SHIPPING_FROM_MINOR ? SHIPPING_MINOR : 0;
      const total = subtotal + shipping;
      let hour: number;
      if (kind === "online") {
        hour = weighted(
          rand,
          ONLINE_HOUR_WEIGHTS.map((weight, h) => ({ item: h, weight })),
        );
      } else {
        const span = STUDIO_HOURS[wd] as readonly [number, number];
        hour = span[0] + Math.floor(rand() * (span[1] - span[0]));
      }
      const refunded = kind === "online" && rand() < refundRate;
      sequence += 1;
      orders.push({
        id: `gid://shopify/Order/${sequence}`,
        createdAt: localInstant(day, hour, Math.floor(rand() * 60)),
        cancelledAt: null,
        test: false,
        total: euros(total),
        refunded: refunded ? euros(total) : "0.00",
        currency: CURRENCY,
        lines,
      });
    };
    for (let i = 0; i < online; i++) place("online");
    for (let i = 0; i < studio; i++) place("studio");
  });
  return orders;
}

/** Net revenue and order counts over [from, to] by the order's UTC date, as Shopify buckets them. */
export function orderStats(
  orders: readonly FakeShopifyOrder[],
  from: string,
  to: string,
): OrderStats {
  let count = 0;
  let revenue = 0;
  let refunded = 0;
  for (const o of orders) {
    const day = o.createdAt.slice(0, 10);
    if (day < from || day > to) continue;
    count += 1;
    const net = Math.round(Number(o.total) * 100) - Math.round(Number(o.refunded) * 100);
    revenue += net;
    if (o.refunded !== "0.00") refunded += 1;
  }
  return { orders: count, revenue_minor: revenue, refunded_orders: refunded };
}

/* ── Meta Ads ── */

export const RETARGETING = { id: "120210000000001", name: "Always-on — Retargeting" };
export const PROSPECTING = { id: "120210000000002", name: "Autumn Gift Guide — Prospecting" };
export const CHRISTMAS = { id: "120210000000003", name: "Christmas Gifts — Prospecting" };

/**
 * Retargeting all year, returning about five times its spend; last
 * year's Christmas prospecting (November to the 20th of December); and
 * this autumn's prospecting campaign, live for ten weeks, which for the
 * last three has brought back less than it costs.
 */
export function metaInsights(today: string): {
  days: FakeMetaDay[];
  campaigns: FakeMetaCampaignDay[];
} {
  const rand = prng(seedOf(`meta:${today}`));
  const days: FakeMetaDay[] = [];
  const campaigns: FakeMetaCampaignDay[] = [];
  const prospectingFrom = shiftDay(today, -70);
  const fatigueFrom = shiftDay(today, -24);
  const value = (n: number) =>
    Array.from({ length: n }, () => 5600 + Math.floor(rand() * 2000)).reduce((s, v) => s + v, 0);

  for (const day of historyDays(today)) {
    let spend = 0;
    let purchases = 0;
    const rSpend = 1750 + Math.floor(rand() * 200);
    const rPurchases = rand() < 0.45 ? 2 : 1;
    campaigns.push({
      date: day,
      campaign_id: RETARGETING.id,
      campaign_name: RETARGETING.name,
      spend: euros(rSpend),
      purchase_value: euros(value(rPurchases)),
    });
    spend += rSpend;
    purchases += rPurchases;
    const month = Number(day.slice(5, 7));
    if (
      day < shiftDay(today, -200) &&
      (month === 11 || (month === 12 && Number(day.slice(8, 10)) <= 20))
    ) {
      const cSpend = 4200 + Math.floor(rand() * 600);
      const cPurchases = rand() < 0.5 ? 2 : 1;
      campaigns.push({
        date: day,
        campaign_id: CHRISTMAS.id,
        campaign_name: CHRISTMAS.name,
        spend: euros(cSpend),
        purchase_value: euros(value(cPurchases)),
      });
      spend += cSpend;
      purchases += cPurchases;
    }
    if (day >= prospectingFrom) {
      const pSpend = 2850 + Math.floor(rand() * 300);
      const odds = day >= fatigueFrom ? 0.32 : 0.75;
      const pPurchases = rand() < odds ? 1 : 0;
      campaigns.push({
        date: day,
        campaign_id: PROSPECTING.id,
        campaign_name: PROSPECTING.name,
        spend: euros(pSpend),
        ...(pPurchases > 0 ? { purchase_value: euros(value(pPurchases)) } : {}),
      });
      spend += pSpend;
      purchases += pPurchases;
    }
    days.push({
      date: day,
      spend: euros(spend),
      actions: [{ action_type: "omni_purchase", value: String(purchases) }],
    });
  }
  return { days, campaigns };
}

/* ── Google Analytics ── */

const CHANNELS: readonly { name: string; share: number }[] = [
  { name: "Organic Search", share: 0.34 },
  { name: "Organic Social", share: 0.24 },
  { name: "Direct", share: 0.21 },
  { name: "Paid Social", share: 0.15 },
  { name: "Email", share: 0.06 },
];

const LANDINGS: readonly { path: string; bounce: number }[] = [
  { path: "/", bounce: 0.38 },
  { path: "/collections/mugs", bounce: 0.31 },
  { path: "/products/speckled-everyday-mug", bounce: 0.44 },
  { path: "/blogs/journal/caring-for-stoneware", bounce: 0.71 },
  { path: "/collections/gifts", bounce: 0.35 },
  { path: "/collections/seconds", bounce: 0.52 },
  { path: "/pages/about", bounce: 0.58 },
];

const SEARCHES: readonly { term: string; per_day: number }[] = [
  { term: "dishwasher safe", per_day: 3.2 },
  { term: "gift card", per_day: 2.1 },
  { term: "seconds", per_day: 1.6 },
  { term: "workshop", per_day: 1.1 },
  { term: "shipping to uk", per_day: 0.9 },
  { term: "wholesale", per_day: 0.5 },
  { term: "back in stock", per_day: 1.4 },
  { term: "reviews", per_day: 0.6 },
  { term: "apple pay", per_day: 0.4 },
];

/** Website visits on the sessions channel's weekday rhythm. */
const SESSION_WEEKDAY = [1.1, 1.06, 0.98, 0.96, 0.97, 0.9, 1.03];

/**
 * Sessions per day × channel × local hour, landing pages and site
 * searches. Over the recent stretch visits rise about 6% while orders
 * ease off — the conversion drift — and the last two days carry a spike
 * of referral traffic from a gift-guide mention, which the anomaly layer
 * catches.
 */
export function ga4Rows(today: string): FakeGa4Row[] {
  const rand = prng(seedOf(`ga4:${today}`));
  const rows: FakeGa4Row[] = [];
  const days = historyDays(today);
  const spikeFrom = shiftDay(today, -2);
  const hourTotal = ONLINE_HOUR_WEIGHTS.reduce((s, w) => s + w, 0);
  days.forEach((day) => {
    // Visits swing with the season less than orders do: browsing is year-round.
    const level = 0.35 + 0.65 * demandLevel(day, today, 0.06);
    const total = 1450 * (SESSION_WEEKDAY[weekdayOf(day)] ?? 1) * level * (0.97 + 0.06 * rand());
    const channels = [...CHANNELS];
    if (day >= spikeFrom)
      channels.push({ name: "Referral", share: (day === spikeFrom ? 640 : 590) / total });
    channels.forEach((channel, c) => {
      ONLINE_HOUR_WEIGHTS.forEach((weight, hour) => {
        const sessions = Math.round((total * channel.share * weight) / hourTotal);
        if (sessions <= 0) return;
        const landing = LANDINGS[(c * 7 + hour) % LANDINGS.length] as {
          path: string;
          bounce: number;
        };
        rows.push({
          date: day,
          channel: channel.name,
          sessions,
          hour,
          landing: landing.path,
          bounces: Math.round(sessions * landing.bounce),
        });
      });
    });
    for (const s of SEARCHES) {
      const searches = Math.floor(s.per_day * (0.6 + 0.8 * rand()) + rand());
      if (searches > 0)
        rows.push({ date: day, channel: "Direct", sessions: 0, searchTerm: s.term, searches });
    }
  });
  return rows;
}

/* ── customers ── */

const FIRST = [
  "Aisling",
  "Ciara",
  "Niamh",
  "Sorcha",
  "Orla",
  "Siobhan",
  "Clodagh",
  "Roisin",
  "Maeve",
  "Grainne",
  "Eimear",
  "Deirdre",
  "Laura",
  "Hannah",
  "Emma",
  "Sophie",
  "Charlotte",
  "Lena",
  "Anke",
  "Femke",
  "Declan",
  "Cian",
  "Oisin",
  "Ronan",
  "Fionn",
  "Tom",
  "James",
  "Lukas",
  "Joris",
  "Pieter",
  "Brid",
  "Sinead",
  "Una",
  "Aoibheann",
  "Caoimhe",
  "Isobel",
  "Freya",
  "Marta",
  "Ines",
  "Claire",
];
const LAST = [
  "Brennan",
  "Gallagher",
  "Doyle",
  "Kavanagh",
  "Walsh",
  "Byrne",
  "Nolan",
  "Keane",
  "Daly",
  "Moran",
  "Fitzgerald",
  "Quinn",
  "Harper",
  "Ellis",
  "Clarke",
  "Wright",
  "Hughes",
  "Becker",
  "Vogel",
  "de Vries",
  "Ryan",
  "Murphy",
  "Kelly",
  "Burke",
  "Lynch",
  "Price",
  "Cole",
  "Schmidt",
  "Bakker",
  "Visser",
  "Healy",
  "Flood",
  "Tobin",
  "Dunne",
  "Foley",
  "Reid",
  "Morgan",
  "Novak",
  "Silva",
  "Martin",
];
const COUNTRIES = [
  "Ireland",
  "Ireland",
  "Ireland",
  "United Kingdom",
  "Ireland",
  "Germany",
  "Netherlands",
  "Ireland",
];

export interface DemoContact {
  name: string;
  email: string;
  country: string;
  orders: number;
  spent_minor: number;
  last_order: string;
}

/**
 * Forty customers from the Shopify export: new, active, lapsing and
 * lapsed by their last order date, the first thirty-two from the
 * newsletter-consent export, the last eight from studio receipts.
 */
export function demoContacts(today: string): { explicit: DemoContact[]; studio: DemoContact[] } {
  const rand = prng(seedOf(`contacts:${today}`));
  const all: DemoContact[] = FIRST.map((first, i) => {
    const last = LAST[i] as string;
    const bucket = i % 5; // 0 new · 1,2 active · 3 lapsing · 4 lapsed
    const ago =
      bucket === 0
        ? 2 + Math.floor(rand() * 26)
        : bucket <= 2
          ? 31 + Math.floor(rand() * 58)
          : bucket === 3
            ? 95 + Math.floor(rand() * 80)
            : 190 + Math.floor(rand() * 300);
    const orders = bucket === 0 ? 1 : 1 + Math.floor(rand() * (i % 7 === 1 ? 7 : 3));
    const spent = Array.from({ length: orders }, () => 3400 + Math.floor(rand() * 9000)).reduce(
      (s, v) => s + v,
      0,
    );
    return {
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, "")}@example.${i % 3 === 0 ? "net" : i % 3 === 1 ? "com" : "org"}`,
      country: COUNTRIES[i % COUNTRIES.length] as string,
      orders,
      spent_minor: spent,
      last_order: shiftDay(today, -ago),
    };
  });
  return { explicit: all.slice(0, 32), studio: all.slice(32) };
}

export function contactsCsv(rows: readonly DemoContact[]): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [
    "Name,Email,Country,Orders Count,Total Spent,Last Order Date",
    ...rows.map((r) =>
      [r.name, r.email, r.country, String(r.orders), euros(r.spent_minor), r.last_order]
        .map(quote)
        .join(","),
    ),
  ].join("\n");
}

/* ── the website (the fixture site: *.example never resolves) ── */

export const SITE = "https://fernhill-ceramics.example";

const SHELL = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} — Fernhill Ceramics</title>
<link rel="stylesheet" href="https://cdn.shopify.com/s/files/1/0000/0001/t/3/assets/theme.css">
<script>window.Shopify = window.Shopify || {}; Shopify.theme = {"name":"Dawn","role":"main"};</script>
</head><body>
<header><a href="/">Fernhill Ceramics</a>
<nav><a href="/collections/all">Shop</a> <a href="/pages/about">About &amp; visiting</a> <a href="/pages/shipping-returns">Shipping &amp; returns</a> <a href="/pages/contact">Contact</a></nav></header>
<main>${body}</main>
<footer><p>Fernhill Ceramics · Unit 4, Fernhill Craft Yard, Kilkenny</p></footer>
</body></html>`;

export const SITE_PAGES: Readonly<Record<string, string>> = {
  [`${SITE}/`]: SHELL(
    "Handmade stoneware from Kilkenny",
    `<h1>Pottery made to be used every day</h1>
<p>Small-batch stoneware thrown, glazed and fired in our Kilkenny studio. Mugs from &euro;34.</p>
<p>Free shipping on orders over &euro;75 to Ireland, the UK and the EU.</p>
<p><a href="/collections/mugs">Shop mugs</a> · <a href="/collections/gifts">Gifts</a></p>`,
  ),
  [`${SITE}/pages/about`]: SHELL(
    "About the studio",
    `<h1>About the studio</h1>
<p>Opening hours: Thursday to Saturday 10am–6pm, Sunday 12–5pm. Closed Monday to Wednesday.</p>
<p>Find us: <a href="https://maps.example/fernhill-craft-yard">Fernhill Craft Yard, Kilkenny</a></p>`,
  ),
  [`${SITE}/pages/shipping-returns`]: SHELL(
    "Shipping & returns",
    `<h1>Shipping &amp; returns</h1>
<p>We ship with An Post in Ireland and DPD to the UK and EU. Delivery takes 2–5 working days.</p>
<p>Returns within 30 days for anything unused. Broken on arrival? Send us a photo and we'll refund or remake it.</p>`,
  ),
  [`${SITE}/pages/contact`]: SHELL(
    "Contact",
    `<h1>Contact</h1>
<p>Email <a href="mailto:studio@fernhill-ceramics.example">studio@fernhill-ceramics.example</a> — we answer within a day.</p>`,
  ),
  [`${SITE}/products/speckled-everyday-mug`]: SHELL(
    "Speckled Everyday Mug",
    `<h1>Speckled Everyday Mug</h1>
<p class="price">&euro;34.00</p>
<p class="product-description">A 350 ml mug thrown on the wheel and dipped in our oatmeal speckle glaze. Every one is slightly different.</p>
<form action="/cart/add" method="post"><button type="submit">Add to cart</button></form>`,
  ),
};

/* ── a booking business: "Lumen Hair Studio" (the salon demo) ── */

/** Services, their list price (minor units, EUR) and how often each is booked. */
export const SALON_SERVICES: readonly { name: string; price_minor: number; weight: number }[] = [
  { name: "Cut & finish", price_minor: 4500, weight: 5 },
  { name: "Colour", price_minor: 9500, weight: 2 },
  { name: "Blow-dry", price_minor: 3500, weight: 3 },
  { name: "Balayage", price_minor: 14000, weight: 1 },
];

/**
 * Idea 48: the add-on a colour client often takes in the same visit — the
 * next slot, the same client. It replaces that slot's own booking, so the
 * day's count (and capacity) is unchanged, and it is drawn from its own
 * random stream so the rest of the export is as before.
 */
export const SALON_ADD_ON = {
  name: "Gloss treatment",
  price_minor: 2500,
  after: ["Colour", "Balayage"],
  share: 0.4,
} as const;

/** Appointments the salon says it can take a week (question 1.4.2.3b): five days × 24 slots. */
export const SALON_CAPACITY_PER_WEEK = 120;

/** How many days of bookings the export covers, ending yesterday. */
export const SALON_HISTORY_DAYS = 120;

/**
 * The salon's bookings export, Fresha-shaped, for the last
 * SALON_HISTORY_DAYS days to yesterday. Open Tuesday to Saturday; about
 * 22 appointments a day against 24 slots; a no-show about one in twelve
 * (one in seven on Tuesdays), a late cancellation about one in twenty-five;
 * six hundred clients over the months. The last two open days a stylist was off sick and
 * the book ran at half — the dip the anomaly layer catches. Deterministic
 * for a given day; no network, no model.
 */
export function salonBookingsCsv(today: string): string {
  const rand = prng(seedOf(`salon:${today}`));
  const addOn = prng(seedOf(`salon-add-on:${today}`));
  const lines = ["Ref #,Scheduled date,Time,Status,Service,Team member,Client email,Price"];
  const open = (day: string) => {
    const w = weekdayOf(day);
    return w >= 2 && w <= 6; // Tuesday..Saturday
  };
  const openDays: string[] = [];
  for (let i = SALON_HISTORY_DAYS; i >= 1; i--) {
    const day = shiftDay(today, -i);
    if (open(day)) openDays.push(day);
  }
  const sick = new Set(openDays.slice(-2));
  const staff = ["Aoife", "Sinead", "Marta"];
  let n = 0;
  for (const day of openDays) {
    const tuesday = weekdayOf(day) === 2;
    const booked = Math.round((sick.has(day) ? 11 : 20 + rand() * 5) * (tuesday ? 0.9 : 1));
    let prev: { service: string; status: string; client: number } | null = null;
    for (let k = 0; k < booked; k++) {
      n += 1;
      const picked = weighted(
        rand,
        SALON_SERVICES.map((s) => ({ item: s, weight: s.weight })),
      );
      const roll = rand();
      const rolled =
        roll < (tuesday ? 0.14 : 0.08)
          ? "No-show"
          : roll < (tuesday ? 0.18 : 0.12)
            ? "Late cancel"
            : roll < (tuesday ? 0.23 : 0.17)
              ? "Cancelled"
              : "Completed";
      const drawn = Math.floor(rand() * 600);
      // The add-on: the previous slot's colour client stays for a gloss.
      const stays: boolean =
        prev !== null &&
        (SALON_ADD_ON.after as readonly string[]).includes(prev.service) &&
        addOn() < SALON_ADD_ON.share;
      const service: { name: string; price_minor: number } = stays
        ? { name: SALON_ADD_ON.name, price_minor: SALON_ADD_ON.price_minor }
        : picked;
      const status: string = stays ? prev!.status : rolled;
      const client: number = stays ? prev!.client : drawn;
      const hour = 9 + Math.floor((k / booked) * 9);
      const minute = k % 2 === 0 ? "00" : "30";
      const price = (service.price_minor / 100).toFixed(2);
      lines.push(
        `L-${n},${day},${String(hour).padStart(2, "0")}:${minute},${status},${service.name},${staff[k % staff.length]},client${client}@lumen-clients.example,${price}`,
      );
      prev = stays ? null : { service: service.name, status, client };
    }
  }
  return lines.join("\n");
}

/* ── P5-17: the trade pipeline (Fernhill sells to cafés and shops too, 6.1a "both") ── */

export interface DemoDeal {
  company: string;
  contact: string;
  email: string;
  title: string;
  stage: "lead" | "qualified" | "proposal_sent" | "won" | "lost";
  /** Whole euros, or null for a deal with no value yet. */
  value: number | null;
  /** Days ago the deal was added and entered its stage (closed, for won and lost). */
  added: number;
  in_stage: number;
  next_step: string;
  /** Days from today; negative is overdue. Null = no date. */
  due: number | null;
  /** Days ago they last spoke; null = not recorded. */
  last_contact: number | null;
}

/**
 * Eleven trade deals: five open — one gone quiet with no next step, one
 * whose next step is overdue, one never spoken to — and six closed in the
 * last year (three won, three lost), enough for a measured win rate.
 */
export const DEMO_DEALS: readonly DemoDeal[] = [
  {
    company: "Café Nua",
    contact: "Aoife Brennan",
    email: "aoife@cafenua.example",
    title: "House mugs for the new Kilkenny café",
    stage: "proposal_sent",
    value: 4_800,
    added: 41,
    in_stage: 30,
    next_step: "",
    due: null,
    last_contact: 23,
  },
  {
    company: "The Long Table",
    contact: "Ciarán Walsh",
    email: "ciaran@thelongtable.example",
    title: "Dinner plates and bowls, 60 covers",
    stage: "qualified",
    value: 7_200,
    added: 34,
    in_stage: 18,
    next_step: "Send glaze test tiles",
    due: -6,
    last_contact: 14,
  },
  {
    company: "Hotel Saoirse",
    contact: "Saoirse Doyle",
    email: "saoirse@hotelsaoirse.example",
    title: "Breakfast service, 40 rooms",
    stage: "lead",
    value: 12_000,
    added: 9,
    in_stage: 9,
    next_step: "Visit with samples",
    due: 5,
    last_contact: 9,
  },
  {
    company: "Paper & Clay",
    contact: "Róisín Kelly",
    email: "roisin@paperandclay.example",
    title: "Christmas restock, bud vase trios",
    stage: "proposal_sent",
    value: 2_600,
    added: 20,
    in_stage: 6,
    next_step: "Confirm the delivery date",
    due: 3,
    last_contact: 2,
  },
  {
    company: "Kilkenny Design Collective",
    contact: "",
    email: "hello@kdcollective.example",
    title: "Shared stand at the spring fair",
    stage: "lead",
    value: null,
    added: 12,
    in_stage: 12,
    next_step: "",
    due: null,
    last_contact: null,
  },
  {
    company: "Ballyhale Farm Shop",
    contact: "Declan Nolan",
    email: "declan@ballyhalefarm.example",
    title: "Own-label honey jars",
    stage: "won",
    value: 1_800,
    added: 70,
    in_stage: 40,
    next_step: "",
    due: null,
    last_contact: 40,
  },
  {
    company: "The Tea Rooms, Inistioge",
    contact: "Mary Phelan",
    email: "mary@tearooms.example",
    title: "Teapots and cups",
    stage: "won",
    value: 3_400,
    added: 130,
    in_stage: 95,
    next_step: "",
    due: null,
    last_contact: 95,
  },
  {
    company: "Marble City Bakery",
    contact: "Tom Ryan",
    email: "tom@marblecitybakery.example",
    title: "Cake stands",
    stage: "won",
    value: 950,
    added: 180,
    in_stage: 150,
    next_step: "",
    due: null,
    last_contact: 150,
  },
  {
    company: "Gallery 7",
    contact: "Niamh Daly",
    email: "niamh@gallery7.example",
    title: "Exhibition pieces",
    stage: "lost",
    value: 5_200,
    added: 85,
    in_stage: 60,
    next_step: "",
    due: null,
    last_contact: 62,
  },
  {
    company: "Nore Hotel",
    contact: "Brian Keane",
    email: "brian@norehotel.example",
    title: "Room trays",
    stage: "lost",
    value: 8_800,
    added: 160,
    in_stage: 120,
    next_step: "",
    due: null,
    last_contact: 121,
  },
  {
    company: "Castle Yard Café",
    contact: "Eimear Fitz",
    email: "eimear@castleyard.example",
    title: "Takeaway cups",
    stage: "lost",
    value: 2_100,
    added: 230,
    in_stage: 200,
    next_step: "",
    due: null,
    last_contact: 201,
  },
];

/** The trade list as the owner keeps it: a spreadsheet the pipeline import reads. */
export function dealsCsv(today: string, rows: readonly DemoDeal[] = DEMO_DEALS): string {
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const stage = {
    lead: "Lead",
    qualified: "Qualified",
    proposal_sent: "Proposal sent",
    won: "Won",
    lost: "Lost",
  };
  return [
    "Company,Contact,Email,Deal,Stage,Value,Next step,Next step due,Last contact",
    ...rows.map((r) =>
      [
        r.company,
        r.contact,
        r.email,
        r.title,
        stage[r.stage],
        r.value === null ? "" : String(r.value),
        r.next_step,
        r.due === null ? "" : shiftDay(today, r.due),
        r.last_contact === null ? "" : shiftDay(today, -r.last_contact),
      ]
        .map(quote)
        .join(","),
    ),
  ].join("\n");
}
