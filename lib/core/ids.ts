// Branded identifier types — data-model-v1.md §3.1–3.2.
//
// Branding stops a DocumentId from being passed where a FieldId is
// expected: structurally both are strings, so only a nominal brand makes
// the compiler catch the mix-up. Constructors validate non-emptiness and
// brand the value; deeper shape rules (FieldId paths, ULID formats, …)
// belong to the sessions that define those namespaces.

declare const IdBrand: unique symbol;

type Branded<B extends string> = string & { readonly [IdBrand]: B };

/** Stable field path, e.g. "revenue.monthly_current" (§3.1). */
export type FieldId = Branded<"FieldId">;
/** One stored field record — what superseded_by points at (§3.1). */
export type FieldRecordId = Branded<"FieldRecordId">;
/** e.g. "shopify", "meta_ads", "stripe" (§3.2). */
export type ConnectorId = Branded<"ConnectorId">;
/** An uploaded P&L, invoice, screenshot (§3.2). */
export type DocumentId = Branded<"DocumentId">;

export class InvalidIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdError";
  }
}

function makeId<T extends Branded<string>>(kind: string, value: string): T {
  if (value.trim() === "") {
    throw new InvalidIdError(`${kind} must not be empty`);
  }
  return value as T;
}

export const fieldId = (value: string): FieldId => makeId("FieldId", value);
export const fieldRecordId = (value: string): FieldRecordId => makeId("FieldRecordId", value);
export const connectorId = (value: string): ConnectorId => makeId("ConnectorId", value);
export const documentId = (value: string): DocumentId => makeId("DocumentId", value);
