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
   * Meta ad management (P3-20f). Creating a campaign is the one
   * irreversible op: Meta's DELETED and ARCHIVED states are both
   * permanent, so a campaign once created cannot be un-created. Billing,
   * funding and payment methods are fenced by the money audit below.
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
    ],
    consent: [
      {
        scope: "ads_management",
        grant: "ads_management",
        why: "SYB may pause, resume or change the daily budget of campaigns, and create new campaigns paused. SYB will never touch billing or payment methods.",
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

export function touchesMoneySurface(value: string): boolean {
  return MONEY_SURFACE.some((pattern) => pattern.test(value));
}

export interface ExecutionScopeViolation {
  provider: string;
  value: string;
  reason:
    "money_surface" | "not_write_shaped" | "empty" | "op_money_surface" | "readback_write_shaped";
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
  }
  return violations;
}

// Local default so this module has no import cycle; the test wires in
// the real isWriteCapable from lib/connectors/scopes and both must agree.
function requireWriteVocabulary(scope: string): boolean {
  return /write|publish|create|update|manage|edit|delete|modify/i.test(scope);
}
