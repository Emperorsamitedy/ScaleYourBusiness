// The smoke tests' shared furniture (scripts/smoke-*.ts): reading the
// command line, naming the database without its password, numbered
// PASS / FAIL lines, and a last line of defence that hides any secret
// value a line might carry. Pure apart from the print function handed in,
// so every rule here is pinned by scripts/smoke/common.test.ts.
//
// The smoke tests walk the real paths against whatever DATABASE_URL and
// keys the shell holds — production, when the owner runs them before
// launch. So each one names the database host first, refuses clearly when
// a key it needs is absent, and writes nothing without --yes.

export type Env = Readonly<Record<string, string | undefined>>;
export type Print = (line: string) => void;

/** Exit codes: everything passed; something failed; refused before doing anything. */
export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_REFUSED = 2;

export interface Args {
  flags: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
}

/** `--to a@b`, `--to=a@b` and bare `--yes`. Anything else is ignored. */
export function parseArgs(argv: readonly string[]): Args {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }
  return { flags, values };
}

/** Names of the keys that are absent or blank. */
export function missingKeys(env: Env, keys: readonly string[]): string[] {
  return keys.filter((k) => (env[k]?.trim() ?? "") === "");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type DatabaseTarget =
  | { ok: true; host: string; port: string; database: string; user: string; local: boolean }
  | { ok: false; reason: string };

/** Which database a DATABASE_URL names — host, port, database and user, never the password. */
export function databaseTarget(url: string | undefined): DatabaseTarget {
  if (url === undefined || url.trim() === "")
    return { ok: false, reason: "DATABASE_URL isn't set" };
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "DATABASE_URL isn't a URL I can read" };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, reason: "DATABASE_URL isn't a postgres URL" };
  }
  // libpq lets ?host= replace the authority's host; the override is the real target.
  const override = parsed.searchParams.get("host");
  const host = (override ?? parsed.hostname).replace(/^\[(.*)\]$/, "$1").toLowerCase();
  return {
    ok: true,
    host,
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "(default)",
    user: decodeURIComponent(parsed.username) || "(default)",
    local: host
      .split(",")
      .map((h) => h.trim())
      .every((h) => LOCAL_HOSTS.has(h)),
  };
}

/** The one line every smoke test opens with: which database, password masked. */
export function databaseLine(url: string | undefined): string {
  const t = databaseTarget(url);
  if (!t.ok) return `Database: ${t.reason}.`;
  return (
    `Database: ${t.host}:${t.port}/${t.database} as ${t.user}, password ***` +
    (t.local ? " (this machine)." : " — NOT this machine; production, if that's what you meant.")
  );
}

/**
 * Every value in the env that could be a secret: anything named like a key,
 * secret, token, DSN or password, and the database URL with its password.
 * Short values are skipped, so a flag like "on" never blanks out prose.
 */
export function secretValues(env: Env): string[] {
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(env)) {
    const value = raw?.trim() ?? "";
    if (value.length < 8) continue;
    if (/KEY|SECRET|TOKEN|DSN|PASSWORD|DATABASE_URL/.test(name)) out.add(value);
  }
  const db = env.DATABASE_URL?.trim();
  if (db) {
    try {
      const pw = decodeURIComponent(new URL(db).password);
      if (pw.length >= 4) out.add(pw);
    } catch {
      /* unreadable: the whole value is already hidden above */
    }
  }
  // Longest first, so a secret containing another is hidden whole.
  return [...out].sort((a, b) => b.length - a.length);
}

/** A line with every secret value replaced — the last line of defence, not the first. */
export function scrub(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join("[hidden]");
  return out;
}

/** Numbered PASS / FAIL lines, scrubbed, with a tally at the end. */
export class Report {
  private n = 0;
  private failed = 0;
  private readonly secrets: string[];

  constructor(
    private readonly print: Print,
    env: Env,
  ) {
    this.secrets = secretValues(env);
  }

  line(text: string): void {
    this.print(scrub(text, this.secrets));
  }

  pass(text: string): void {
    this.n += 1;
    this.line(`${this.n}. PASS  ${text}`);
  }

  fail(text: string): void {
    this.n += 1;
    this.failed += 1;
    this.line(`${this.n}. FAIL  ${text}`);
  }

  check(ok: boolean, passText: string, failText: string): boolean {
    if (ok) this.pass(passText);
    else this.fail(failText);
    return ok;
  }

  refuse(reason: string): number {
    this.line(`REFUSED  ${reason}`);
    this.line("Nothing was sent or written.");
    return EXIT_REFUSED;
  }

  /** The closing tally and the exit code it means. */
  finish(): number {
    this.line(
      this.failed === 0
        ? `All ${this.n} checks passed.`
        : `${this.failed} of ${this.n} checks failed.`,
    );
    return this.failed === 0 ? EXIT_PASS : EXIT_FAIL;
  }
}

const EMAIL_RE = /^[^\s@<>]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/;

/** A plain address, lowercased, or null. */
export function plainAddress(raw: string | undefined): string | null {
  const value = raw?.trim().toLowerCase() ?? "";
  return EMAIL_RE.test(value) ? value : null;
}

/** The address inside a From value ("Name <a@b>" or "a@b"), lowercased, or null. */
export function fromAddress(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  return plainAddress(/<([^<>]+)>\s*$/.exec(value)?.[1] ?? value);
}

/** The domain of an address or From value, or null. */
export function domainOf(raw: string | undefined): string | null {
  const address = fromAddress(raw);
  return address ? address.slice(address.indexOf("@") + 1) : null;
}

/**
 * RFC 2606 / RFC 6761: names reserved so that no real mailbox can exist
 * under them — the .test, .example, .invalid and .localhost top-level
 * domains, and example.com / .net / .org with their subdomains. An address
 * here can never belong to a real customer.
 */
export function isReservedTestAddress(raw: string | undefined): boolean {
  const address = plainAddress(raw);
  if (!address) return false;
  const domain = address.slice(address.indexOf("@") + 1);
  if (/\.(test|example|invalid|localhost)$/.test(domain)) return true;
  return /(^|\.)example\.(com|net|org)$/.test(domain);
}

/** An https origin from APP_URL, or null. */
export function httpsOrigin(raw: string | undefined): string | null {
  try {
    const url = new URL(raw?.trim() ?? "");
    return url.protocol === "https:" && url.username === "" && url.password === ""
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** SYB's own sending addresses: mail from them is dropped by the inbox, by design. */
export function ownSenderAddresses(env: Env): string[] {
  return [
    fromAddress(env.EMAIL_FROM) ?? "onboarding@resend.dev",
    fromAddress(env.CAMPAIGN_EMAIL_FROM),
  ].filter((a): a is string => a !== null);
}

/**
 * Run a smoke test from the command line: print to stdout, exit with its
 * code, and turn a crash into one scrubbed line rather than a stack that
 * may carry a query's values.
 */
export function runMain(env: Env, run: (print: Print) => Promise<number>): void {
  const secrets = secretValues(env);
  const print: Print = (line) => console.log(line);
  run(print)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      const e = error instanceof Error ? error : new Error(String(error));
      const cause = (e as { cause?: { message?: unknown } }).cause;
      const detail = typeof cause?.message === "string" ? cause.message : e.message;
      console.log(scrub(`CRASHED  ${e.name}: ${detail}`, secrets));
      process.exit(EXIT_FAIL);
    });
}
