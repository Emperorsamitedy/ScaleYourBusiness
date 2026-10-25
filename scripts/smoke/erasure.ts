// smoke:erasure — one erasure through the real path, on a throwaway
// contact whose address can never belong to anyone (a reserved domain).
//
// It creates the contact with addContact, erases it with eraseContact,
// then proves the three things rule 22 promises: the row is gone, the
// suppression hash stands (and re-adding the address is refused), and the
// decision log names the erasure by id while holding nothing personal.
// Then it removes what it left behind: the suppression row and any
// booking-erasure keys for the test address. The decision-log entry stays
// — the log is append-only, and that entry holds ids and hashes only.

import { randomBytes } from "node:crypto";
import type { Env, Print } from "./common";
import {
  Report,
  databaseLine,
  isReservedTestAddress,
  missingKeys,
  parseArgs,
  plainAddress,
} from "./common";

export interface LogEntry {
  id: string;
  kind: string;
  ref_id: string;
  payload_hash: string;
}

export interface ErasureDeps {
  /** The account's business profile, or null. */
  profileOf: (accountId: string) => Promise<string | null>;
  addContact: (accountId: string, email: string, name: string) => Promise<string>;
  eraseContact: (accountId: string, contactId: string) => Promise<void>;
  contactExists: (contactId: string) => Promise<boolean>;
  /** The suppression's reason for this address, or null. */
  suppressedReason: (accountId: string, email: string) => Promise<string | null>;
  /** Whether re-adding the address is refused. */
  readdRefused: (accountId: string, email: string) => Promise<boolean>;
  /** The business's latest decision-log entries (ours among them), newest first. */
  decisionLog: (profileId: string) => Promise<LogEntry[]>;
  /** Remove the test address's suppression and booking-erasure rows. Counts removed. */
  cleanup: (
    accountId: string,
    email: string,
  ) => Promise<{ suppressions: number; booking_keys: number }>;
  /** For a run that failed before the erasure: remove the throwaway row itself. */
  deleteContact: (accountId: string, contactId: string) => Promise<void>;
}

export const ERASURE_KEYS = ["DATABASE_URL", "CONNECTOR_KEY"] as const;
export const TEST_NAME = "Smoke Test Erasure";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fresh throwaway address on a reserved domain, so every run starts unsuppressed. */
export function throwawayAddress(): string {
  return `smoke-erasure-${randomBytes(6).toString("hex")}@example.test`;
}

/**
 * The decision-log sweep: entries whose stored text contains any of the
 * needles (case-insensitive). The erasure tests check ref_id and
 * payload_hash the same way; this is that sweep as a function.
 */
export function piiInLog(entries: readonly LogEntry[], needles: readonly string[]): LogEntry[] {
  const lowered = needles.map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
  return entries.filter((e) => {
    const text = `${e.kind} ${e.ref_id} ${e.payload_hash}`.toLowerCase();
    return lowered.some((n) => text.includes(n));
  });
}

export async function runSmokeErasure(args: {
  env: Env;
  argv: readonly string[];
  print: Print;
  deps: ErasureDeps;
}): Promise<number> {
  const { env, print, deps } = args;
  const r = new Report(print, env);
  const { flags, values } = parseArgs(args.argv);
  r.line(
    "smoke:erasure — a throwaway contact, erased through the real path, and its trail checked.",
  );
  r.line(databaseLine(env.DATABASE_URL));

  const missing = missingKeys(env, ERASURE_KEYS);
  if (missing.length > 0) {
    return r.refuse(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set.`);
  }
  const accountId = values.get("account")?.trim() ?? "";
  if (!UUID_RE.test(accountId)) return r.refuse("Give the account id: --account <uuid>.");
  const given = values.get("email");
  const parsed = given === undefined ? throwawayAddress() : plainAddress(given);
  if (!parsed || !isReservedTestAddress(parsed)) {
    return r.refuse(
      "The test address must be on a reserved domain (.test, .example, .invalid, .localhost, or example.com/.net/.org), so it can never be a real customer's.",
    );
  }
  const email: string = parsed;
  r.line(
    `About to add the contact ${email} ("${TEST_NAME}") to account ${accountId}, erase it, check the trail, and clean up.`,
  );
  r.line(
    "The erasure writes one decision-log entry, which stays: the log is append-only, and the entry holds ids and hashes only.",
  );
  if (!flags.has("yes")) return r.refuse("Run it again with --yes to go ahead.");

  const profile = await deps.profileOf(accountId);
  if (
    !r.check(
      profile !== null,
      "The account has a business profile.",
      "That account has no business profile, so the erasure would leave no log entry to check.",
    )
  ) {
    return r.finish();
  }
  const profileId: string = profile!;

  let contactId: string | null = null;
  let erased = false;
  // The tally is printed after the cleanup, so nothing in `try` returns.
  try {
    try {
      contactId = await deps.addContact(accountId, email, TEST_NAME);
      r.pass(`The throwaway contact was created through addContact (${contactId}).`);
    } catch (error) {
      r.fail(`addContact refused the throwaway contact: ${(error as Error).message}`);
    }
    if (contactId !== null) await checkErasure(contactId);
  } catch (error) {
    r.fail(`The run stopped: ${(error as Error).message}`);
  } finally {
    if (contactId !== null && !erased) {
      await deps.deleteContact(accountId, contactId).catch(() => undefined);
      r.line(
        "Cleanup: the throwaway contact was removed directly, because the erasure didn't run.",
      );
    }
    const removed = await deps.cleanup(accountId, email).catch(() => null);
    r.line(
      removed === null
        ? `Cleanup failed: remove the suppression for ${email} by hand if it matters.`
        : `Cleanup: removed ${removed.suppressions} suppression ${removed.suppressions === 1 ? "row" : "rows"} and ${removed.booking_keys} booking-erasure ${removed.booking_keys === 1 ? "key" : "keys"} for the test address. The decision-log entry stays, by design.`,
    );
  }
  return r.finish();

  async function checkErasure(contactId: string): Promise<void> {
    await deps.eraseContact(accountId, contactId);
    erased = true;
    r.pass("eraseContact ran.");

    r.check(
      !(await deps.contactExists(contactId)),
      "The contact row is gone.",
      "The contact row is still there.",
    );
    const reason = await deps.suppressedReason(accountId, email);
    r.check(
      reason === "erasure",
      "The suppression hash stands, with the reason erasure.",
      reason === null
        ? "No suppression stands for the address."
        : `A suppression stands, but with the reason ${reason}.`,
    );
    r.check(
      await deps.readdRefused(accountId, email),
      "Re-adding the address is refused.",
      "Re-adding the address was allowed.",
    );
    const log = await deps.decisionLog(profileId);
    const erasures = log.filter((e) => e.kind === "erasure" && e.ref_id === contactId);
    r.check(
      erasures.length === 1 && /^[0-9a-f]{64}$/.test(erasures[0]!.payload_hash),
      "The decision log has one erasure entry, naming the contact by id, with a sha256 payload hash.",
      `The decision log has ${erasures.length} erasure entries for the contact.`,
    );
    const localPart = email.slice(0, email.indexOf("@"));
    const leaks = piiInLog(log, [email, localPart, TEST_NAME]);
    r.check(
      leaks.length === 0,
      log.length === 1
        ? "This business's one decision-log entry holds neither the address nor the name."
        : `None of this business's latest ${log.length} decision-log entries holds the address or the name.`,
      `${leaks.length} decision-log ${leaks.length === 1 ? "entry holds" : "entries hold"} the address or the name: ${leaks.map((e) => e.id).join(", ")}.`,
    );
  }
}
