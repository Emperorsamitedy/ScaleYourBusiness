// Delivering one alert to each of an account's devices — idea 53 (I-53.2,
// I-53.3). Once per device, never retried: a 404 or 410 from the push
// service deletes that subscription, any other failure is logged with the
// account id. Used by the card's "Send a test" and by the flush
// (./flush.ts) that sends what waits for the owner's yes.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { pushSubscriptions } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { AppLocale } from "../i18n/locales";
import type { Words } from "../i18n/recipient";
import { englishWords, wordsFor } from "../i18n/recipient";
import type { DeliveryOutcome, PushPayload, PushService } from "./send";
import type { SealedDevice } from "./subscriptions";
import { openDevices } from "./subscriptions";

export interface DeviceOutcome {
  id: string;
  label: string;
  outcome: DeliveryOutcome;
}

/** The test alert in one language (L-6; English by default). */
export function testPayload(w: Words = englishWords("push")): PushPayload {
  return { title: "ScaleX", body: w.t("test"), url: "/proposals", tag: "syb-test" };
}

export const TEST_PAYLOAD: PushPayload = testPayload();

/** The card's "Send a test": every device, once. It doesn't use the day's one alert. */
export async function sendTestPush(
  accountId: string,
  service: PushService,
  /** Idea 52: the person pressing it — a test goes to their own devices only. */
  userId: string | null = null,
): Promise<DeviceOutcome[]> {
  const devices = await openDevices(accountId, userId);
  const words = await wordsByLocale(devices, "push");
  return (
    await deliverAll(accountId, devices, (d) => testPayload(words.get(d.locale)), service, "test")
  ).outcomes;
}

/** Each device's language's words, loaded once per language. */
export async function wordsByLocale(
  devices: readonly SealedDevice[],
  namespace: string,
): Promise<Map<AppLocale, Words>> {
  const out = new Map<AppLocale, Words>();
  for (const d of devices) {
    if (!out.has(d.locale)) out.set(d.locale, await wordsFor(d.locale, namespace));
  }
  return out;
}

/**
 * Send one payload to each device once — or, L-6, each device its own,
 * in its person's language. A 404/410 deletes that subscription.
 */
export async function deliverAll(
  accountId: string,
  devices: readonly SealedDevice[],
  payload: PushPayload | ((device: SealedDevice) => PushPayload),
  service: PushService,
  purpose: "proposals" | "test",
): Promise<{ sent: number; gone: number; failed: number; outcomes: DeviceOutcome[] }> {
  const outcomes: DeviceOutcome[] = [];
  for (const d of devices) {
    let outcome: DeliveryOutcome;
    try {
      outcome = await service.deliver(
        d.target,
        typeof payload === "function" ? payload(d) : payload,
      );
    } catch (error) {
      outcome = { kind: "failed", status: null, why: logSafeError(error).error_name };
    }
    if (outcome.kind === "gone") {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, d.id));
    }
    console[outcome.kind === "failed" ? "error" : "log"](
      JSON.stringify({
        event:
          outcome.kind === "sent"
            ? "push_sent"
            : outcome.kind === "gone"
              ? "push_subscription_gone"
              : "push_failed",
        account_id: accountId,
        subscription_id: d.id,
        device_label: d.label,
        purpose,
        service: service.name,
        ...(outcome.kind === "failed" ? { status: outcome.status, why: outcome.why } : {}),
        ...(outcome.kind !== "failed" ? { status: outcome.status } : {}),
      }),
    );
    outcomes.push({ id: d.id, label: d.label, outcome });
  }
  return {
    sent: outcomes.filter((o) => o.outcome.kind === "sent").length,
    gone: outcomes.filter((o) => o.outcome.kind === "gone").length,
    failed: outcomes.filter((o) => o.outcome.kind === "failed").length,
    outcomes,
  };
}
