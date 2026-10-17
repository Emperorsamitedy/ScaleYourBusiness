// What a log line may say about an error — the security review of 2026-10-17.
//
// `String(error)` of a Drizzle query error is "Failed query: <sql>\nparams:
// <values>": the bound values, which are emails, chat text, ticket answers.
// Logs are kept, shipped and read by more people than the database is, and
// rule 22 says they hold ids and hashes only. This keeps an error useful to
// whoever is debugging — its kind, the database's own code and message, the
// SQL shape — and drops the values.

const MAX_MESSAGE = 300;

function redact(message: string): string {
  // Drizzle appends the bound values after "params:"; nothing after it is kept.
  const cut = message.split(/\n?\s*params:/i)[0] ?? "";
  return cut.length > MAX_MESSAGE ? `${cut.slice(0, MAX_MESSAGE)}…` : cut;
}

export interface SafeErrorFacts {
  error_name: string;
  error_message: string;
  /** The database's own error code (e.g. 23505), when there is one. */
  error_code?: string;
}

/** The loggable facts of an error: its name, a redacted message, a database code. Never the bound values. */
export function logSafeError(error: unknown): SafeErrorFacts {
  if (!(error instanceof Error)) {
    return { error_name: "unknown", error_message: redact(String(error)) };
  }
  const cause = (error as { cause?: unknown }).cause as
    { code?: unknown; message?: unknown } | undefined;
  const code =
    typeof (error as { code?: unknown }).code === "string"
      ? ((error as { code?: string }).code as string)
      : typeof cause?.code === "string"
        ? cause.code
        : undefined;
  // A query error's cause is the driver's own message ("duplicate key …"),
  // which names the constraint, not the values — more useful than the SQL.
  const message =
    typeof cause?.message === "string" && /failed query/i.test(error.message)
      ? cause.message
      : error.message;
  return {
    error_name: error.name,
    error_message: redact(message),
    ...(code ? { error_code: code } : {}),
  };
}
