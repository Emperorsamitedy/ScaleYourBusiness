// Database schema, defined table by table as the sessions land:
// profile tables in Session D, supersession in E, vocabularies in F,
// the decision log in G. Empty until Session D.
//
// Session E note: supersession requires the partial unique index
//   UNIQUE (profile_id, field_key) WHERE superseded_at IS NULL
// expressed as uniqueIndex(...).where(...) — confirm drizzle-kit
// round-trips it before building on it.

export {};
