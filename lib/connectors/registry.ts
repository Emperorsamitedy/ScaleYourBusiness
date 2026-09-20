// Provider lookup. One entry per ProviderId; the type system refuses a
// registry entry whose provider is not also in the scope registry, so a
// connector cannot exist without declared scopes.

import type { Provider } from "./provider";
import { fixtureProvider } from "./providers/fixture";
import { ga4Provider } from "./providers/ga4";
import { metaAdsProvider } from "./providers/meta-ads";
import { shopifyProvider } from "./providers/shopify";
import { stripeProvider } from "./providers/stripe";
import { woocommerceProvider } from "./providers/woocommerce";
import type { ProviderId } from "./scopes";

const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  fixture: fixtureProvider,
  stripe: stripeProvider,
  shopify: shopifyProvider,
  woocommerce: woocommerceProvider,
  ga4: ga4Provider,
  meta_ads: metaAdsProvider,
};

const overrides = new Map<ProviderId, Provider>();

export function getProvider(id: ProviderId): Provider {
  return overrides.get(id) ?? PROVIDERS[id];
}

/**
 * Test seam: swap a provider for an in-memory one, such as a store whose
 * HTTP is recorded responses. Returns the restore function, for afterEach.
 * Nothing outside tests calls this.
 */
export function overrideProviderForTests(id: ProviderId, provider: Provider): () => void {
  if (provider.id !== id) {
    throw new Error(`an override for "${id}" must be a "${id}" provider, got "${provider.id}"`);
  }
  overrides.set(id, provider);
  return () => {
    overrides.delete(id);
  };
}
