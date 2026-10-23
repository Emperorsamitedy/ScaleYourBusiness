// robots.txt, read the way RFC 9309 says — feature 35, competitor reading.
//
// Pure: parse the file, then judge one path for our user agent. The
// fetching of the file itself lives in ./read.ts, through the hardened
// fetcher like every other request.
//
// The rules that matter here:
//   · The group whose user-agent line names our product token wins; with
//     none, the "*" group; with neither, everything is allowed.
//   · Within the group the LONGEST matching rule decides, and Allow wins a
//     tie with Disallow. "*" matches any run of characters, "$" anchors
//     the end. An empty Disallow allows everything.
//   · A file that doesn't exist (any 4xx) allows everything; a file that
//     can't be reached (5xx, a timeout, a refusal) disallows everything.
//     The second is the conservative half: not knowing is not consent.

/** The token our user agent starts with, matched case-insensitively. */
export const ROBOTS_TOKEN = "ledgerline";

interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  /** The rules of the one group that applies to us. */
  rules: Rule[];
  /** "all" when no file was found, "none" when it couldn't be read. */
  blanket: "all" | "none" | null;
}

export const ALLOW_ALL: RobotsRules = { rules: [], blanket: "all" };
export const DISALLOW_ALL: RobotsRules = { rules: [], blanket: "none" };

/** Pure: the group for our token from a robots.txt body. */
export function parseRobots(body: string, token: string = ROBOTS_TOKEN): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      // Consecutive user-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue; // rules before any user-agent line belong to no one
    if (field === "allow" || field === "disallow") {
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  }

  // "Ledgerline" and "Ledgerline-CompetitorRead" both name us.
  const ours = groups.filter((g) => g.agents.some((a) => a.startsWith(token)));
  const star = groups.filter((g) => g.agents.includes("*"));
  const chosen = ours.length > 0 ? ours : star;
  return { rules: chosen.flatMap((g) => g.rules), blanket: null };
}

/**
 * Wildcards one rule may carry. Real robots.txt files use one or two; a
 * rule with more is hostile or broken, and is ignored rather than run.
 */
export const MAX_WILDCARDS_PER_RULE = 10;

/**
 * Pure: whether a robots pattern matches a path from its start. "*" is any
 * run of characters, a trailing "$" anchors the end. Linear in the path for
 * each literal piece: the pieces between stars are matched greedily
 * left-to-right, which is exact for this pattern language (no
 * backtracking, so no hostile pattern can stall the event loop — the
 * review of 2026-10-23, finding 2, timed the old RegExp past 120 s on a
 * 40-character path).
 */
export function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  if (parts.length - 1 > MAX_WILDCARDS_PER_RULE) return false;
  const first = parts[0] ?? "";
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return anchored ? path === first : true;
  let at = first.length;
  const last = parts[parts.length - 1] ?? "";
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i] ?? "";
    if (piece === "") continue;
    const found = path.indexOf(piece, at);
    if (found === -1) return false;
    at = found + piece.length;
  }
  if (!anchored) return last === "" || path.indexOf(last, at) !== -1;
  // Anchored: the last piece must end the path, after everything before it.
  return path.length - last.length >= at && path.endsWith(last);
}

/** Pure: whether a URL's path (with its query) may be fetched under these rules. */
export function robotsAllows(rules: RobotsRules, url: URL): boolean {
  if (rules.blanket === "all") return true;
  if (rules.blanket === "none") return false;
  const path = `${url.pathname}${url.search}`;
  if (path === "/robots.txt") return true;
  let best: Rule | null = null;
  for (const rule of rules.rules) {
    if (rule.pattern === "") continue; // "Disallow:" with nothing allows everything
    if (!robotsPatternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.replace(/\*|\$$/g, "").length;
    const bestLength = best ? best.pattern.replace(/\*|\$$/g, "").length : -1;
    if (length > bestLength || (length === bestLength && rule.allow && best && !best.allow)) {
      best = rule;
    }
  }
  return best === null ? true : best.allow;
}

/** Pure: what a robots.txt response means, by its status (RFC 9309 §2.3.1). */
export function robotsFromResponse(status: number, body: string): RobotsRules {
  if (status >= 200 && status < 300) return parseRobots(body);
  if (status >= 400 && status < 500) return ALLOW_ALL;
  return DISALLOW_ALL;
}
