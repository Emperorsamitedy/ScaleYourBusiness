// P2-04 / rule 9 — "Read-only scopes, forever."
//
// The landing page promises read-only connections in writing. The first
// test below is the one that keeps that promise honest: it fails the
// build the moment anyone adds a write-capable scope to the registry.
// It is not a style check — it is the enforcement mechanism the plan
// names as part of every connector's definition of done.

import { describe, expect, it } from "vitest";
import {
  PROVIDER_IDS,
  SCOPE_REGISTRY,
  ScopeViolationError,
  auditRegistry,
  isProviderId,
  isWriteCapable,
  verifyGrantedScopes,
} from "./scopes";

describe("P2-04 — the scope audit", () => {
  it("THE BUILD GATE: no registered scope anywhere is write-capable", () => {
    const violations = auditRegistry();
    expect(
      violations,
      `write-capable scopes in the registry: ${violations.map((v) => `${v.provider}.${v.scope}`).join(", ")}`,
    ).toEqual([]);
  });

  it("every provider declares at least one scope", () => {
    expect(PROVIDER_IDS.length).toBeGreaterThan(0);
    for (const provider of PROVIDER_IDS) {
      expect(SCOPE_REGISTRY[provider].length).toBeGreaterThan(0);
    }
  });

  it("catches a write scope planted in a registry", () => {
    const violations = auditRegistry({ evil: ["read_orders", "write_orders"] });
    expect(violations).toEqual([
      { provider: "evil", scope: "write_orders", reason: "write_capable" },
    ]);
  });

  it("recognises the write vocabulary providers actually use", () => {
    for (const scope of [
      "write_orders",
      "orders:write",
      "manage_pages",
      "admin",
      "delete_products",
      "create_charge",
      "products.update",
      "modify_campaigns",
      "edit_ads",
      "publish_posts",
      "full_access",
      "*",
      "all",
    ]) {
      expect(isWriteCapable(scope), scope).toBe(true);
    }
  });

  it("does not flag ordinary read scopes", () => {
    for (const scope of ["read_orders", "read_products", "analytics.readonly", "balance:read"]) {
      expect(isWriteCapable(scope), scope).toBe(false);
    }
  });

  it("isProviderId gates unknown providers", () => {
    expect(isProviderId("fixture")).toBe(true);
    expect(isProviderId("definitely_not_a_provider")).toBe(false);
  });
});

describe("P2-04 — connect-time verification", () => {
  it("accepts exactly what the registry declares", () => {
    expect(() => verifyGrantedScopes("fixture", [...SCOPE_REGISTRY.fixture])).not.toThrow();
  });

  it("accepts a subset — asking for less than allowed is fine", () => {
    expect(() => verifyGrantedScopes("fixture", ["read_orders"])).not.toThrow();
  });

  it("REFUSES a provider that granted more than we asked for", () => {
    // The plan's words: "a provider granting MORE than asked is a connect
    // failure, not a shrug".
    expect(() => verifyGrantedScopes("fixture", ["read_orders", "read_customers"])).toThrow(
      ScopeViolationError,
    );
  });

  it("refuses a write scope even before the registry check", () => {
    try {
      verifyGrantedScopes("fixture", ["read_orders", "write_orders"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ScopeViolationError);
      const violations = (error as ScopeViolationError).violations;
      expect(violations).toContainEqual({
        provider: "fixture",
        scope: "write_orders",
        reason: "write_capable",
      });
    }
  });

  it("refuses an empty grant — a credential with no scopes proves nothing", () => {
    expect(() => verifyGrantedScopes("fixture", [])).toThrow(ScopeViolationError);
  });

  it("names every offending scope, so the owner knows what to remove", () => {
    try {
      verifyGrantedScopes("fixture", ["write_orders", "admin"]);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).message).toContain("write_orders");
      expect((error as Error).message).toContain("admin");
    }
  });
});
