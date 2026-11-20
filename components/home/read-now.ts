// "Read now" on Lex's status card (docs/DASHBOARD-OVERHAUL.md C2) — pure.
// The button reads each connected account again through the connections
// screen's own POST /api/connections/sync, and the card then says what was
// read. This decides what one answer of that route counts as, so the line
// "Read 2 connections." is never said of something that was not read.

/** What reading one connection again came back as. */
export type ReadNow = "read" | "nothing" | "silent";

/**
 * Pure: one answer of POST /api/connections/sync.
 *
 *   read     the runner pulled it (`ok: true`)
 *   nothing  the runner stood down and says why (`skipped`): a source the
 *            owner hands over has nothing to pull, and one another run is
 *            reading this very moment is not read twice. Neither read nor
 *            a failure, so it is left out of both counts.
 *   silent   anything else: a refusal, an error, a read that failed
 */
export function readNowOutcome(
  httpOk: boolean,
  body: { ok?: unknown; skipped?: unknown } | null,
): ReadNow {
  if (!httpOk || body === null) return "silent";
  if (body.ok === true) return "read";
  return typeof body.skipped === "string" && body.skipped !== "" ? "nothing" : "silent";
}

export interface ReadNowTally {
  read: number;
  /** The names that gave no answer, in the order they were tried. */
  silent: string[];
}

/** Pure: the tally with one more answer in it. */
export function tallied(tally: ReadNowTally, name: string, outcome: ReadNow): ReadNowTally {
  if (outcome === "read") return { read: tally.read + 1, silent: tally.silent };
  if (outcome === "silent") return { read: tally.read, silent: [...tally.silent, name] };
  return tally;
}
