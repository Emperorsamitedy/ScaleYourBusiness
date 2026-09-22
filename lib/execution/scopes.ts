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
// The only provider today is the in-repo fixture — Session B proves the
// engine against it before any real platform lands (the Phase 2 order:
// fixture first, Stripe second). Real write providers arrive with
// Session D, each behind its own owner decision.

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
  operations: readonly ExecutionOperationSpec[];
  consent: readonly ExecutionConsentEntry[];
}

export const EXECUTION_SCOPE_REGISTRY = {
  /** The in-repo fixture executor (Session B) — no external account, no network. */
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
];

export function touchesMoneySurface(value: string): boolean {
  return MONEY_SURFACE.some((pattern) => pattern.test(value));
}

export interface ExecutionScopeViolation {
  provider: string;
  value: string;
  reason: "money_surface" | "not_write_shaped" | "empty" | "op_money_surface";
}

/**
 * The build-failing audit for the WRITE side. isWriteCapable comes from
 * the measurement audit (lib/connectors/scopes) — the same vocabulary
 * that refuses writes there requires them here.
 */
export function auditExecutionRegistry(
  registry: Record<
    string,
    { write_scopes: readonly string[]; operations: readonly ExecutionOperationSpec[] }
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
