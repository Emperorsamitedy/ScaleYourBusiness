// The demo seed's safety catch (scripts/seed-demo.ts): it writes a whole
// fictional business, so it must only ever run against a database on this
// machine. Pure, so the rule is pinned by a test rather than by hope.

/** The only hosts the demo seed will write to. */
export const LOCAL_DATABASE_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

export type DatabaseHostVerdict = { ok: true; host: string } | { ok: false; reason: string };

/** Hostname without the brackets an IPv6 literal wears inside a URL. */
function bare(host: string): string {
  return host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
}

/**
 * Is this DATABASE_URL a database on this machine? Refuses anything it
 * cannot read with certainty — a missing URL, an unparseable one, or a
 * `host=` query override (libpq lets it replace the authority's host)
 * that is not local itself.
 */
export function localDatabaseHost(url: string | undefined): DatabaseHostVerdict {
  if (url === undefined || url.trim() === "") {
    return { ok: false, reason: "DATABASE_URL is not set" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: "DATABASE_URL is not a URL this script can read" };
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    return { ok: false, reason: `DATABASE_URL uses "${parsed.protocol}", not postgres:` };
  }
  const hosts = [bare(parsed.hostname)];
  for (const override of parsed.searchParams.getAll("host")) {
    hosts.push(...override.split(",").map((h) => bare(h.trim())));
  }
  for (const host of hosts) {
    if (!LOCAL_DATABASE_HOSTS.includes(host)) {
      return {
        ok: false,
        reason: `DATABASE_URL points at "${host || "(no host)"}" — the demo seed only writes to ${LOCAL_DATABASE_HOSTS.join(", ")}`,
      };
    }
  }
  return { ok: true, host: hosts[0] as string };
}
