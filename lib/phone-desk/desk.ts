// The phone line, the OWNER side — P6-02.
//
// Turning the line on (it claims SYB's Twilio number for this business)
// and off, setting the number a caller who asks for a person is put
// through to, reading calls, and erasing one (rule 22). This module sits on
// the trusted side, beside lib/crm: the phone tier (lib/phone) only reads
// what it writes, and a stranger on the line can never reach it — the
// structural test in lib/support forbids the import.
//
// P6-08: switching call recording on and off (off by default; each switch
// on the decision log with who and when), and erasing a call's recording
// with the call — both copies (lib/phone-recording).
//
// Decision 2 (owner, 2026-11-09): least privilege on calls. What a caller
// said — the transcript, the message and the full number — is for those
// who answer support (role action `phone.transcripts`: owners and
// managers). A viewer gets the calls list through `callsForViewer`: no
// message, the number masked to its last three digits. Recordings stay the
// owner's alone (`phone.recordings`).

import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { decisionLog, phoneCallTurns, phoneCalls, phoneSettings } from "../../db/schema";
import { ensureSupportSettings } from "../crm/support-settings";
import { twilioEnv } from "../env";
import type { PhoneLine } from "../phone/settings";
import { lineForProfile } from "../phone/settings";
import { toE164 } from "../phone/twilio";
import type { RecordingDeps, RecordingSummary } from "../phone-recording/recordings";
import {
  markRecordingsForErasure,
  purgeRecordings,
  recordingMissing,
  recordingsForCalls,
} from "../phone-recording/recordings";

export class PhoneDeskError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PhoneDeskError";
    this.status = status;
  }
}

/**
 * Answer calls on SYB's Twilio number for this business. One business per
 * number: a number another business already answers on is refused. The
 * support settings are made too, because the greeting needs the name.
 */
export async function enablePhoneLine(profileId: string): Promise<PhoneLine> {
  const env = twilioEnv();
  if (!env) throw new PhoneDeskError("the phone line is not set up on this server", 409);
  const settings = await ensureSupportSettings(profileId);
  const [holder] = await db
    .select({ profile_id: phoneSettings.profile_id })
    .from(phoneSettings)
    .where(eq(phoneSettings.phone_number, env.phoneNumber));
  if (holder && holder.profile_id !== profileId) {
    throw new PhoneDeskError("that number already answers for another business", 409);
  }
  await db
    .insert(phoneSettings)
    .values({
      profile_id: profileId,
      account_id: settings.account_id,
      phone_number: env.phoneNumber,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: phoneSettings.profile_id,
      set: { phone_number: env.phoneNumber, enabled: true, updated_at: new Date().toISOString() },
    });
  const line = await lineForProfile(profileId);
  if (!line) throw new PhoneDeskError("the phone line could not be turned on", 500);
  return line;
}

/** Stop answering. The row stays (and so do its calls); the number answers with a closed notice. */
export async function disablePhoneLine(profileId: string): Promise<void> {
  const [row] = await db
    .update(phoneSettings)
    .set({ enabled: false, updated_at: new Date().toISOString() })
    .where(eq(phoneSettings.profile_id, profileId))
    .returning({ profile_id: phoneSettings.profile_id });
  if (!row) throw new PhoneDeskError("the phone line is not on", 404);
}

/** The owner's own number for "a person, please" — E.164, or empty to take messages instead. */
export async function setHandoverNumber(profileId: string, raw: string): Promise<string | null> {
  const trimmed = raw.trim();
  const number = trimmed === "" ? null : toE164(trimmed);
  if (trimmed !== "" && number === null) {
    throw new PhoneDeskError("write the number with its country code, starting with +", 422);
  }
  const [row] = await db
    .update(phoneSettings)
    .set({ handover_number: number, updated_at: new Date().toISOString() })
    .where(eq(phoneSettings.profile_id, profileId))
    .returning({ handover_number: phoneSettings.handover_number });
  if (!row) throw new PhoneDeskError("the phone line is not on", 404);
  return row.handover_number;
}

/**
 * P6-08: switch call recording on or off. On needs the line on and this
 * server able to fetch, seal and keep audio; off is always allowed (what is
 * already kept stays until its keep date or an erasure). The switch is a
 * recorded fact (Phase 4's rule 19): who and when, on the decision log, and
 * on the settings row for the screen. Switching to what it already is
 * changes nothing and logs nothing.
 */
export async function setCallRecording(
  profileId: string,
  on: boolean,
  who: { user_id: string },
): Promise<PhoneLine> {
  const line = await lineForProfile(profileId);
  if (!line) throw new PhoneDeskError("the phone line is not on", 404);
  if (line.record_calls === on) return line;
  if (on && recordingMissing().length > 0) {
    throw new PhoneDeskError("call recording is not set up on this server", 409);
  }
  const at = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(phoneSettings)
      .set({
        record_calls: on,
        record_changed_at: at,
        record_changed_by: who.user_id,
        updated_at: at,
      })
      .where(eq(phoneSettings.profile_id, profileId));
    await tx.insert(decisionLog).values({
      profile_id: profileId,
      actor: "owner",
      kind: "recording_consent",
      ref_id: profileId,
      user_id: who.user_id,
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({ profile_id: profileId, record_calls: on, at, user_id: who.user_id }),
        )
        .digest("hex"),
    });
  });
  console.log(
    JSON.stringify({
      event: on ? "phone_recording_on" : "phone_recording_off",
      account_id: line.account_id,
      profile_id: profileId,
      user_id: who.user_id,
    }),
  );
  const updated = await lineForProfile(profileId);
  if (!updated) throw new PhoneDeskError("the phone line is not on", 404);
  return updated;
}

export interface CallSummary {
  id: string;
  caller_number: string | null;
  outcome: (typeof phoneCalls.$inferSelect)["outcome"];
  live: boolean;
  message: string | null;
  turns: number;
  duration_seconds: number | null;
  cost_eur: string;
  started_at: string;
  /** P6-08: the caller was told the call is recorded. */
  recorded: boolean;
  /** P6-08: the kept recording, when there is one to play — never its storage address. */
  recording: RecordingSummary | null;
}

export async function listCalls(profileId: string, limit = 50): Promise<CallSummary[]> {
  const rows = await db
    .select()
    .from(phoneCalls)
    .where(eq(phoneCalls.profile_id, profileId))
    .orderBy(desc(phoneCalls.started_at))
    .limit(limit);
  const recordings = await recordingsForCalls(
    profileId,
    rows.filter((r) => r.recording_notice_at !== null).map((r) => r.id),
  );
  return rows.map((r) => ({
    recorded: r.recording_notice_at !== null,
    recording: recordings.get(r.id) ?? null,
    id: r.id,
    caller_number: r.caller_number,
    outcome: r.outcome,
    live: r.ended_at === null && r.outcome === null,
    message: r.message,
    turns: r.turns,
    duration_seconds: r.duration_seconds,
    cost_eur: r.cost_eur,
    started_at: r.started_at,
  }));
}

/** Digits of a caller's number a viewer still sees — enough to tell calls apart. */
export const MASKED_DIGITS_SHOWN = 3;

/**
 * Pure: a caller's number as a viewer reads it — "•••123", the last three
 * digits only. A withheld number stays null; one with three digits or fewer
 * shows none of them.
 */
export function maskCallerNumber(number: string | null): string | null {
  if (number === null) return null;
  const digits = number.replace(/\D/g, "");
  const shown = digits.length > MASKED_DIGITS_SHOWN ? digits.slice(-MASKED_DIGITS_SHOWN) : "";
  return `•••${shown}`;
}

/**
 * Pure: the calls list for someone who may not read what callers said (a
 * viewer): who rang (masked), when, how it ended, how long — never the
 * message. Everything else is as the owner sees it.
 */
export function callsForViewer(calls: readonly CallSummary[]): CallSummary[] {
  return calls.map((c) => ({
    ...c,
    caller_number: maskCallerNumber(c.caller_number),
    message: null,
  }));
}

export interface CallTurn {
  id: string;
  role: "caller" | "assistant";
  text: string;
  at: string;
}

/** One call's transcript, oldest first, scoped to the owner's profile. */
export async function readCall(profileId: string, callId: string): Promise<CallTurn[]> {
  const [call] = await db
    .select({ id: phoneCalls.id })
    .from(phoneCalls)
    .where(and(eq(phoneCalls.id, callId), eq(phoneCalls.profile_id, profileId)));
  if (!call) throw new PhoneDeskError("no such call", 404);
  const rows = await db
    .select()
    .from(phoneCallTurns)
    .where(eq(phoneCallTurns.call_id, call.id))
    .orderBy(phoneCallTurns.at);
  return rows.map((r) => ({ id: r.id, role: r.role, text: r.text, at: r.at }));
}

/**
 * Erase one call — its number, transcript and message — for good (rule
 * 22). The log records that it happened, by id and hash: nothing a caller
 * said, and not their number. The model calls' metering rows hold ids and
 * token counts only, and stay.
 *
 * P6-08: its recording goes too — marked in the same transaction, then
 * deleted from SYB's storage and at Twilio if a copy is still there. A
 * delete that fails stays marked, the recording unplayable, and the daily
 * upkeep finishes it. Returns how many recordings are still being deleted.
 */
export async function eraseCall(
  accountId: string,
  callId: string,
  deps: Partial<RecordingDeps> = {},
): Promise<{ recordings_pending: number }> {
  const [call] = await db
    .select({ id: phoneCalls.id, profile_id: phoneCalls.profile_id })
    .from(phoneCalls)
    .where(and(eq(phoneCalls.id, callId), eq(phoneCalls.account_id, accountId)));
  if (!call) throw new PhoneDeskError("no such call", 404);
  const recordingIds = await db.transaction(async (tx) => {
    const marked = await markRecordingsForErasure([callId], tx);
    await tx.delete(phoneCalls).where(eq(phoneCalls.id, callId));
    await tx.insert(decisionLog).values({
      profile_id: call.profile_id,
      actor: "owner",
      kind: "erasure",
      ref_id: callId,
      // Ids only (rule 22): the call's, and its recordings' own row ids.
      payload_hash: createHash("sha256")
        .update(
          JSON.stringify({
            account_id: accountId,
            call_id: callId,
            ...(marked.length > 0 ? { recording_ids: marked } : {}),
          }),
        )
        .digest("hex"),
    });
    return marked;
  });
  const gone = await purgeRecordings(recordingIds, deps);
  console.log(
    JSON.stringify({
      event: "phone_call_erased",
      account_id: accountId,
      call_id: callId,
      recordings: recordingIds.length,
      recordings_pending: recordingIds.length - gone,
    }),
  );
  return { recordings_pending: recordingIds.length - gone };
}
