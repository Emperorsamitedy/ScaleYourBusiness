// The scope registry and its audit — P2-04, rule 9.
//
// "Read-only connections to the places your numbers already live" is a
// sentence on the landing page, so it has to be a property of the code.
// This file is the single place scopes are declared, per provider, and
// two checks make the promise enforceable:
//
//   1. auditRegistry() — every registered scope must be read-only. Its
//      test fails the build the moment anyone adds a write-capable scope
//      here (scopes.test.ts).
//   2. verifyGrantedScopes() — at connect time, what the provider actually
//      granted must be a subset of the registry. A provider granting MORE
//      than asked is a connect failure, not a shrug: an over-permissive
//      key the owner pasted by mistake is refused before it is stored.
//
// Provider entries beyond the fixture land with their sessions, each
// after reading that provider's current documentation (TASKS-PHASE2.md:
// scope names are verified at build time, not trusted from the plan).

export const SCOPE_REGISTRY = {
  /** The in-repo fixture connector (P2-06) — no external account, no network. */
  fixture: ["read_revenue", "read_orders", "read_ad_spend"],
  /**
   * Stripe (P2-07). Stripe cannot report a restricted key's permissions
   * through its API, so these are CAPABILITIES proven at connect time by
   * calling the endpoint, not permission names Stripe hands back. One per
   * entry in STRIPE_READ_ENDPOINTS (providers/stripe.ts); stripe.test.ts
   * fails if the two lists drift apart.
   */
  stripe: ["read_balance_transactions"],
  /**
   * Shopify (P2-14). Real scope handles, reported back by Shopify for every
   * token, so registry membership is a genuine check. read_all_orders is
   * optional: it needs Shopify's approval, and without it history is 60 days.
   */
  shopify: ["read_orders", "read_products", "read_all_orders"],
  /**
   * WooCommerce (P2-17). Like Stripe, its keys cannot report their access
   * level, so these are capabilities proven at connect time, one per entry
   * in WOO_READ_ENDPOINTS (providers/woocommerce.ts).
   */
  woocommerce: ["read_orders", "read_products"],
  /**
   * Google Analytics 4 (P2-18). The one OAuth scope the connector's signed
   * token asks for, read back from Google's tokeninfo at connect time.
   */
  ga4: ["https://www.googleapis.com/auth/analytics.readonly"],
  /**
   * Meta Ads (P2-19). The Graph API reports a token's granted permissions;
   * anything beyond ads_read refuses the connection.
   */
  meta_ads: ["ads_read"],
  /**
   * Google Search Console (P2-33). The read-only scope, read back from
   * tokeninfo at connect time like GA4's. Name checked in Google's docs
   * 2026-10-13.
   */
  search_console: ["https://www.googleapis.com/auth/webmasters.readonly"],
  /**
   * Square (P2-28). POST /oauth2/token/status reports a token's scopes, so
   * registry membership is a real check. Permission names from Square's
   * docs, checked 2026-10-13.
   *
   * Bookings (specs/bookings.md §2), added 2026-10-22 deliberately: the two
   * read-only Bookings permissions, APPOINTMENTS_READ and the seller-level
   * APPOINTMENTS_ALL_READ, so a salon's or gym's appointments are measured.
   * Square's permissions table lists them as the read side of ListBookings;
   * the write side (APPOINTMENTS_WRITE, APPOINTMENTS_ALL_WRITE) stays out,
   * and the audit would refuse it. Optional: a payments-only token still
   * connects, and bookings are read only when both are granted.
   */
  square: ["PAYMENTS_READ", "MERCHANT_PROFILE_READ", "APPOINTMENTS_READ", "APPOINTMENTS_ALL_READ"],
} as const satisfies Record<string, readonly string[]>;

export interface ScopeGuideEntry {
  /** The registry capability this entry explains. */
  scope: string;
  /** What the owner selects in the provider's own dashboard. */
  grant: string;
  /** Why it is needed, in one plain sentence. */
  why: string;
}

/**
 * The connect screen's instructions ARE the registry, rendered (P2-07): one
 * entry per registered scope, and a test fails if either list gains a member
 * the other lacks.
 */
export const SCOPE_GUIDE: Readonly<
  Record<keyof typeof SCOPE_REGISTRY, readonly ScopeGuideEntry[]>
> = {
  fixture: [
    {
      scope: "read_revenue",
      grant: "Revenue: Read",
      why: "Daily revenue, for the monthly figure.",
    },
    {
      scope: "read_orders",
      grant: "Orders: Read",
      why: "Daily order count, for the monthly figure.",
    },
    {
      scope: "read_ad_spend",
      grant: "Ad spend: Read",
      why: "Daily ad spend, for the monthly figure.",
    },
  ],
  stripe: [
    {
      scope: "read_balance_transactions",
      // Name confirmed 2026-10-12 in Stripe's own dashboard: the restricted-
      // key permission is called "Balance" and its endpoint list includes
      // /v1/balance_transactions. The first live connection is still pending
      // (on production); if it fails, connecting shows Stripe's own 403
      // message naming the permission, verbatim.
      grant: "Balance: Read",
      why: "Your payment history, meaning every charge and refund, which is where monthly revenue and order count come from.",
    },
  ],
  shopify: [
    {
      scope: "read_orders",
      grant: "read_orders",
      why: "Your orders, which is where daily revenue, order count and units sold come from.",
    },
    {
      scope: "read_products",
      grant: "read_products",
      why: "Your product list, so each product can be matched to what you sell.",
    },
    {
      scope: "read_all_orders",
      grant: "read_all_orders (optional, Shopify must approve it)",
      why: "Orders older than 60 days, for a full year of history. Without it I read the last 60 days.",
    },
  ],
  woocommerce: [
    {
      scope: "read_orders",
      grant: "Read access (covers orders)",
      why: "Your orders, which is where daily revenue, order count and units sold come from.",
    },
    {
      scope: "read_products",
      grant: "Read access (covers products)",
      why: "Your product list, so each product can be matched to what you sell.",
    },
  ],
  ga4: [
    {
      scope: "https://www.googleapis.com/auth/analytics.readonly",
      grant: "Viewer role on the property",
      why: "Sessions per day and per channel, which is where measured website traffic comes from. Viewer can read reports and change nothing.",
    },
  ],
  meta_ads: [
    {
      scope: "ads_read",
      grant: "ads_read",
      why: "Daily ad spend and the purchases Meta attributes to your ads. Nothing that could edit a campaign.",
    },
  ],
  search_console: [
    {
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      grant: "Restricted permission on the property is enough",
      why: "The Google searches your site appeared for, how often, and how often people clicked. It can read reports and change nothing.",
    },
  ],
  square: [
    {
      scope: "PAYMENTS_READ",
      grant: "PAYMENTS_READ",
      why: "Every payment your tills took, card and cash rung up in Square, which is where daily and hourly takings come from.",
    },
    {
      scope: "MERCHANT_PROFILE_READ",
      grant: "MERCHANT_PROFILE_READ",
      why: "Your list of locations, so payments from every till are read, not just the main one.",
    },
    {
      scope: "APPOINTMENTS_READ",
      grant: "APPOINTMENTS_READ (optional, for bookings)",
      why: "Your appointments. Which were kept, which were no-shows or cancelled, and whether clients came back, but not their notes.",
    },
    {
      scope: "APPOINTMENTS_ALL_READ",
      grant: "APPOINTMENTS_ALL_READ (optional, with the one above)",
      why: "Your appointments. Square needs this with the one above to read every booking at your locations, not only ones made through Ledgerline. It can't change a booking.",
    },
  ],
};

export type ProviderId = keyof typeof SCOPE_REGISTRY;

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(SCOPE_REGISTRY, value);
}

/** All registered provider ids, for iteration. */
export const PROVIDER_IDS: readonly ProviderId[] = Object.keys(SCOPE_REGISTRY) as ProviderId[];

// Anything a provider might call a write. Deliberately broad: a scope that
// trips this by accident ("read_write_log"?) costs a rename in the
// registry; a write scope that slips past costs the landing's promise.
const WRITE_CAPABLE = [
  /write/i,
  /manage/i,
  /admin/i,
  /delete/i,
  /create/i,
  /update/i,
  /modify/i,
  /edit/i,
  /publish/i,
  // P4-15: sending email is a write (migration 0048 mirrors it in the trigger).
  /send/i,
  /full[_.-]?access/i,
  /^\*$/,
  /^all$/i,
];

export function isWriteCapable(scope: string): boolean {
  return WRITE_CAPABLE.some((pattern) => pattern.test(scope));
}

export interface ScopeViolation {
  provider: string;
  scope: string;
  reason: "write_capable" | "not_in_registry" | "empty";
}

/**
 * The build-failing audit: returns every registered scope that is not
 * read-only. An empty array is the only acceptable answer.
 */
export function auditRegistry(
  registry: Record<string, readonly string[]> = SCOPE_REGISTRY,
): ScopeViolation[] {
  const violations: ScopeViolation[] = [];
  for (const [provider, scopes] of Object.entries(registry)) {
    for (const scope of scopes) {
      if (scope.trim() === "") violations.push({ provider, scope, reason: "empty" });
      else if (isWriteCapable(scope)) violations.push({ provider, scope, reason: "write_capable" });
    }
  }
  return violations;
}

export class ScopeViolationError extends Error {
  readonly violations: readonly ScopeViolation[];
  constructor(provider: string, violations: readonly ScopeViolation[]) {
    super(
      `refusing to connect ${provider}: ` +
        violations.map((v) => `"${v.scope}" (${v.reason.replace("_", " ")})`).join(", "),
    );
    this.name = "ScopeViolationError";
    this.violations = violations;
  }
}

/**
 * Connect-time check: the granted scopes must be non-empty, all read-only,
 * and all present in the registry for that provider. Throws
 * ScopeViolationError naming every offending scope, so the owner can see
 * exactly which permission to remove from the key they created.
 */
export function verifyGrantedScopes(provider: ProviderId, granted: readonly string[]): void {
  const registered: readonly string[] = SCOPE_REGISTRY[provider];
  const violations: ScopeViolation[] = [];
  for (const scope of granted) {
    if (isWriteCapable(scope)) {
      violations.push({ provider, scope, reason: "write_capable" });
    } else if (!registered.includes(scope)) {
      violations.push({ provider, scope, reason: "not_in_registry" });
    }
  }
  if (granted.length === 0) {
    violations.push({ provider, scope: "", reason: "empty" });
  }
  if (violations.length > 0) {
    throw new ScopeViolationError(provider, violations);
  }
}
