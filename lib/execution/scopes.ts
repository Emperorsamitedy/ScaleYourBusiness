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
// Google Ads (P2-20 / P3-22, 2026-11-08) is held the same way, because its
// only scope can write, but it runs three reversible ops through the engine.

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
        why: "ScaleX may publish posts to the Page you choose, and delete them again when you withdraw one.",
      },
      {
        scope: "instagram_content_publish",
        grant: "instagram_content_publish",
        why: "ScaleX may publish posts and Reels to the Instagram account you choose, each one only after you approve it.",
      },
      {
        scope: "instagram_manage_contents",
        grant: "instagram_manage_contents",
        why: "ScaleX may delete an Instagram post it published, so withdrawing one takes it down.",
      },
    ],
  },
  /**
   * TikTok posting (owner override 2026-11-08, "should be done by today",
   * lifting the 2026-09-30 deferral): an approved video, posted to the TikTok
   * account the owner signs in with, through the Content Posting API's
   * Direct Post. One write scope. TikTok's API has no delete for a post
   * (only video.manage, which also edits and deletes posts made by other
   * apps, and SYB never asks for it), so the one op is IRREVERSIBLE and
   * labelled so before approval: withdrawing means deleting it in the
   * TikTok app. The readback scopes are reads: who the account is, and the
   * public posts' counts (specs/tiktok-posting-api-v1.md).
   */
  tiktok_publish: {
    label: "TikTok posting",
    write_scopes: ["video.publish"],
    readback_scopes: ["user.info.basic", "video.list"],
    operations: [
      {
        op: "publish_tiktok_video",
        description:
          "Post one approved video to the TikTok account, with the privacy and interaction settings you chose for it.",
        reversible: false,
      },
    ],
    consent: [
      {
        scope: "video.publish",
        grant: "video.publish",
        why: "ScaleX may post the videos you approve to the TikTok account you sign in with, each with the privacy and settings you chose for it.",
      },
      {
        scope: "video.publish",
        grant: "video.publish",
        why: "TikTok doesn't let apps delete a post, so ScaleX can't take one down: to remove a post, delete it in the TikTok app.",
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
        why: "ScaleX may pause, resume or change the daily budget of campaigns, and create new campaigns, ad sets, creatives and ads paused, from posts you approve. ScaleX will never touch billing or payment methods.",
      },
    ],
  },
  /**
   * TikTok Ads (owner, 2026-11-08: all remaining features "should be done by
   * today", lifting P3-22's "TikTok deferred"). One consent for reading AND
   * acting, because TikTok can't separate them for one app: an advertiser
   * authorizes the app's whole permission list, and SYB's app must hold
   * Create and Update Campaigns (scope 201) to pause, resume or re-budget.
   * So the read is held here, as readback scopes, the I-45a way — never in
   * the measurement registry (rule 9 unchanged) — and fenced to GET
   * requests by lib/tiktok/read.test.ts. Names are SYB's for TikTok's
   * numeric scope ids (lib/tiktok/scopes.ts). Consolidated Report (44) also
   * lets an app create report tasks and subscriptions; SYB calls neither.
   * Nothing is created, so nothing is irreversible: no create op exists.
   */
  tiktok_ads: {
    label: "TikTok ad management",
    write_scopes: ["tiktok.create_and_update_campaigns"],
    readback_scopes: [
      "tiktok.read_ad_account_information",
      "tiktok.read_campaigns",
      "tiktok.consolidated_report",
    ],
    operations: [
      {
        op: "pause_campaign",
        description: "Pause a running TikTok campaign.",
        reversible: true,
      },
      {
        op: "resume_campaign",
        description: "Resume a paused TikTok campaign.",
        reversible: true,
      },
      {
        op: "set_daily_budget",
        description: "Change a TikTok campaign's daily budget, within the approved bounds.",
        reversible: true,
      },
    ],
    consent: [
      {
        scope: "tiktok.create_and_update_campaigns",
        grant: "Reporting and Ads Management, which TikTok grants together",
        why: "ScaleX reads each campaign's daily spend and the website purchases TikTok attributes to it, once a day.",
      },
      {
        scope: "tiktok.create_and_update_campaigns",
        grant: "Ads Management: Create and Update Campaigns",
        why: "ScaleX may pause, resume or change the daily budget of a campaign, each time only after you approve it. TikTok gives this together with reading, so ScaleX holds it as a separate consent you can revoke.",
      },
      {
        scope: "tiktok.create_and_update_campaigns",
        grant: "Ads Management: Create and Update Campaigns",
        why: "ScaleX never creates or deletes a campaign, and never touches billing or payment methods.",
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
        grant: "your consent here (ScaleX's own email service)",
        why: "ScaleX may send the campaigns you approve, from {sender}, to customers who explicitly agreed to hear from you.",
      },
      {
        scope: "email.send_marketing",
        grant: "your consent here (ScaleX's own email service)",
        why: "ScaleX will never email anyone who hasn't explicitly agreed, or who unsubscribed.",
      },
    ],
  },
  /**
   * Purchase orders (P6-04, rule 27 amended by the owner on 2026-11-08: "a
   * purchase order goes out only on a recorded yes"). An approved purchase
   * order is emailed to the supplier's address on file, from SYB's own
   * verified sending address under the business's name, with replies going
   * to the person who approved it. Like campaign email there is no owner
   * credential: each order carries its own approval of the exact supplier,
   * address and lines. A sent email can't be recalled, so the one op is
   * irreversible and labelled so before approval. SYB never edits, cancels
   * or pays an order, and never signs in to a supplier's system: there is
   * no op for any of it, and lib/purchasing/rule27.test.ts pins that.
   */
  purchase_order: {
    label: "Purchase order email",
    write_scopes: ["email.send_purchase_order"],
    readback_scopes: [],
    operations: [
      {
        op: "send_purchase_order",
        description:
          "Email one approved purchase order to the supplier's address on file, exactly as approved.",
        reversible: false,
      },
    ],
    consent: [
      {
        scope: "email.send_purchase_order",
        grant: "your approval of each order (ScaleX's own email service)",
        why: "ScaleX may email a purchase order you approved to the supplier named on it, at the address you gave, with replies going to you.",
      },
      {
        scope: "email.send_purchase_order",
        grant: "your approval of each order (ScaleX's own email service)",
        why: "ScaleX never edits, cancels or pays an order, and never signs in to a supplier's system.",
      },
    ],
  },
  /**
   * Deal follow-ups (P5-16b; rule 29 amended by the owner on 2026-11-16:
   * "make all these automatic all the owner should do is just approve").
   * An approved follow-up email, sent to the deal's one contact from SYB's
   * own email service under the business's name, with replies going to the
   * person who approved it. Like purchase orders there is no owner
   * credential: each email carries its own approval of the exact text. The
   * contact's consent is checked again at the moment of sending (rule 23),
   * and a sent email can't be recalled, so the one op is irreversible.
   */
  followup_email: {
    label: "Deal follow-up email",
    write_scopes: ["email.send_followup"],
    readback_scopes: [],
    operations: [
      {
        op: "send_followup",
        description:
          "Email one approved follow-up to the deal's contact, exactly as approved, checking their consent at the moment it goes.",
        reversible: false,
      },
    ],
    consent: [
      {
        scope: "email.send_followup",
        grant: "your approval of each email (ScaleX's own email service)",
        why: "ScaleX may send a follow-up email you approved, word for word, from its own email service under your business's name, with replies going to you.",
      },
      {
        scope: "email.send_followup",
        grant: "your approval of each email (ScaleX's own email service)",
        why: "ScaleX sends it only to a contact who explicitly agreed to hear from you, checked again at the moment it goes, and never to anyone who unsubscribed.",
      },
    ],
  },
  /**
   * Google Business Profile reviews (I-45a, owner decision 2026-11-01: "go
   * ahead with I-45a", then, asked how SYB should hold the permission: "as a
   * write consent"). Google offers ONE scope for the Business Profile APIs,
   * business.manage, and it can also reply to reviews and edit the listing.
   * So it sits here, as a write consent the owner grants and can revoke,
   * never in the measurement registry (rule 9 stays exactly as it was).
   *
   * I-45a lifted by the owner on 2026-11-16 ("make all these automatic all
   * the owner should do is just approve", then "Google review replies +
   * hours"): two ops, each run only through the engine after a recorded
   * approval of the exact change, and each reversible. lib/google-business's
   * client may send exactly these writes, from the executor alone
   * (client.test.ts holds it). HOMED_SCOPES keeps the scope to this provider.
   * A connection consented before these lines can't run either op
   * (lib/google-business/consent.ts, googleWriteConsentCurrent).
   */
  google_business_reviews: {
    label: "Google Business Profile",
    write_scopes: ["https://www.googleapis.com/auth/business.manage"],
    readback_scopes: [],
    operations: [
      {
        op: "reply_to_review",
        description:
          "Post the reply you approved, word for word, under one Google review; undo puts back the reply that was there before, or removes it.",
        reversible: true,
      },
      {
        op: "set_regular_hours",
        description:
          "Move one opening or closing time on one weekday of your Google listing, as approved; undo moves it back while it is still as ScaleX set it.",
        reversible: true,
      },
    ],
    consent: [
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "Google offers one permission for Business Profiles, and it lets an app post and change replies to your reviews and edit your listing as well as read them.",
      },
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "ScaleX reads your reviews with it once a day. ScaleX may post a reply you approved, word for word and labelled as written with AI assistance, and may change your listing's opening hours after you approve the exact change.",
      },
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "ScaleX never changes anything else on your listing, and never touches billing. Every reply and hours change can be undone from ScaleX.",
      },
      {
        scope: "https://www.googleapis.com/auth/business.manage",
        grant: "Google Business Profile (business.manage)",
        why: "You can revoke it here at any time, and ScaleX deletes the access it holds at once.",
      },
    ],
  },
  /**
   * Google Ads (P2-20 and P3-22's Google half; owner, 2026-11-08: "build
   * google ads too"). Google offers ONE scope for the Google Ads API,
   * adwords, and it can read and change everything in an ad account: there
   * is no read-only scope (Google's OAuth pages, read 2026-11-08). So it is
   * held here, as a write consent the owner grants and can revoke, and
   * NEVER in the measurement registry (rule 9 is unchanged, and its audit
   * refuses the scope by name). SYB reads spend with it daily through
   * lib/google-ads/client.ts, whose fence sends only Google's search
   * endpoints, and changes anything only through an approved proposal:
   * three reversible ops, each executed by the engine through
   * lib/execution/providers/google-ads.ts, the one file that may name a
   * mutate endpoint (google-ads fence test). HOMED_SCOPES keeps adwords to
   * this one provider.
   */
  google_ads: {
    label: "Google Ads",
    write_scopes: ["https://www.googleapis.com/auth/adwords"],
    readback_scopes: [],
    operations: [
      {
        op: "pause_campaign",
        description: "Pause a running Google Ads campaign.",
        reversible: true,
      },
      {
        op: "resume_campaign",
        description: "Resume a paused Google Ads campaign.",
        reversible: true,
      },
      {
        op: "set_daily_budget",
        description: "Change a Google Ads campaign's daily budget, within the approved bounds.",
        reversible: true,
      },
    ],
    consent: [
      {
        scope: "https://www.googleapis.com/auth/adwords",
        grant: "Google Ads (adwords)",
        why: "Google offers one permission for the Google Ads API, and it lets an app change your campaigns, budgets and ads as well as read them.",
      },
      {
        scope: "https://www.googleapis.com/auth/adwords",
        grant: "Google Ads (adwords)",
        why: "ScaleX reads your daily spend and results with it. ScaleX changes something only when you approve a proposal: pausing or resuming a campaign, or changing its daily budget by at most half. ScaleX never touches billing or payment methods.",
      },
      {
        scope: "https://www.googleapis.com/auth/adwords",
        grant: "Google Ads (adwords)",
        why: "You can revoke it here at any time, and ScaleX deletes the access it holds at once.",
      },
    ],
  },
  /**
   * Shopify store changes (D6; owner, 2026-11-16: "make all these automatic
   * all the owner should do is just approve", then "Shopify first" for shop
   * writes). A SEPARATE app and consent from the read-only Shopify
   * connection (rule 13): its token holds exactly these two write scopes,
   * which Shopify says also grant the matching reads, so nothing else is
   * declared beside them. Three reversible ops, each run by the engine
   * through lib/execution/providers/shopify.ts — the one file that may send
   * a Shopify mutation, and only the four it names (shopify-write.test.ts).
   * Checkout, payments, orders, customers, shipping, taxes and discounts
   * are untouchable (rule 18): no scope here reaches them, and the fence
   * refuses any document that names them.
   */
  shopify_write: {
    label: "Shopify store changes",
    write_scopes: ["write_products", "write_online_store_pages"],
    readback_scopes: [],
    operations: [
      {
        op: "update_page_body",
        description:
          "Replace the approved words on one of your store's pages; undo puts the page back while it is still as ScaleX left it.",
        reversible: true,
      },
      {
        op: "create_bundle",
        description:
          "Create the approved pair as one bundle product at the two items' full price; undo archives it, never deletes it.",
        reversible: true,
      },
      {
        op: "set_variant_price",
        description:
          "Mark an approved slow item down by the approved share, showing the old price as the compare-at price; undo puts both back.",
        reversible: true,
      },
    ],
    consent: [
      {
        scope: "write_products",
        grant: "Shopify: write_products",
        why: "ScaleX may create a bundle you approved and mark down an item you approved, by at most half and never below its cost. Each one can be undone from ScaleX.",
      },
      {
        scope: "write_online_store_pages",
        grant: "Shopify: write_online_store_pages",
        why: "ScaleX may change the words on one of your store's pages after you approve the exact change, and checks the page still loads afterwards.",
      },
      {
        scope: "write_products",
        grant: "Shopify: write_products",
        why: "ScaleX never touches checkout, payments, orders, customers, shipping, taxes or discounts, and never deletes anything.",
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
 * P2-20: scopes that may appear under ONE provider only, as a write scope.
 * The provider may run operations (approved proposals, through the engine);
 * what the fence keeps is the home. Pinned in scopes.test.ts; adding a line
 * is the same deliberate edit as adding a write scope. business.manage moved
 * here from the read-only fence when the owner lifted I-45a (2026-11-16).
 */
export const HOMED_SCOPES: Readonly<Record<string, string>> = {
  "https://www.googleapis.com/auth/adwords": "google_ads",
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
    /** A homed scope under any provider but its own, or as a readback. */
    | "fenced_scope_elsewhere";
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
    // P2-20, I-45a: a homed scope belongs to its one provider, as a write scope.
    for (const scope of spec.readback_scopes ?? []) {
      if (Object.prototype.hasOwnProperty.call(HOMED_SCOPES, scope))
        violations.push({ provider, value: scope, reason: "fenced_scope_elsewhere" });
    }
    for (const scope of spec.write_scopes) {
      if (
        Object.prototype.hasOwnProperty.call(HOMED_SCOPES, scope) &&
        HOMED_SCOPES[scope] !== provider
      )
        violations.push({ provider, value: scope, reason: "fenced_scope_elsewhere" });
    }
  }
  return violations;
}

// Local default so this module has no import cycle; the test wires in
// the real isWriteCapable from lib/connectors/scopes and both must agree.
function requireWriteVocabulary(scope: string): boolean {
  return /write|publish|create|update|manage|edit|delete|modify|send|\/auth\/adwords$/i.test(scope);
}
