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
    });
  });

  it("every consent line explains a registered scope, and every scope has one", () => {
    for (const spec of Object.values(EXECUTION_SCOPE_REGISTRY)) {
      const consented = spec.consent.map((c) => c.scope).sort();
      expect(consented).toEqual([...spec.write_scopes].sort());
    }
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
