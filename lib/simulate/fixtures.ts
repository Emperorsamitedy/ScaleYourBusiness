// Fixtures for the simulator's tests (feature 36): a business with
// nothing measured or stated, and one with every input in place. Plain
// data, no database — the model is pure.

import type { CampaignRaw, SimInputs } from "./model";

export const AS_OF = "2026-10-22";

const shift = (day: string, by: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + by);
  return d.toISOString().slice(0, 10);
};

/** n measured days ending yesterday, each spending `spend` and returning `value`. */
export function campaign(
  ref: string,
  n: number,
  spend: number,
  value: number | ((i: number) => number),
) {
  return {
    ref,
    name: `Campaign ${ref}`,
    currency: "EUR",
    days: Array.from({ length: n }, (_, i) => ({
      date: shift(AS_OF, -(i + 1)),
      spend_minor: spend,
      value_minor: typeof value === "number" ? value : value(i),
    })),
  } satisfies CampaignRaw;
}

/** A business with nothing measured and nothing stated. */
export function bare(): SimInputs {
  return {
    as_of: AS_OF,
    currency: "EUR",
    margin: { computed_pct: null, computed_formula: null, stated_pct: null, stated_basis: null },
    aov: { measured_daily_minor: [], stated_minor: null, stated_basis: null },
    email: {
      posture: "enabled",
      contacts: 0,
      segments: [
        {
          key: "lapsed",
          label: "Lapsed customers",
          members: 0,
          emailable: 0,
          order_values_minor: [],
        },
        { key: "vip", label: "Best customers", members: 0, emailable: 0, order_values_minor: [] },
      ],
      past: [],
    },
    ads: { connected: false, campaigns: [], ceiling: null },
    content: {
      platform: null,
      publish_connected: false,
      posts: [],
      social_channels: 0,
      per_week: 3,
      analytics_connected: false,
      social_sessions: null,
      window_interactions: null,
    },
    site: {
      days: [],
      stated_orders_monthly: null,
      stated_sessions_monthly: null,
      stated_basis: null,
    },
    cross_check: {
      email: { line: "Not measured yet.", checked: 0, inside: 0 },
      ads: { line: "Not measured yet.", checked: 0, inside: 0 },
      content: { line: "Not measured yet.", checked: 0, inside: 0 },
    },
  };
}

/** A business with every input measured or stated. */
export function full(): SimInputs {
  const x = bare();
  x.margin = {
    computed_pct: 40,
    computed_formula: "price − cost",
    stated_pct: 50,
    stated_basis: "STATED",
  };
  x.aov.measured_daily_minor = Array.from({ length: 20 }, (_, i) => 4_000 + i * 100);
  x.email.segments[0] = {
    key: "lapsed",
    label: "Lapsed customers",
    members: 60,
    emailable: 40,
    order_values_minor: [3_000, 4_000, 5_000, 6_000, 7_000],
  };
  x.email.past = [
    {
      kind: "winback",
      sent_on: "2026-08-01",
      sent: 12,
      delivered: 12,
      bounced: 0,
      harmed: 1,
      measured: 12,
      returned: 4,
    },
  ];
  x.ads = {
    connected: true,
    campaigns: [campaign("120000001", 28, 1_000, 3_000), campaign("120000002", 28, 2_000, 1_000)],
    ceiling: null,
  };
  x.content = {
    platform: "instagram",
    publish_connected: true,
    posts: [
      { reach: 400, interactions: 20 },
      { reach: 600, interactions: 30 },
      { reach: 800, interactions: 40 },
      { reach: 1_000, interactions: 50 },
    ],
    social_channels: 1,
    per_week: 3,
    analytics_connected: true,
    social_sessions: 90,
    window_interactions: 300,
  };
  x.site.days = Array.from({ length: 20 }, () => ({ sessions: 100, orders: 2 }));
  return x;
}
