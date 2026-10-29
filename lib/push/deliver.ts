// Delivering one alert to each of an account's devices — idea 53 (I-53.2,
// I-53.3). Once per device, never retried: a 404 or 410 from the push
// service deletes that subscription, any other failure is logged with the
// account id. Used by the card's "Send a test" and by the flush
// (./flush.ts) that sends what waits for the owner's yes.

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { pushSubscriptions } from "../../db/schema";
import { logSafeError } from "../core/log-safe";
import type { DeliveryOutcome, PushPayload, PushService } from "./send";
import type { SealedDevice } from "./subscriptions";
import { openDevices } from "./subscriptions";

export interface DeviceOutcome {
  id: string;
  label: string;
  outcome: DeliveryOutcome;
}

export const TEST_PAYLOAD: PushPayload = {
  title: "SYB",
  body: "A test from SYB. Alerts will reach this device.",
  url: "/proposals",
  tag: "syb-test",
};

/** The card's "Send a test": every device, once. It doesn't use the day's one alert. */
export async function sendTestPush(
  accountId: string,
  service: PushService,
): Promise<DeviceOutcome[]> {
  const devices = await openDevices(accountId);
  return (await deliverAll(accountId, devices, TEST_PAYLOAD, service, "test")).outcomes;
}

/** Send one payload to each device once. A 404/410 deletes that subscription. */
export async function deliverAll(
  accountId: string,
  devices: readonly SealedDevice[],
  payload: PushPayload,
  service: PushService,
  purpose: "proposals" | "test",
): Promise<{ sent: number; gone: number; failed: number; outcomes: DeviceOutcome[] }> {
  const outcomes: DeviceOutcome[] = [];
  for (const d of devices) {
    let outcome: DeliveryOutcome;
    try {
      outcome = await service.deliver(d.target, payload);
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
