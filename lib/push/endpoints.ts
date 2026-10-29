// Phone-alert subscriptions, the pure half — idea 53 (I-53.2): the device
// label, the push-service allowlist and the shape check of a browser's
// PushSubscription. No database, so send.ts and the tests can use it alone.
//
// The endpoint must belong to a known browser push service. The server
// POSTs to it, so an arbitrary URL from a request body would let anyone
// signed in point SYB at any address (server-side request forgery). The
// allowlist is the push services of the browsers that ship Web Push.

export const DEVICE_LABELS = [
  "iPhone",
  "iPad",
  "Android",
  "Mac",
  "Windows",
  "Linux",
  "Browser",
] as const;
export type DeviceLabel = (typeof DEVICE_LABELS)[number];

/** The coarse word for a user agent. Order matters: an iPhone's agent also says "Mac OS X". */
export function deviceLabel(userAgent: string | null | undefined): DeviceLabel {
  const ua = userAgent ?? "";
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux|CrOS|X11/.test(ua)) return "Linux";
  return "Browser";
}

/**
 * The push services browsers subscribe through: Chrome, Edge-on-Android and
 * other Chromium browsers (FCM), Safari (Apple's, which its guide names as
 * *.push.apple.com), Firefox (Mozilla autopush), and Edge on Windows (WNS).
 */
const PUSH_HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

/** The demo's and tests' own push host. `.invalid` never resolves (RFC 2606). */
export const FAKE_PUSH_HOST = "push.syb.invalid";

/** An https URL on a known push service, default port, no credentials. The fake host only when asked. */
export function isPushEndpoint(raw: string, opts: { allowFake?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (opts.allowFake && host === FAKE_PUSH_HOST) return true;
  return PUSH_HOSTS.some((re) => re.test(host));
}

export interface PushTarget {
  endpoint: string;
  /** base64url P-256 public key of the browser. */
  p256dh: string;
  /** base64url 16-byte auth secret. */
  auth: string;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** A browser's PushSubscription.toJSON(), checked. A string says what is wrong with it. */
export function parseSubscription(
  input: unknown,
  opts: { allowFake?: boolean } = {},
): PushTarget | string {
  if (input === null || typeof input !== "object") return "the subscription is missing";
  const s = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== "string" || s.endpoint.length > 2048) {
    return "the subscription has no endpoint";
  }
  if (!isPushEndpoint(s.endpoint, opts)) {
    return "that isn't a browser push service I send to";
  }
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== "string" || !B64URL.test(p256dh) || p256dh.length > 128) {
    return "the subscription's keys are missing";
  }
  if (typeof auth !== "string" || !B64URL.test(auth) || auth.length > 64) {
    return "the subscription's keys are missing";
  }
  if (
    Buffer.from(p256dh, "base64url").length !== 65 ||
    Buffer.from(auth, "base64url").length !== 16
  ) {
    return "the subscription's keys aren't the right size";
  }
  return { endpoint: s.endpoint, p256dh, auth };
}
