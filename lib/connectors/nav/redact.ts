// The redaction filter for NAV credentials — the multi-market spec §E.5:
// "never written to logs, traces, error reports or analytics".
//
// Two layers. First, NAV code never puts a credential into a log line,
// error message or thrown value (the connector's errors are fixed Hungarian
// and English sentences). Second, while credentials are in use they are
// registered here, and installNavRedaction() wraps console's writers so any
// line that would carry one — or a passwordHash, requestSignature or login
// element from a NAV request — is rewritten before it leaves the process.
// A test captures console output around a failing call and greps it.

const live = new Set<string>();
const REDACTED = "[redacted]";

export function rememberSecret(s: string): void {
  if (s.length >= 4) live.add(s);
}

export function forgetSecret(s: string): void {
  live.delete(s);
}

const XML_FIELDS = /<((?:[\w-]+:)?(?:passwordHash|requestSignature|login))(\s[^>]*)?>[^<]*<\/\1>/g;

/** Rewrite a string so no live credential or NAV auth element survives in it. */
export function redact(text: string): string {
  let out = text.replace(
    XML_FIELDS,
    (_m, name: string, attrs = "") => `<${name}${attrs}>${REDACTED}</${name}>`,
  );
  for (const s of live) out = out.split(s).join(REDACTED);
  return out;
}

function redactArg(a: unknown): unknown {
  if (typeof a === "string") return redact(a);
  if (a instanceof Error) {
    const e = new Error(redact(a.message));
    e.name = a.name;
    return e;
  }
  if (a !== null && typeof a === "object") {
    try {
      return JSON.parse(redact(JSON.stringify(a)));
    } catch {
      return "[unprintable]";
    }
  }
  return a;
}

/** The writers this filter made — by identity, so a replacement that copies properties isn't mistaken for one. */
const wrappedWriters = new WeakSet<(...a: unknown[]) => void>();

/**
 * Wrap console.log/info/warn/error/debug so every line passes redact().
 * Idempotent per writer: a writer already wrapped is left alone, and a
 * writer replaced since (a test spy, a logging library) is wrapped again.
 * lib/connectors/nav/vault.ts installs it on import and again before each
 * use of credentials, so no NAV credential is ever opened without it.
 */
export function installNavRedaction(): void {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const current = console[level] as (...a: unknown[]) => void;
    if (wrappedWriters.has(current)) continue;
    const original = current.bind(console);
    const wrapped = (...args: unknown[]) => original(...args.map(redactArg));
    wrappedWriters.add(wrapped);
    console[level] = wrapped;
  }
}
