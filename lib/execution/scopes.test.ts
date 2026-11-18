// P3-08 — the execution fence's build gates. Three promises, each a
// failing test away from being broken: the registry matches its pinned
// allowlist exactly (rule 13), every write scope is honestly named as a
// write, and nothing touches a money surface (rule 18). Plus the
// measurement registry's own audit re-asserted from this side — rule 9
// does not get weaker because rule 13 arrived.

import { describe, expect, it } from "vitest";
import { SCOPE_REGISTRY, auditRegistry, isWriteCapable } from "../connectors/scopes";
import {
  EXECUTION_SCOPE_REGISTRY,
  HOMED_SCOPES,
  VENDOR_MISNAMED_AD_FIELDS,
  VENDOR_MISNAMED_READS,
  auditExecutionRegistry,
  isExecutionProviderId,
  touchesMoneySurface,
} from "./scopes";

describe("P3-08 — the pinned allowlist (rule 13)", () => {
  it("THE BUILD GATE: the registry is exactly this, and nothing else", () => {
    // Changing the registry means changing this literal too — a
    // deliberate, reviewed edit. That is the point.
    expect(EXECUTION_SCOPE_REGISTRY).toEqual({
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
      // P3-20f, 2026-10-14: Meta, the first real write provider. Two
      // consents, so publishing never implies ad management.
      meta_publish: {
        label: "Meta publishing (Facebook Page and Instagram)",
        write_scopes: [
          "pages_manage_posts",
          "instagram_content_publish",
          "instagram_manage_contents",
        ],
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
      // 2026-11-08, the owner's override ("should be done by today"): TikTok
      // posting. One write scope, one IRREVERSIBLE op (TikTok's API can't
      // delete a post), two consent lines on that scope: what SYB may do, and
      // what it can't undo.
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
      meta_ads: {
        label: "Meta ad management",
        write_scopes: ["ads_management"],
        readback_scopes: [],
        operations: [
          { op: "pause_campaign", description: "Pause a running campaign.", reversible: true },
          { op: "resume_campaign", description: "Resume a paused campaign.", reversible: true },
          {
            op: "set_daily_budget",
            description: "Change a campaign's daily budget, within the approved bounds.",
            reversible: true,
          },
          {
            // Irreversible: Meta's DELETED and ARCHIVED are both permanent.
            op: "create_campaign_paused",
            description: "Create a new campaign in the paused state.",
            reversible: false,
          },
          // P3-54, 2026-10-26: ad creation, edited in deliberately. Every
          // create is irreversible for the campaign's reason; the four run as
          // steps of create_ad_paused, never on their own.
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
          // Going live resumes the ad and ad set before the campaign; undo pauses them.
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
      // 2026-11-08, the owner: all remaining features "should be done by today".
      // TikTok Ads, read and act, one consent (TikTok can't separate them).
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
      // P4-15, 2026-10-19: campaign email from SYB's own Resend account. One
      // write scope, one irreversible op, and two consent lines on that scope
      // — what SYB may do, and what it will never do.
      email_campaign: {
        label: "Campaign email",
        write_scopes: ["email.send_marketing"],
        readback_scopes: [],
        operations: [
          {
            // Irreversible: a sent email can't be recalled.
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
      // P6-04, 2026-11-08 (rule 27 amended by the owner): an approved purchase
      // order, emailed to the supplier. One write scope, one irreversible op
      // (a sent email can't be recalled), and two consent lines: what SYB
      // may do, and what it never does (edit, cancel or pay an order, or sign
      // in to a supplier's system).
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
      // P5-16b, 2026-11-16 (rule 29 amended by the owner): an approved deal
      // follow-up, emailed to the deal's contact. One write scope, one
      // irreversible op, and two consent lines: what SYB may do, and the
      // consent and unsubscribe it always honours.
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
      // I-45a, 2026-11-01: Google Business Profile, held as a write consent
      // because its only scope can write. Lifted by the owner 2026-11-16:
      // two reversible ops, each only after an approval of the exact change.
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
      // P2-20 / P3-22, 2026-11-08 (owner: "build google ads too"): Google Ads,
      // held as a write consent because its only scope can write. Three
      // reversible ops, run only through the engine after an approval.
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
      // D6, 2026-11-16 (owner: "make all these automatic…", then "Shopify
      // first"): Shopify store changes, a separate app and consent from the
      // read connector. Three reversible ops, none near checkout (rule 18).
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
    });
  });

  it("P2-20, I-45a: the homed scopes are exactly this", () => {
    expect(HOMED_SCOPES).toEqual({
      "https://www.googleapis.com/auth/adwords": "google_ads",
      "https://www.googleapis.com/auth/business.manage": "google_business_reviews",
    });
  });

  it("P2-20: adwords is write-shaped by the measurement audit's own vocabulary, and accepted under google_ads", () => {
    expect(isWriteCapable("https://www.googleapis.com/auth/adwords")).toBe(true);
    expect(
      auditExecutionRegistry(
        {
          google_ads: {
            write_scopes: ["https://www.googleapis.com/auth/adwords"],
            operations: [{ op: "pause_campaign", description: "", reversible: true }],
          },
        },
        isWriteCapable,
      ),
    ).toEqual([]);
    const holders = Object.entries(EXECUTION_SCOPE_REGISTRY)
      .filter(([, spec]) =>
        [...spec.write_scopes, ...spec.readback_scopes].some(
          (s) => (s as string) === "https://www.googleapis.com/auth/adwords",
        ),
      )
      .map(([id]) => id);
    expect(holders).toEqual(["google_ads"]);
  });

  it("P2-20: adwords planted under another provider, or as a readback, is caught", () => {
    const violations = auditExecutionRegistry(
      {
        meta_ads: { write_scopes: ["https://www.googleapis.com/auth/adwords"], operations: [] },
        sneaky: {
          write_scopes: ["publish_things"],
          readback_scopes: ["https://www.googleapis.com/auth/adwords"],
          operations: [],
        },
      },
      isWriteCapable,
    );
    expect(violations).toEqual([
      {
        provider: "meta_ads",
        value: "https://www.googleapis.com/auth/adwords",
        reason: "fenced_scope_elsewhere",
      },
      {
        provider: "sneaky",
        value: "https://www.googleapis.com/auth/adwords",
        reason: "readback_write_shaped",
      },
      {
        provider: "sneaky",
        value: "https://www.googleapis.com/auth/adwords",
        reason: "fenced_scope_elsewhere",
      },
    ]);
  });

  it("P2-20: the measurement audit refuses adwords — Google Ads never enters the read registry", () => {
    expect(auditRegistry({ google_ads: ["https://www.googleapis.com/auth/adwords"] })).toEqual([
      {
        provider: "google_ads",
        scope: "https://www.googleapis.com/auth/adwords",
        reason: "write_capable",
      },
    ]);
    const readScopes = Object.values(SCOPE_REGISTRY).flat() as string[];
    expect(readScopes.some((s) => s.includes("adwords"))).toBe(false);
    expect(Object.keys(SCOPE_REGISTRY)).not.toContain("google_ads");
    expect(auditRegistry()).toEqual([]);
  });

  it("P2-20: Google Ads' ops are only pauses, resumes and budgets, each reversible", () => {
    const ops = EXECUTION_SCOPE_REGISTRY.google_ads.operations.map((o) => [o.op, o.reversible]);
    expect(ops).toEqual([
      ["pause_campaign", true],
      ["resume_campaign", true],
      ["set_daily_budget", true],
    ]);
  });

  it("I-45a lifted: business.manage is accepted under its own provider, with its two ops", () => {
    const homed = auditExecutionRegistry(
      {
        google_business_reviews: {
          write_scopes: ["https://www.googleapis.com/auth/business.manage"],
          readback_scopes: [],
          operations: [{ op: "reply_to_review", description: "", reversible: true }],
        },
      },
      isWriteCapable,
    );
    expect(homed).toEqual([]);
    // And it sits under no other provider in the real registry.
    const holders = Object.entries(EXECUTION_SCOPE_REGISTRY)
      .filter(([, spec]) =>
        [...spec.write_scopes, ...spec.readback_scopes].some(
          (s) => (s as string) === "https://www.googleapis.com/auth/business.manage",
        ),
      )
      .map(([id]) => id);
    expect(holders).toEqual(["google_business_reviews"]);
  });

  it("I-45a: business.manage planted under another provider, or as a readback, is caught", () => {
    const violations = auditExecutionRegistry(
      {
        meta_publish: {
          write_scopes: ["https://www.googleapis.com/auth/business.manage"],
          operations: [],
        },
        sneaky: {
          write_scopes: ["publish_things"],
          readback_scopes: ["https://www.googleapis.com/auth/business.manage"],
          operations: [],
        },
      },
      isWriteCapable,
    );
    expect(violations).toEqual([
      {
        provider: "meta_publish",
        value: "https://www.googleapis.com/auth/business.manage",
        reason: "fenced_scope_elsewhere",
      },
      {
        provider: "sneaky",
        value: "https://www.googleapis.com/auth/business.manage",
        reason: "readback_write_shaped",
      },
      {
        provider: "sneaky",
        value: "https://www.googleapis.com/auth/business.manage",
        reason: "fenced_scope_elsewhere",
      },
    ]);
  });

  it("I-45a lifted: Google Business Profile's ops are a reply and an hours move, each reversible", () => {
    const ops = EXECUTION_SCOPE_REGISTRY.google_business_reviews.operations.map((o) => [
      o.op,
      o.reversible,
    ]);
    expect(ops).toEqual([
      ["reply_to_review", true],
      ["set_regular_hours", true],
    ]);
  });

  it("I-45a: the measurement audit still refuses business.manage — rule 9 is unchanged", () => {
    expect(isWriteCapable("https://www.googleapis.com/auth/business.manage")).toBe(true);
    expect(
      auditRegistry({ google_business: ["https://www.googleapis.com/auth/business.manage"] }),
    ).toEqual([
      {
        provider: "google_business",
        scope: "https://www.googleapis.com/auth/business.manage",
        reason: "write_capable",
      },
    ]);
    const readScopes = Object.values(SCOPE_REGISTRY).flat() as string[];
    expect(readScopes.some((s) => s.includes("business.manage"))).toBe(false);
    expect(auditRegistry()).toEqual([]);
  });

  it("P3-20f: the vendor-misnamed reads are exactly this, each with its reason", () => {
    expect(VENDOR_MISNAMED_READS).toEqual({
      instagram_manage_insights:
        "Meta's name; it grants reads of Instagram account and media insights, nothing else",
    });
  });

  it("P3-54: the vendor-misnamed ad-write fields are exactly this, each with its reason", () => {
    expect(VENDOR_MISNAMED_AD_FIELDS).toEqual({
      billing_event:
        "Meta's name for the unit an ad set is charged per; sent only as IMPRESSIONS, and it sets no billing, funding or payment method",
    });
    // Still money vocabulary: only the pinned exemption lets it through the field audit.
    expect(touchesMoneySurface("billing_event")).toBe(true);
  });

  it("P3-54: every create on Meta's ad side is labelled irreversible; only pauses, resumes and budgets undo", () => {
    const ops = EXECUTION_SCOPE_REGISTRY.meta_ads.operations;
    for (const o of ops) {
      if (/^(create_|upload_)/.test(o.op)) expect(o.reversible, o.op).toBe(false);
      if (/^(pause_|resume_)|budget/.test(o.op)) expect(o.reversible, o.op).toBe(true);
    }
  });

  it("P3-20f: a misnamed read is exempt only as a readback scope — as a write scope, or any other 'manage' readback, still fails", () => {
    const violations = auditExecutionRegistry(
      {
        planted: {
          write_scopes: ["publish_things"],
          readback_scopes: ["instagram_manage_insights", "instagram_manage_comments"],
          operations: [],
        },
      },
      isWriteCapable,
    );
    expect(violations).toEqual([
      { provider: "planted", value: "instagram_manage_comments", reason: "readback_write_shaped" },
    ]);
    // It is still a write by the vocabulary, so it can never sit in the
    // measurement registry: the read side's audit refuses it there.
    expect(isWriteCapable("instagram_manage_insights")).toBe(true);
  });

  it("TikTok posting: the write scope is honestly a write, the readbacks are reads, and video.manage is never asked for", () => {
    expect(isWriteCapable("video.publish")).toBe(true);
    expect(isWriteCapable("user.info.basic")).toBe(false);
    expect(isWriteCapable("video.list")).toBe(false);
    const all = Object.values(EXECUTION_SCOPE_REGISTRY).flatMap(
      (spec) => [...spec.write_scopes, ...spec.readback_scopes] as string[],
    );
    // video.manage edits and deletes posts made by OTHER apps too; no consent here names it.
    expect(all).not.toContain("video.manage");
    expect(all).not.toContain("video.upload");
    // Planted, it would be caught as a readback: it is write-shaped by name.
    expect(
      auditExecutionRegistry(
        {
          planted: {
            write_scopes: ["video.publish"],
            readback_scopes: ["video.manage"],
            operations: [],
          },
        },
        isWriteCapable,
      ),
    ).toEqual([{ provider: "planted", value: "video.manage", reason: "readback_write_shaped" }]);
  });

  it("TikTok posting: the one op is labelled irreversible — TikTok's API has no delete", () => {
    const ops = EXECUTION_SCOPE_REGISTRY.tiktok_publish.operations;
    expect(ops.map((o) => o.op)).toEqual(["publish_tiktok_video"]);
    for (const o of ops) expect(o.reversible).toBe(false);
  });

  it("every consent line explains a registered scope, and every scope has one", () => {
    for (const spec of Object.values(EXECUTION_SCOPE_REGISTRY)) {
      // P4-15: a scope may carry more than one line (email_campaign's promise
      // and its restraint), so the comparison is over the SET of scopes named.
      const consented = [...new Set(spec.consent.map((c) => c.scope as string))].sort();
      expect(consented).toEqual([...spec.write_scopes].sort());
    }
  });

  it("P4-15: sending is write-shaped by the measurement audit's own vocabulary", () => {
    expect(isWriteCapable("email.send_marketing")).toBe(true);
    expect(isWriteCapable("read_email_stats")).toBe(false);
  });

  it("no execution scope appears in the measurement registry — a read connection cannot gain a write scope by name collision", () => {
    const readScopes = new Set(Object.values(SCOPE_REGISTRY).flat() as string[]);
    for (const spec of Object.values(EXECUTION_SCOPE_REGISTRY)) {
      for (const scope of spec.write_scopes) {
        expect(readScopes.has(scope)).toBe(false);
      }
    }
  });
});

describe("P3-08 — honest naming and the money fence", () => {
  it("THE BUILD GATE: zero violations, judged by the measurement audit's own write vocabulary", () => {
    expect(auditExecutionRegistry(EXECUTION_SCOPE_REGISTRY, isWriteCapable)).toEqual([]);
  });

  it("a read-shaped write scope is caught — disguises fail the build", () => {
    const violations = auditExecutionRegistry(
      {
        sneaky: {
          write_scopes: ["read_content_v2"],
          operations: [],
        },
      },
      isWriteCapable,
    );
    expect(violations).toEqual([
      { provider: "sneaky", value: "read_content_v2", reason: "not_write_shaped" },
    ]);
  });

  it("P3-20b: a write-shaped READBACK scope is caught — readback scopes are reads, and the money fence covers them too", () => {
    const violations = auditExecutionRegistry(
      {
        planted: {
          write_scopes: ["publish_things"],
          readback_scopes: ["read_insights", "manage_pages", "read_payment_history"],
          operations: [],
        },
      },
      isWriteCapable,
    );
    expect(violations).toEqual([
      { provider: "planted", value: "manage_pages", reason: "readback_write_shaped" },
      { provider: "planted", value: "read_payment_history", reason: "money_surface" },
    ]);
  });

  it("rule 18: a checkout- or payment-touching scope or op is caught, planted deliberately", () => {
    const violations = auditExecutionRegistry(
      {
        planted: {
          write_scopes: ["write_checkout_settings"],
          operations: [{ op: "update_payment_method", description: "", reversible: true }],
        },
      },
      isWriteCapable,
    );
    expect(violations.map((v) => v.reason).sort()).toEqual(["money_surface", "op_money_surface"]);
  });

  it("recognises the money-surface vocabulary broadly", () => {
    for (const term of [
      "manage_checkout",
      "write_payments",
      "edit_billing_profile",
      "create_payout",
      "update_card_on_file",
      "create_charge",
      "issue_refund",
      "write_bank_details",
      "manage_invoices",
      "edit_subscription_plan",
      "act_123/funding_source_details",
    ]) {
      expect(touchesMoneySurface(term)).toBe(true);
    }
    expect(touchesMoneySurface("publish_post")).toBe(false);
    expect(touchesMoneySurface("write_fixture_state")).toBe(false);
  });

  it("isExecutionProviderId gates unknown providers", () => {
    expect(isExecutionProviderId("fixture")).toBe(true);
    expect(isExecutionProviderId("stripe")).toBe(false);
    expect(isExecutionProviderId("")).toBe(false);
  });
});

describe("P3-08 — rule 9 re-asserted from the write side", () => {
  it("the MEASUREMENT registry still contains zero write-capable scopes", () => {
    expect(auditRegistry()).toEqual([]);
  });
});
