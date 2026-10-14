// Provider resolution — P3-20a (Session D, layer D0).
//
// executions.provider is a string, and until now nothing mapped it back
// to the object that can undo it: the site route hard-coded the fixture
// site executor, which was honest for one provider and a trap for the
// second. This map is the one place a provider id becomes a provider.
//
// The map is typed Record<ExecutionProviderId, ExecutionProvider>, so a
// registry entry without a provider — or a provider without a registry
// entry — fails the build, not a request. Adding a real provider (Meta,
// D1) is one registry edit (the pinned-literal friction) and one line
// here.

import type { ExecutionProviderId } from "../scopes";
import { EXECUTION_SCOPE_REGISTRY, isExecutionProviderId } from "../scopes";
import type { ExecutionProvider } from "./fixture";
import { fixtureExecutor } from "./fixture";
import { fixtureSiteExecutor } from "./fixture-site";
import { metaAdsExecutor, metaPublishExecutor } from "./meta";

const PROVIDERS: Readonly<Record<ExecutionProviderId, ExecutionProvider>> = {
  fixture: fixtureExecutor,
  fixture_site: fixtureSiteExecutor,
  meta_publish: metaPublishExecutor,
  meta_ads: metaAdsExecutor,
};

export class UnknownExecutionProviderError extends Error {
  readonly status = 422;
  constructor(id: string) {
    super(`"${id}" is not a registered execution provider`);
    this.name = "UnknownExecutionProviderError";
  }
}

/** The provider object for a registry id. Unknown ids throw — never a silent fallback. */
export function executionProvider(id: string): ExecutionProvider {
  if (!isExecutionProviderId(id)) throw new UnknownExecutionProviderError(id);
  return PROVIDERS[id];
}

/** Every registered provider id, for iteration and the build gate. */
export const EXECUTION_PROVIDER_IDS: readonly ExecutionProviderId[] = Object.keys(
  EXECUTION_SCOPE_REGISTRY,
) as ExecutionProviderId[];
