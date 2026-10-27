// ┌──────────────────────────────────────────────────────────────────────┐
// │ THE REAL PROVIDER'S ADAPTER SLOT — NOT IMPLEMENTED, ON PURPOSE.       │
// │                                                                      │
// │ P3-53: the generation provider is not chosen. Build-sequence step 2  │
// │ ("get quotes") is still open, so there is no vendor, no price sheet  │
// │ and no key. MEDIA_PROVIDER=vendor selects this slot, and the slot    │
// │ says so: nothing is proposed, nothing is called, nothing is spent.   │
// │                                                                      │
// │ To fill it, once the owner picks a provider:                         │
// │   1. implement MediaProvider (./provider) here — estimate() from the │
// │      provider's published per-image / per-second price, in integer   │
// │      minor units with its currency; generate() sending the prompt    │
// │      AND FIXED_INSTRUCTION, a hard request timeout, the provider's    │
// │      own safety settings at their strictest                          │
// │   2. its key in .env.example and lib/env.ts (never in the repo)      │
// │   3. a fixture-proven test with fetch stubbed to fail if touched     │
// │   4. re-check the caps in ../generation.ts against the real prices   │
// └──────────────────────────────────────────────────────────────────────┘

import type { MediaProvider } from "./provider";
import { ProviderError } from "./provider";

export const VENDOR_NOT_CHOSEN =
  "the AI generation provider isn't chosen yet (its price quotes are still pending), so SYB can't generate media";

export const vendorMediaProvider: MediaProvider = {
  id: "vendor",
  unavailable: VENDOR_NOT_CHOSEN,
  estimate() {
    throw new ProviderError(VENDOR_NOT_CHOSEN);
  },
  async generate() {
    throw new ProviderError(VENDOR_NOT_CHOSEN);
  },
};
