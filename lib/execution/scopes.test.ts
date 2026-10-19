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
        ],
        consent: [
          {
            scope: "ads_management",
            grant: "ads_management",
            why: "SYB may pause, resume or change the daily budget of campaigns, and create new campaigns paused. SYB will never touch billing or payment methods.",
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
    });
  });

  it("P3-20f: the vendor-misnamed reads are exactly this, each with its reason", () => {
    expect(VENDOR_MISNAMED_READS).toEqual({
      instagram_manage_insights:
        "Meta's name; it grants reads of Instagram account and media insights, nothing else",
    });
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
