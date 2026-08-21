// Quantity — data-model-v1.md §3.3.
//
// A number with its unit attached. Unlike Money there is no closed unit
// vocabulary ("pcs", "kg", "hours", "m2", …) and no arithmetic here —
// nothing in Phase 0 adds quantities, and cross-unit arithmetic would need
// a conversion table this spec doesn't define. The constructor's job is to
// keep unitless or non-finite amounts out of the profile.

export interface Quantity {
  amount: number;
  /** "pcs", "kg", "hours", "m2", … — free-form but never empty. */
  unit: string;
}

export class InvalidQuantityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQuantityError";
  }
}

/** Validating constructor. Fractional amounts are legal (2.5 kg, 0.5 hours). */
export function quantity(amount: number, unit: string): Quantity {
  if (!Number.isFinite(amount)) {
    throw new InvalidQuantityError(`amount must be finite, got ${amount}`);
  }
  if (unit.trim() === "") {
    throw new InvalidQuantityError(
      "unit must not be empty — a bare number is not a quantity (rule 2: no bare values)",
    );
  }
  return { amount, unit };
}
