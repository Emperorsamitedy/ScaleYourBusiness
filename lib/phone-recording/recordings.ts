// Call recordings — P6-08 (TASKS-PHASE6.md rules 22, 32 and 34). The
// trusted side: nothing here is reachable from a caller's words. Twilio
// reaches it only through its signed recording status callback
// (app/api/phone/recording), the owner through /support, and the daily
// upkeep through the cron.
//
//   rule 32 — a recording is let in only for a call whose caller heard the
//             recording notice (phone_calls.recording_notice_at). One that
//             arrives for any other call is deleted at Twilio, unfetched.
//   one copy — the finished MP3 is fetched by its id, sealed (seal.ts) and
//             put in SYB's media storage; then Twilio's copy is deleted.
//             Until Twilio confirms, the row says at_twilio and the upkeep
//             tries again.
//   keep     — PHONE_RECORDING_KEEP_DAYS (default 30) from when it was
//             stored; then both copies go, then the row.
//   rule 22  — erasing a call or a contact marks its recordings for
//             purging and purges them: SYB's copy, Twilio's if it is still
//             there, then the row. The decision log holds ids only.
//   rule 34  — each stored recording is a cost line: its duration, with
//             Twilio's per-minute price unknown at the time (it is on the
//             Twilio bill).

import { randomBytes } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../db";
import type { DbOrTx } from "../../db";
import { phoneCalls, phoneRecordings } from "../../db/schema";
import type { MediaStore } from "../content/media";
import { configuredMediaStore } from "../content/media";
import type { TwilioEnv } from "../env";
import { phoneRecordingKeepDays, twilioEnv, twilioMissing } from "../env";
import { openAudio, recordingKey, recordingKeyReady, sealAudio } from "./seal";
import type { FetchLike } from "./twilio-api";
import {
  RECORDING_MAX_BYTES,
  RECORDING_SID_RE,
  deleteRecordingAtTwilio,
  downloadRecording,
} from "./twilio-api";

export const RECORDING_WORKLOAD = "phone_recording";
/** Twilio's call ids, as lib/phone checks them. */
const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const DAY_MS = 86_400_000;
/** Rows the upkeep handles per kind per run: it runs daily, and calls are capped per day. */
export const UPKEEP_BATCH = 200;
/** The cost line's words for what isn't known (rule 34). */
export const TWILIO_PRICE_UNKNOWN =
  "Twilio's per-minute recording price isn't known when the recording is made; it is on the Twilio bill";

export type RecordingRow = typeof phoneRecordings.$inferSelect;

/** Everything a recording touches outside the database — real by default, fakes in tests. */
export interface RecordingDeps {
  fetch: FetchLike;
  store: MediaStore | null;
  twilio: Pick<TwilioEnv, "accountSid" | "authToken"> | null;
  key: () => Buffer;
  now: () => Date;
  keepDays: number;
}

let testDeps: Partial<RecordingDeps> | null = null;

/** Tests only: the fakes every recording call uses unless it is handed its own. Null restores the real ones. */
export function setRecordingDepsForTests(deps: Partial<RecordingDeps> | null): void {
  testDeps = deps;
}

function resolveDeps(deps: Partial<RecordingDeps> = {}): RecordingDeps {
  const merged = { ...testDeps, ...deps };
  return {
    fetch: merged.fetch ?? ((input, init) => fetch(input, init)),
    store: merged.store !== undefined ? merged.store : configuredMediaStore(),
    twilio: merged.twilio !== undefined ? merged.twilio : twilioEnv(),
    key: merged.key ?? (() => recordingKey()),
    now: merged.now ?? (() => new Date()),
    keepDays: merged.keepDays ?? phoneRecordingKeepDays(),
  };
}

export class PhoneRecordingError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PhoneRecordingError";
    this.status = status;
  }
}

/**
 * The settings this server lacks before recording can be switched on:
 * Twilio's (to fetch and delete), a media store (to keep it), and
 * CONNECTOR_KEY (to seal it). Empty when it can.
 */
export function recordingMissing(): string[] {
  const missing: string[] = [...twilioMissing()];
  if (configuredMediaStore() === null) missing.push("BLOB_READ_WRITE_TOKEN");
  if (!recordingKeyReady()) missing.push("CONNECTOR_KEY");
  return missing;
}

function log(event: string, row: Pick<RecordingRow, "id" | "account_id">, extra = {}): void {
  console.log(
    JSON.stringify({ event, account_id: row.account_id, recording_id: row.id, ...extra }),
  );
}

function warn(
  event: string,
  row: Pick<RecordingRow, "id" | "account_id">,
  error: unknown,
  extra = {},
): void {
  console.warn(
    JSON.stringify({
      event,
      account_id: row.account_id,
      recording_id: row.id,
      error: error instanceof Error ? error.name : "unknown",
      status:
        error && typeof error === "object" && "status" in error
          ? (error as { status: unknown }).status
          : null,
      ...extra,
    }),
  );
}

const addDays = (at: Date, days: number): string =>
  new Date(at.getTime() + days * DAY_MS).toISOString();

function intOrNull(raw: string | undefined): number | null {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/* ── Twilio's callback ── */

export type CallbackOutcome =
  | "ignored" // not a recording event SYB acts on
  | "absent" // Twilio says no audio was captured
  | "no_call" // no call of ours (or one already erased): Twilio's copy deleted
  | "refused" // the call never heard the recording notice: deleted at Twilio, never fetched
  | "duplicate" // already handled
  | "stored"
  | "not_stored"; // kept pending; the upkeep tries again

/**
 * Twilio's recording status callback, already signature-checked by the
 * route. Acts on "completed" and "absent"; everything else is ignored.
 */
export async function recordingCallback(
  params: Readonly<Record<string, string>>,
  deps: Partial<RecordingDeps> = {},
): Promise<CallbackOutcome> {
  const d = resolveDeps(deps);
  const sid = params.RecordingSid ?? "";
  if (!RECORDING_SID_RE.test(sid)) return "ignored";
  const status = params.RecordingStatus ?? "";
  if (status === "absent") {
    console.log(JSON.stringify({ event: "phone_recording_absent", account_id: null }));
    return "absent";
  }
  if (status !== "completed") return "ignored";

  const callSid = params.CallSid ?? "";
  const [call] = CALL_SID_RE.test(callSid)
    ? await db.select().from(phoneCalls).where(eq(phoneCalls.call_sid, callSid))
    : [];
  if (!call) {
    // A recording for no call SYB keeps — never one to hold. Twilio's copy goes.
    console.warn(JSON.stringify({ event: "phone_recording_no_call", account_id: null }));
    if (d.twilio) {
      await deleteRecordingAtTwilio(d.twilio, sid, { fetch: d.fetch }).catch((error: unknown) =>
        console.warn(
          JSON.stringify({
            event: "phone_recording_delete_failed",
            account_id: null,
            error: error instanceof Error ? error.name : "unknown",
          }),
        ),
      );
    }
    return "no_call";
  }

  const now = d.now();
  if (call.recording_notice_at === null) {
    // Rule 32: the caller was never told. Nothing of it is fetched or kept;
    // the row exists only so the delete at Twilio is retried until it lands.
    const [refused] = await db
      .insert(phoneRecordings)
      .values({
        recording_sid: sid,
        call_id: call.id,
        profile_id: call.profile_id,
        account_id: call.account_id,
        status: "refused",
        purge_requested_at: now.toISOString(),
        expires_at: now.toISOString(),
      })
      .onConflictDoNothing({ target: phoneRecordings.recording_sid })
      .returning();
    console.warn(
      JSON.stringify({
        event: "phone_recording_without_notice",
        account_id: call.account_id,
        call_id: call.id,
      }),
    );
    if (refused) await purgeRecording(refused, d);
    return "refused";
  }

  const [inserted] = await db
    .insert(phoneRecordings)
    .values({
      recording_sid: sid,
      call_id: call.id,
      profile_id: call.profile_id,
      account_id: call.account_id,
      status: "pending",
      duration_seconds: intOrNull(params.RecordingDuration),
      channels: intOrNull(params.RecordingChannels),
      // A recording that can't be fetched within the keep window is deleted then.
      expires_at: addDays(now, d.keepDays),
    })
    .onConflictDoNothing({ target: phoneRecordings.recording_sid })
    .returning();
  if (!inserted) return "duplicate";
  return (await storeRecording(inserted, d)) ? "stored" : "not_stored";
}

/* ── one copy: fetch, seal, store, then delete Twilio's ── */

/**
 * Fetch a pending recording from Twilio, seal it into SYB's storage, then
 * delete Twilio's copy. True once stored. Never throws: a failure counts
 * an attempt and leaves it pending for the upkeep.
 */
export async function storeRecording(
  row: RecordingRow,
  deps: Partial<RecordingDeps> = {},
): Promise<boolean> {
  const d = resolveDeps(deps);
  if (!d.twilio || !d.store) {
    await db
      .update(phoneRecordings)
      .set({ attempts: sql`${phoneRecordings.attempts} + 1` })
      .where(eq(phoneRecordings.id, row.id));
    log("phone_recording_not_set_up", row, { twilio: !!d.twilio, store: !!d.store });
    return false;
  }
  let storedUrl: string | null = null;
  try {
    const audio = await downloadRecording(d.twilio, row.recording_sid, { fetch: d.fetch });
    const sealed = sealAudio(audio.body, d.key());
    const put = await d.store.put(
      `recordings/${row.profile_id}/${randomBytes(16).toString("hex")}.bin`,
      sealed,
      "application/octet-stream",
    );
    storedUrl = put.url;
    const now = d.now();
    // Conditional: a second runner that got here first wins, and ours is removed.
    const [stored] = await db
      .update(phoneRecordings)
      .set({
        status: "stored",
        storage_url: put.url,
        bytes: audio.body.byteLength,
        content_type: audio.content_type,
        stored_at: now.toISOString(),
        expires_at: addDays(now, d.keepDays),
        attempts: sql`${phoneRecordings.attempts} + 1`,
      })
      .where(
        and(
          eq(phoneRecordings.id, row.id),
          eq(phoneRecordings.status, "pending"),
          isNull(phoneRecordings.purge_requested_at),
        ),
      )
      .returning();
    if (!stored) {
      await d.store.del(put.url);
      return false;
    }
    // Rule 34: the recording's cost line. Twilio prices it per minute on its bill.
    log("phone_recording", stored, {
      workload: RECORDING_WORKLOAD,
      profile_id: stored.profile_id,
      call_id: stored.call_id,
      duration_seconds: stored.duration_seconds,
      bytes: stored.bytes,
      store: d.store.kind,
      cost_eur: null,
      cost_note: TWILIO_PRICE_UNKNOWN,
    });
    await releaseTwilioCopy(stored, d);
    return true;
  } catch (error) {
    if (storedUrl) await d.store.del(storedUrl).catch(() => undefined);
    await db
      .update(phoneRecordings)
      .set({ attempts: sql`${phoneRecordings.attempts} + 1` })
      .where(eq(phoneRecordings.id, row.id));
    warn("phone_recording_store_failed", row, error);
    return false;
  }
}

/** Delete Twilio's copy of a recording SYB now holds. True once no copy is left there. */
export async function releaseTwilioCopy(
  row: RecordingRow,
  deps: Partial<RecordingDeps> = {},
): Promise<boolean> {
  const d = resolveDeps(deps);
  if (!row.at_twilio) return true;
  if (!d.twilio) return false;
  try {
    const result = await deleteRecordingAtTwilio(d.twilio, row.recording_sid, { fetch: d.fetch });
    await db
      .update(phoneRecordings)
      .set({ at_twilio: false })
      .where(eq(phoneRecordings.id, row.id));
    log("phone_recording_twilio_deleted", row, { result });
    return true;
  } catch (error) {
    warn("phone_recording_twilio_delete_failed", row, error);
    return false;
  }
}

/* ── purging: erasure, refusal, expiry ── */

/**
 * Both copies, then the row: SYB's sealed file, Twilio's copy if it is
 * still there, and the row only once neither is left. True when the row is
 * gone. Never throws: what fails stays marked, and the upkeep retries.
 */
export async function purgeRecording(
  row: RecordingRow,
  deps: Partial<RecordingDeps> = {},
): Promise<boolean> {
  const d = resolveDeps(deps);
  let current = row;
  try {
    if (current.storage_url) {
      if (!d.store) throw new PhoneRecordingError("no media store to delete from", 503);
      await d.store.del(current.storage_url);
      const [cleared] = await db
        .update(phoneRecordings)
        .set({ storage_url: null })
        .where(eq(phoneRecordings.id, current.id))
        .returning();
      if (cleared) current = cleared;
    }
  } catch (error) {
    warn("phone_recording_store_delete_failed", current, error);
    await db
      .update(phoneRecordings)
      .set({ attempts: sql`${phoneRecordings.attempts} + 1` })
      .where(eq(phoneRecordings.id, current.id));
    return false;
  }
  if (current.at_twilio && !(await releaseTwilioCopy(current, d))) {
    await db
      .update(phoneRecordings)
      .set({ attempts: sql`${phoneRecordings.attempts} + 1` })
      .where(eq(phoneRecordings.id, current.id));
    return false;
  }
  await db.delete(phoneRecordings).where(eq(phoneRecordings.id, current.id));
  log("phone_recording_purged", current);
  return true;
}

/**
 * Rule 22: mark the recordings of these calls for purging — inside the
 * erasure's own transaction, BEFORE the calls go, so a recording is never
 * left without its marker. Returns their ids, for the purge after commit
 * and for the decision log (ids only).
 */
export async function markRecordingsForErasure(
  callIds: readonly string[],
  executor: DbOrTx = db,
  now = new Date(),
): Promise<string[]> {
  if (callIds.length === 0) return [];
  const rows = await executor
    .update(phoneRecordings)
    .set({ purge_requested_at: now.toISOString() })
    .where(inArray(phoneRecordings.call_id, [...callIds]))
    .returning({ id: phoneRecordings.id });
  return rows.map((r) => r.id);
}

/** Purge marked recordings now (after the erasure committed). Returns how many are fully gone. */
export async function purgeRecordings(
  ids: readonly string[],
  deps: Partial<RecordingDeps> = {},
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .select()
    .from(phoneRecordings)
    .where(inArray(phoneRecordings.id, [...ids]));
  let gone = 0;
  for (const row of rows) if (await purgeRecording(row, deps)) gone += 1;
  return gone;
}

/* ── the daily upkeep ── */

export interface UpkeepResult {
  stored: number;
  released: number;
  purged: number;
  failed: number;
}

/**
 * The daily cron's step: fetch what is still pending, delete Twilio copies
 * a failed delete left behind, and purge what is erased, refused, past
 * its keep date or orphaned (its call or business gone some other way).
 */
export async function runRecordingUpkeep(deps: Partial<RecordingDeps> = {}): Promise<UpkeepResult> {
  const d = resolveDeps(deps);
  const now = d.now().toISOString();
  const out: UpkeepResult = { stored: 0, released: 0, purged: 0, failed: 0 };

  const toPurge = await db
    .select()
    .from(phoneRecordings)
    .where(
      or(
        isNotNull(phoneRecordings.purge_requested_at),
        lte(phoneRecordings.expires_at, now),
        isNull(phoneRecordings.call_id),
      ),
    )
    .limit(UPKEEP_BATCH);
  for (const row of toPurge) {
    if (await purgeRecording(row, d)) out.purged += 1;
    else out.failed += 1;
  }

  const pending = await db
    .select()
    .from(phoneRecordings)
    .where(
      and(
        eq(phoneRecordings.status, "pending"),
        isNull(phoneRecordings.purge_requested_at),
        isNotNull(phoneRecordings.call_id),
        gt(phoneRecordings.expires_at, now),
      ),
    )
    .limit(UPKEEP_BATCH);
  for (const row of pending) {
    if (await storeRecording(row, d)) out.stored += 1;
    else out.failed += 1;
  }

  const lingering = await db
    .select()
    .from(phoneRecordings)
    .where(
      and(
        eq(phoneRecordings.status, "stored"),
        eq(phoneRecordings.at_twilio, true),
        isNull(phoneRecordings.purge_requested_at),
      ),
    )
    .limit(UPKEEP_BATCH);
  for (const row of lingering) {
    if (await releaseTwilioCopy(row, d)) out.released += 1;
    else out.failed += 1;
  }
  console.log(JSON.stringify({ event: "phone_recording_upkeep", account_id: null, ...out }));
  return out;
}

/* ── the owner's ears only ── */

export interface RecordingSummary {
  id: string;
  duration_seconds: number | null;
  expires_at: string | null;
}

/** The playable recording of each call, by call id — stored, not marked for erasure, not expired. */
export async function recordingsForCalls(
  profileId: string,
  callIds: readonly string[],
  now = new Date(),
): Promise<Map<string, RecordingSummary>> {
  const out = new Map<string, RecordingSummary>();
  if (callIds.length === 0) return out;
  const rows = await db
    .select()
    .from(phoneRecordings)
    .where(
      and(
        eq(phoneRecordings.profile_id, profileId),
        inArray(phoneRecordings.call_id, [...callIds]),
        eq(phoneRecordings.status, "stored"),
        isNotNull(phoneRecordings.storage_url),
        isNull(phoneRecordings.purge_requested_at),
        gt(phoneRecordings.expires_at, now.toISOString()),
      ),
    );
  for (const r of rows) {
    if (r.call_id && !out.has(r.call_id)) {
      out.set(r.call_id, {
        id: r.id,
        duration_seconds: r.duration_seconds,
        expires_at: r.expires_at,
      });
    }
  }
  return out;
}

/**
 * The opened audio of one call's recording, scoped to the profile. The
 * route that calls this checks the owner role first; this never returns a
 * storage address, only bytes.
 */
export async function openRecording(
  profileId: string,
  callId: string,
  deps: Partial<RecordingDeps> = {},
): Promise<{ body: Uint8Array; content_type: string }> {
  const d = resolveDeps(deps);
  const [row] = await db
    .select()
    .from(phoneRecordings)
    .where(
      and(
        eq(phoneRecordings.profile_id, profileId),
        eq(phoneRecordings.call_id, callId),
        eq(phoneRecordings.status, "stored"),
        isNotNull(phoneRecordings.storage_url),
        isNull(phoneRecordings.purge_requested_at),
        gt(phoneRecordings.expires_at, d.now().toISOString()),
      ),
    )
    .limit(1);
  if (!row?.storage_url) throw new PhoneRecordingError("no such recording", 404);
  if (!d.store?.get)
    throw new PhoneRecordingError("recordings can't be played on this server", 503);
  // The sealed file is the audio plus 35 bytes of header and tag.
  const sealed = await d.store.get(row.storage_url, RECORDING_MAX_BYTES + 64);
  return { body: openAudio(sealed, d.key()), content_type: row.content_type ?? "audio/mpeg" };
}

/** Rows still holding audio anywhere, for one profile — what a test or the ops panel can count. */
export async function recordingsHeld(profileId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(phoneRecordings)
    .where(
      and(
        eq(phoneRecordings.profile_id, profileId),
        or(isNotNull(phoneRecordings.storage_url), eq(phoneRecordings.at_twilio, true)),
      ),
    );
  return row?.n ?? 0;
}
