// The pure half of execution connections — P3-20b, rule 13. No database:
// a provider's connect-time verifier (P3-20g) refuses by name with these
// before touching any asset, and the providers map stays importable
// without a database. connections.ts re-exports all of it.

import type { ExecutionProviderId } from "./scopes";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";

export class ExecutionConnectionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ExecutionConnectionError";
    this.status = status;
  }
}

/** What the platform reports a credential was granted. */
export interface CredentialProof {
  granted_scopes: readonly string[];
}

/**
 * Proves a credential with its platform and reports the scopes it holds.
 * D1's Meta provider supplies one that asks /me/permissions; tests supply
 * one that answers what the test says. The verifier never stores anything.
 */
export type CredentialVerifier = (secret: string) => Promise<CredentialProof>;

export function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** EXACTLY what an execute connection for this provider must hold. */
export function expectedExecutionScopes(provider: ExecutionProviderId): readonly string[] {
  const spec = EXECUTION_SCOPE_REGISTRY[provider];
  return unique([...spec.write_scopes, ...spec.readback_scopes]);
}

/**
 * Connect-time check: granted must equal the expected set. Throws naming
 * every extra scope (too many) and every missing one (too few).
 */
export function verifyExecutionScopes(
  provider: ExecutionProviderId,
  granted: readonly string[],
): void {
  const expected = expectedExecutionScopes(provider);
  const have = unique(granted);
  const extra = have.filter((s) => !expected.includes(s));
  const missing = expected.filter((s) => !have.includes(s));
  if (extra.length === 0 && missing.length === 0) return;
  const label = EXECUTION_SCOPE_REGISTRY[provider].label;
  const parts: string[] = [];
  if (extra.length > 0) {
    parts.push(
      `granted ${extra.map((s) => `"${s}"`).join(", ")} which the consent does not name (one scope too many is a refusal, not a bonus)`,
    );
  }
  if (missing.length > 0) {
    parts.push(`missing ${missing.map((s) => `"${s}"`).join(", ")} which the consent requires`);
  }
  throw new ExecutionConnectionError(
    `refusing to connect ${label} for execution: ${parts.join("; ")}`,
    422,
  );
}
