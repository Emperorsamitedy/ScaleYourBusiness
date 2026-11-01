// The execution scope registry — P3-08, rules 13 and 18.
//
// Write access is its own consent, never an upgrade. This registry is
// the ONLY place write scopes are declared, one provider at a time,
// with the consent screen's wording carried as data the way SCOPE_GUIDE
// renders the read registry. Three properties are enforced by tests
// that fail the build:
//
//   1. The registry matches its pinned allowlist EXACTLY — adding a
//      scope or an operation is a deliberate, reviewed test edit, never
//      a drive-by (rule 13).
//   2. Every execution scope LOOKS like a write under the measurement
//      audit's own vocabulary. A write scope named to look read-only
//      would evade review; honest naming is enforced, not hoped for.
//   3. No scope and no operation touches a money surface — checkout,
//      payments, billing, payouts, cards (rule 18). At any approval
//      level, on any provider, ever.
//
// And the measurement registry keeps its own promise: its audit is
// re-asserted from this side, so no future merge can weaken rule 9
// while adding rule 13.
//
// The fixtures came first — Session B proved the engine against them
// before any real platform landed (the Phase 2 order: fixture first,
// Stripe second). Meta is the first real write provider (P3-20f, Session
// D, owner decision 2026-09-30), split in two so publishing and ad
// management are separate consents: `meta_publish` and `meta_ads`.
// Google Business Profile (I-45a, 2026-11-01) is the one consent held for
// READING: its only scope can write, so it lives here, with no operations.

export interface ExecutionConsentEntry {
  /** The registry scope this consent line explains. */
  scope: string;
  /** What the owner grants in the provider's own dashboard. */
  grant: string;
  /** What the system may do with it, in one plain sentence. */
  why: string;
}

export interface ExecutionOperationSpec {
  /** The operation id the engine accepts — a closed set per provider. */
  op: string;
  description: string;
  /** Has a stored undo. An op without one must be labelled before approval. */
  reversible: boolean;
}

export interface ExecutionProviderSpec {
  label: string;
  write_scopes: readonly string[];
  /**
   * Read-only scopes the SAME credential needs beside its writes — page
   * listing, insights for readback (D4). Declared here so an execute
   * connection is accepted with EXACTLY write_scopes ∪ readback_scopes
   * (P3-20b), and audited as reads: a write-shaped entry fails the build.
   */
  readback_scopes: readonly string[];
  operations: readonly ExecutionOperationSpec[];
  consent: readonly ExecutionConsentEntry[];
}

export const EXECUTION_SCOPE_REGISTRY = {
  /** The in-repo fixture executor (Session B) — no external account, no network. */
  fixture: {
    label: "Fixture (in-repo)",
    write_scopes: ["write_fixture_state"],
    readback_scopes: [],
    operations: [
      {
        op: "set_value",
        description: "Set a named value in the fixture store.",
        reversible: true,
      },
      {
        op: "append_note",
        description: "Append an entry the fixture cannot unwrite.",
        reversible: false,
      },
    ],
    consent: [
      {
        scope: "write_fixture_state",
        grant: "Fixture: Write",
        why: "Lets the engine change fixture values, so every guard can be proven without a real account.",
      },
    ],
  },
  /** The in-repo fixture SITE (Session F) — a stand-in theme API. */
  fixture_site: {
    label: "Fixture site (in-repo)",
    write_scopes: ["write_site_content"],
    readback_scopes: [],
    operations: [
      {
        op: "apply_site_change",
        description: "Replace one page's content on the fixture site.",
        reversible: true,
      },
    ],
    consent: [
      {
        scope: "write_site_content",
        grant: "Fixture site: Write content",
        why: "Lets the engine apply an approved page change, so preview, undo and auto-rollback are provable without a real platform.",
      },
    ],
  },
  /**
   * Meta publishing (P3-20f): a Facebook Page and its linked Instagram
   * account. Every publish is undone by deleting the post (P3-21c). The
   * readback scopes let the same token read the posts' reach (P3-23a).
   */
  meta_publish: {
    label: "Meta publishing (Facebook Page and Instagram)",
    write_scopes: ["pages_manage_posts", "instagram_content_publish", "instagram_manage_contents"],
    readback_scopes: [
      "pages_show_list",
      "pages_read_engagement",
      "read_insights",
      "instagram_basic",
      "instagram_manage_insights",
    ],
    operations: [
      {
        op: "publish_page_post",
        description: "Publish an approved text or link post to the Facebook Page.",
        reversible: true,
      },
      {
        op: "publish_page_photo",
        description: "Publish an approved photo post to the Facebook Page.",
        reversible: true,
      },
      {
        op: "publish_page_video",
        description: "Publish an approved video or Reel to the Facebook Page.",
        reversible: true,
      },
      {
        op: "publish_ig_media",
        description: "Publish an approved post, carousel or Reel to the Instagram account.",
        reversible: true,
      },
    ],
    consent: [
      {
        scope: "pages_manage_posts",
        grant: "pages_manage_posts",
        why: "SYB may publish posts to the Page you choose, and delete them again when you withdraw one.",
      },
      {
        scope: "instagram_content_publish",
        grant: "instagram_content_publish",
        why: "SYB may publish posts and Reels to the Instagram account you choose, each one only after you approve it.",
      },
      {
        scope: "instagram_manage_contents",
        grant: "instagram_manage_contents",
        why: "SYB may delete an Instagram post it published, so withdrawing one takes it down.",
      },
    ],
  },
  /**
   * Meta ad management (P3-20f). Creating anything is irreversible: Meta's
   * DELETED and ARCHIVED states are both permanent, so a campaign, ad set,
   * creative or ad once created cannot be un-created (P3-54 adds the last
   * three and the video upload, each labelled so). Billing, funding and
   * payment methods are fenced by the money audit below.
   */
  meta_ads: {
    label: "Meta ad management",
    write_scopes: ["ads_management"],
    readback_scopes: [],
    operations: [
      {
        op: "pause_campaign",
        description: "Pause a running campaign.",
        reversible: true,
      },
      {
        op: "resume_campaign",
        description: "Resume a paused campaign.",
        reversible: true,
      },
      {
        op: "set_daily_budget",
        description: "Change a campaign's daily budget, within the approved bounds.",
        reversible: true,
      },
      {
        op: "create_campaign_paused",
        description: "Create a new campaign in the paused state.",
        reversible: false,
      },
      // P3-54 (Session K), added deliberately: ad creation. Every create is
      // irreversible for the same reason as the campaign's — Meta's DELETED
      // and ARCHIVED are permanent — so nothing created can be un-created,
      // only paused. The four steps run inside create_ad_paused, one after
      // another, each journaled; none runs on its own.
      {
        op: "upload_ad_video",
        description: "Upload an approved item's video to the ad account, for its ad.",
        reversible: false,
      },
      {
        op: "create_adset_paused",
        description:
          "Create an ad set in the paused state: its daily budget, schedule, placements and audience.",
        reversible: false,
      },
      {
        op: "create_adcreative",
        description:
          "Create an ad creative from an approved item's media and caption, carrying its AI disclosure.",
        reversible: false,
      },
      {
        op: "create_ad_paused",
        description:
          "Create an ad in the paused state, with its campaign, ad set and creative, each created paused.",
        reversible: false,
      },
      // Going live (P3-54) is a separate approval: resume_campaign resumes the
      // ad and its ad set first. Undo pauses them again.
      { op: "resume_adset", description: "Resume a paused ad set.", reversible: true },
      { op: "pause_adset", description: "Pause a running ad set.", reversible: true },
      { op: "resume_ad", description: "Resume a paused ad.", reversible: true },
      { op: "pause_ad", description: "Pause a running ad.", reversible: true },
    ],
    consent: [
      {
        scope: "ads_management",
        grant: "ads_management",
        why: "SYB may pause, resume or change the daily budget of campaigns, and create new campaigns, ad sets, creatives and ads paused, from posts you approve. SYB will never touch billing or payment methods.",
      },
    ],
  },
  /**
   * Campaign email (P4-15, Phase 4 Session F): an approved campaign, sent
   * from SYB's OWN Resend account — never the owner's — to the contacts
   * whose explicit consent is checked again at the moment of each send
   * (rule 23). There is no owner credential: the execute connection is the
   * owner's recorded consent plus the sender identity, and holds no secret.
   * A sent email can't be recalled, so the one op is irreversible and
   * labelled so before approval. `{sender}` is filled with the sender
   * identity where the consent is shown and hashed (lib/execution/
   * email-consent.ts). The scope's two lines are a promise and a restraint.
   */
  email_campaign: {
    label: "Campaign email",
    write_scopes: ["email.send_marketing"],
    readback_scopes: [],
    operations: [
      {
        op: "send_campaign",
        description:
          "Send an approved campaign email to the customers who explicitly agreed to hear from you, each one checked again at the moment it goes.",
        reversible: false,
      },
    ],
    consent: [
      {
        scope: "email.send_marketing",
        grant: "your consent here (SYB's own email service)",
        why: "SYB may send the campaigns you approve, from {sender}, to customers who explicitly agreed to hear from you.",
      },
      {
        scope: "email.send_marketing",
        grant: "your consent here (SYB's own email service)",
        why: "SYB will never email anyone who hasn't explicitly agreed, or who unsubscribed.",
      },
    ],
  },
  /**
   * Google Business Profile reviews (I-45a, owner decision 2026-11-01: "go
   * ahead with I-45a", then, asked how SYB should hold the permission: "as a
   * write consent"). Google offers ONE scope for the Business Profile APIs,
   * business.manage, and it can also reply to reviews and edit the listing.
   * So it sits here, as a write consent the owner grants and can revoke,
   * never in the measurement registry (rule 9 stays exactly as it was). SYB
   * uses it ONLY to read reviews: there are NO operations, so the engine has
   * nothing it could run with it, and lib/google-business's client can send
   * GET only, to a fixed list of read endpoints (client.test.ts holds it).
   * FENCED_SCOPES below keeps the scope to this one provider.
   */
  google_business_reviews: {
    label: "Google Business Profile reviews",
    write_scopes: ["https://www.googleapis.com/auth/business.manage"],
    readback_scopes: [],
    operations: [],
    consent: [
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "Google offers one permission for Business Profiles, and it lets an app post and change replies to your reviews and edit your listing as well as read them.",
      },
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "SYB uses it only to read your reviews. SYB never posts a reply or changes your listing: suggested replies stay drafts you post yourself.",
      },
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "You can revoke it here at any time, and SYB deletes the access it holds at once.",
      },
    ],
  },
} as const satisfies Record<string, ExecutionProviderSpec>;

export type ExecutionProviderId = keyof typeof EXECUTION_SCOPE_REGISTRY;

export function isExecutionProviderId(value: string): value is ExecutionProviderId {
  return Object.prototype.hasOwnProperty.call(EXECUTION_SCOPE_REGISTRY, value);
}

/** Rule 18's vocabulary. Broad on purpose — a false positive costs a
 * rename; a money-surface write that slips past costs the rule. */
const MONEY_SURFACE = [
  /checkout/i,
  /payment/i,
  /billing/i,
  /payout/i,
  /card/i,
  /charge/i,
  /refund/i,
  /bank/i,
  /invoice/i,
  /subscription/i,
  /funding/i,
];

/**
 * Read permissions a vendor named with write vocabulary. Each is exempt
 * from readback_write_shaped ONLY as a readback scope and is pinned in
 * scopes.test.ts with its reason, so adding one is the same deliberate
 * edit as adding a write scope. Every other "manage" readback still fails.
 */
export const VENDOR_MISNAMED_READS: Readonly<Record<string, string>> = {
  instagram_manage_insights:
    "Meta's name; it grants reads of Instagram account and media insights, nothing else",
};

/**
 * Ad-write FIELD names a vendor made with money vocabulary, exempt from the
 * rule-18 field audit (meta.test.ts) only as the one value pinned beside
 * them in adWriteViolation. Pinned in scopes.test.ts with its reason, the
 * same deliberate edit as VENDOR_MISNAMED_READS. P3-54: Meta REQUIRES
 * billing_event on every ad set; SYB sends only IMPRESSIONS.
 */
export const VENDOR_MISNAMED_AD_FIELDS: Readonly<Record<string, string>> = {
  billing_event:
    "Meta's name for the unit an ad set is charged per; sent only as IMPRESSIONS, and it sets no billing, funding or payment method",
};

export function touchesMoneySurface(value: string): boolean {
  return MONEY_SURFACE.some((pattern) => pattern.test(value));
}

/**
 * I-45a: scopes that may appear under ONE provider only, and only as a
 * write scope of a provider with no operations: the permission is held as
 * a consent, and used for reads alone. Pinned in scopes.test.ts; adding a
 * line is the same deliberate edit as adding a write scope.
 */
export const FENCED_SCOPES: Readonly<Record<string, string>> = {
  "https://www.googleapis.com/auth/business.manage": "google_business_reviews",
};

export interface ExecutionScopeViolation {
  provider: string;
  value: string;
  reason:
    | "money_surface"
    | "not_write_shaped"
    | "empty"
    | "op_money_surface"
    | "readback_write_shaped"
    /** I-45a: a fenced scope under any provider but its own, or as a readback. */
    | "fenced_scope_elsewhere"
    /** I-45a: the fenced scope's provider declares an operation; it may only read. */
    | "fenced_provider_operation";
}

/**
 * The build-failing audit for the WRITE side. isWriteCapable comes from
 * the measurement audit (lib/connectors/scopes) — the same vocabulary
 * that refuses writes there requires them here, and forbids them again
 * among the readback scopes (P3-20b): a readback scope is a read.
 */
export function auditExecutionRegistry(
  registry: Record<
    string,
    {
      write_scopes: readonly string[];
      readback_scopes?: readonly string[];
      operations: readonly ExecutionOperationSpec[];
    }
  > = EXECUTION_SCOPE_REGISTRY,
  isWriteCapable: (scope: string) => boolean = requireWriteVocabulary,
): ExecutionScopeViolation[] {
  const violations: ExecutionScopeViolation[] = [];
  for (const [provider, spec] of Object.entries(registry)) {
    for (const scope of spec.write_scopes) {
      if (scope.trim() === "") violations.push({ provider, value: scope, reason: "empty" });
      else if (touchesMoneySurface(scope))
        violations.push({ provider, value: scope, reason: "money_surface" });
      else if (!isWriteCapable(scope))
        violations.push({ provider, value: scope, reason: "not_write_shaped" });
    }
    for (const scope of spec.readback_scopes ?? []) {
      if (scope.trim() === "") violations.push({ provider, value: scope, reason: "empty" });
      else if (touchesMoneySurface(scope))
        violations.push({ provider, value: scope, reason: "money_surface" });
      else if (
        isWriteCapable(scope) &&
        !Object.prototype.hasOwnProperty.call(VENDOR_MISNAMED_READS, scope)
      )
        violations.push({ provider, value: scope, reason: "readback_write_shaped" });
    }
    for (const operation of spec.operations) {
      if (touchesMoneySurface(operation.op))
        violations.push({ provider, value: operation.op, reason: "op_money_surface" });
    }
    // I-45a: a fenced scope belongs to its one provider, as a write scope.
    for (const scope of spec.readback_scopes ?? []) {
      if (Object.prototype.hasOwnProperty.call(FENCED_SCOPES, scope))
        violations.push({ provider, value: scope, reason: "fenced_scope_elsewhere" });
    }
    for (const scope of spec.write_scopes) {
      const owner = Object.prototype.hasOwnProperty.call(FENCED_SCOPES, scope)
        ? FENCED_SCOPES[scope]
        : undefined;
      if (owner === undefined) continue;
      if (owner !== provider) {
        violations.push({ provider, value: scope, reason: "fenced_scope_elsewhere" });
      } else {
        for (const operation of spec.operations) {
          violations.push({ provider, value: operation.op, reason: "fenced_provider_operation" });
        }
      }
    }
  }
  return violations;
}

// Local default so this module has no import cycle; the test wires in
// the real isWriteCapable from lib/connectors/scopes and both must agree.
function requireWriteVocabulary(scope: string): boolean {
  return /write|publish|create|update|manage|edit|delete|modify|send/i.test(scope);
}
