// Sending one phone alert — idea 53 (I-53.3).
//
// The push service is SYB's own channel to its owner, like Resend for the
// weekly email: not a business's connected account, so no connector, no
// scope registry and no execution provider is involved, and nothing here
// can reach one (send.test.ts proves it). One message is one request:
// encrypted for the browser (RFC 8291), signed for the push service
// (RFC 8292), sent once with a 10-second timeout and never retried. A 404
// or 410 means the subscription is gone; the caller deletes it.

import { pushServiceSetting, vapidEnv } from "../env";
import type { PushTarget } from "./endpoints";
import { FAKE_PUSH_HOST, isPushEndpoint } from "./endpoints";
import type { VapidKeys } from "./webpush";
import {
  MAX_JWT_LIFETIME_S,
  WebPushError,
  audienceOf,
  checkVapidKeys,
  encryptPayload,
  fromB64url,
  signVapidJwt,
  vapidAuthorization,
} from "./webpush";

/** What the service worker shows (public/sw.js reads exactly these). */
export interface PushPayload {
  title: string;
  body: string;
  /** /proposals or /proposals/<id> — the worker refuses anything else. */
  url: string;
  tag: string;
}

export type DeliveryOutcome =
  | { kind: "sent"; status: number }
  | { kind: "gone"; status: 404 | 410 }
  | { kind: "failed"; status: number | null; why: string };

export interface PushService {
  readonly name: "web-push" | "fake";
  deliver(target: PushTarget, payload: PushPayload): Promise<DeliveryOutcome>;
}

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

/** One attempt, at most this long (TASKS-FEEDBACK I-53.3). */
export const PUSH_TIMEOUT_MS = 10_000;
/** A day: an alert the phone missed for longer than that isn't worth showing. Apple requires TTL. */
export const PUSH_TTL_SECONDS = 86_400;
/** Coalescing at the push service: a newer undelivered alert replaces an older one. */
export const PUSH_TOPIC = "proposals";

/** Apple asks for a JWT no fresher than hourly; one per push service origin, re-signed with 1 h left. */
const JWT_LIFETIME_S = 12 * 3600;
const JWT_REUSE_MARGIN_S = 3600;

/** The real thing: Web Push over HTTPS to the subscription's own push service. */
export function webPushService(args: {
  vapid: VapidKeys;
  fetchImpl?: PushFetch;
  now?: () => Date;
}): PushService {
  const fetchImpl = args.fetchImpl ?? fetch;
  const now = args.now ?? (() => new Date());
  const jwts = new Map<string, { jwt: string; exp: number }>();
  const jwtFor = (audience: string): string => {
    const nowS = Math.floor(now().getTime() / 1000);
    const hit = jwts.get(audience);
    if (hit && hit.exp - nowS > JWT_REUSE_MARGIN_S) return hit.jwt;
    const exp = nowS + Math.min(JWT_LIFETIME_S, MAX_JWT_LIFETIME_S);
    const jwt = signVapidJwt({ keys: args.vapid, audience, expiresAt: exp });
    jwts.set(audience, { jwt, exp });
    return jwt;
  };
  return {
    name: "web-push",
    async deliver(target, payload) {
      // Checked again at send, not only at subscribe: a stored row is never trusted to be a push service.
      if (!isPushEndpoint(target.endpoint)) {
        return { kind: "failed", status: null, why: "not a push service" };
      }
      let body: Buffer;
      try {
        body = encryptPayload({
          plaintext: Buffer.from(JSON.stringify(payload), "utf8"),
          uaPublic: fromB64url(target.p256dh),
          authSecret: fromB64url(target.auth),
        });
      } catch (error) {
        return {
          kind: "failed",
          status: null,
          why: error instanceof WebPushError ? error.message : "could not encrypt",
        };
      }
      let res: Response;
      try {
        res = await fetchImpl(target.endpoint, {
          method: "POST",
          headers: {
            Authorization: vapidAuthorization(
              jwtFor(audienceOf(target.endpoint)),
              args.vapid.publicKey,
            ),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(PUSH_TTL_SECONDS),
            Urgency: "normal",
            Topic: PUSH_TOPIC,
          },
          body: new Uint8Array(body),
          redirect: "error",
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
      } catch (error) {
        const why =
          error instanceof Error && error.name === "TimeoutError"
            ? "no answer in 10 seconds"
            : "network";
        return { kind: "failed", status: null, why };
      }
      if (res.status === 404 || res.status === 410) return { kind: "gone", status: res.status };
      if (res.status >= 200 && res.status < 300) return { kind: "sent", status: res.status };
      return { kind: "failed", status: res.status, why: `the push service answered ${res.status}` };
    },
  };
}

export interface FakeDelivery {
  at: string;
  endpoint_host: string;
  payload: PushPayload;
}

/**
 * The fake push service: records what would be sent and answers 201. No
 * network. A `gone` set makes chosen endpoints answer 410, for tests of the
 * dead-subscription path.
 */
export function fakePushService(opts: { gone?: Set<string>; failing?: Set<string> } = {}) {
  const sent: FakeDelivery[] = [];
  const service: PushService & { sent: FakeDelivery[] } = {
    name: "fake",
    sent,
    async deliver(target, payload) {
      if (opts.gone?.has(target.endpoint)) return { kind: "gone", status: 410 };
      if (opts.failing?.has(target.endpoint)) {
        return { kind: "failed", status: 503, why: "the push service answered 503" };
      }
      const host = new URL(target.endpoint).hostname;
      sent.push({ at: new Date().toISOString(), endpoint_host: host, payload });
      // The words are safe to log by construction (lib/push/plan.ts): no money, no names.
      console.log(
        JSON.stringify({
          event: "push_fake_sent",
          endpoint_host: host === FAKE_PUSH_HOST ? host : "real-host-not-contacted",
          title: payload.title,
          body: payload.body,
          url: payload.url,
        }),
      );
      return { kind: "sent", status: 201 };
    },
  };
  return service;
}

/** The development process's fake, shared so a test send from the screen and a flush land in one log. */
let devFake: ReturnType<typeof fakePushService> | null = null;
/** One real service per key pair, so its JWTs are reused across sends (Apple: at most one an hour). */
let real: { key: string; service: PushService } | null = null;

export type PushConfig =
  { ok: true; service: PushService; publicKey: string | null } | { ok: false; why: string };

/**
 * The push service this server sends with. Real: the three VAPID variables,
 * set and valid. Fake (PUSH_SERVICE=fake, never in production): no network,
 * and the VAPID public key is still handed to the browser when it is set.
 */
export function pushConfig(): PushConfig {
  const raw = vapidEnv();
  const vapid = raw ? { ...raw } : null;
  const problem = vapid ? checkVapidKeys(vapid) : null;
  if (pushServiceSetting() === "fake") {
    devFake ??= fakePushService();
    return { ok: true, service: devFake, publicKey: vapid && !problem ? vapid.publicKey : null };
  }
  if (!vapid) return { ok: false, why: "the VAPID keys aren't set" };
  if (problem) {
    console.error(JSON.stringify({ event: "push_vapid_invalid", why: problem }));
    return { ok: false, why: "the VAPID keys aren't valid" };
  }
  const key = `${vapid.publicKey}|${vapid.subject}`;
  if (real?.key !== key) real = { key, service: webPushService({ vapid }) };
  return { ok: true, service: real.service, publicKey: vapid.publicKey };
}
