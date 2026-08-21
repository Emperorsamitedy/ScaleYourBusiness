// Confidence — data-model-v1.md §3.1, valued per §8.1.
//
// A branded number in [0, 1]. Base values by source and their adjustment
// rules live in §8.1 and are implemented by the sessions that assign
// confidence (parser, connectors, inference) — this module only guarantees
// that no out-of-range confidence can exist.

declare const ConfidenceBrand: unique symbol;

export type Confidence = number & { readonly [ConfidenceBrand]: true };

export class InvalidConfidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConfidenceError";
  }
}

export function confidence(value: number): Confidence {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidConfidenceError(`confidence must be in [0, 1], got ${value}`);
  }
  return value as Confidence;
}
