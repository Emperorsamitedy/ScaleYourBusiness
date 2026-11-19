// What a Meta refusal means, said once — P3-24a (Session D, layer D5).
//
// Every Graph API error the write connector meets is mapped HERE to the
// four things the rest of the system needs: the sentence the owner reads,
// what happens to the connection, the next step, and whether to try again.
// One table, so /connections, /content, the watch log and the attempt
// journal can never tell an owner four different stories about the same
// refusal (rule P3-24: failure honesty, never silent).
//
// The code sets are the read connector's (lib/connectors/providers/
// meta-ads.ts): auth 102/190, permission 10/200/294 (plus 100 with subcode
// 33, "object missing or no permission"), rate limit 4/17/32/613, and
// 80001, the Page business-use-case limit. Codes met at build time are
// added here with the test that met them. Anything else gets the honest
// default: "Meta refused with code N; nothing was published" (or "changed",
// for an ad change — P3-22b).

import { AUTH_CODES, PERMISSION_CODES, RATE_LIMIT_CODES } from "../connectors/providers/meta-ads";

export type MetaFailureKind =
  "auth" | "permission" | "rate_limit" | "page_limit" | "unavailable" | "unknown";

/** What the connection becomes: paused waits for the owner; connected keeps going. */
export type ConnectionStateAfter = "paused" | "connected";

export type NextStep = "reconnect" | "wait" | "check_item";

export interface MetaFailure {
  kind: MetaFailureKind;
  code: number | null;
  subcode: number | null;
  owner_sentence: string;
  connection_state: ConnectionStateAfter;
  next_step: NextStep;
  /** Worth another attempt after a pause — never true for anything the owner must fix. */
  retryable: boolean;
}

// The read connector's code sets — one source, imported, never copied.
export { AUTH_CODES, PERMISSION_CODES, RATE_LIMIT_CODES };
/** The Page business-use-case rate limit. */
export const PAGE_LIMIT_CODE = 80001;
/** Meta's own "temporary — try again" codes: 1 (API unknown) and 2 (service unavailable). */
export const TEMPORARY_CODES: ReadonlySet<number> = new Set([1, 2]);

const RECONNECT = "Reconnect it on Connections and I'll pick up where I left off.";

/** Why the sign-in stopped working, when Meta says (code 190's subcodes). */
const AUTH_SUBCODE_REASON: Readonly<Record<number, string>> = {
  458: "ScaleX's app was removed from the Meta account",
  460: "the Meta account's password changed, which signs out every app",
  463: "the connection's sign-in expired",
  467: "the connection's sign-in is no longer valid",
};

/**
 * P3-24b: what every piece of work held up by a paused connection says —
 * the one sentence, whichever item or change it is, so /content, the
 * attempt journal and the watch log tell the owner the same thing. The
 * connection itself carries the classified sentence (why it stopped).
 */
export const PAUSED_WORK_SENTENCE: Readonly<Record<"publish" | "ad_change", string>> = {
  publish: "I couldn't post — the connection expired. Reconnect and I'll pick up where I left off.",
  ad_change:
    "I couldn't change the ad — the connection expired. Reconnect and I'll pick up where I left off.",
};

/** P3-24b: a refusal that pauses the execute connection itself — the auth class, and only it. */
export function pausesConnection(failure: Pick<MetaFailure, "kind">): boolean {
  return failure.kind === "auth";
}

/**
 * Pure: one Meta response (or a failed request: status 0, no code) as the
 * failure the system acts on. Never throws; unknown codes get the default.
 */
export function classifyMetaError(args: {
  status: number;
  code: number | null;
  subcode?: number | null;
  /** What was being done, for the sentence: a publish (default) or an ad change (P3-22b). */
  subject?: "publish" | "ad_change";
}): MetaFailure {
  const { status, code } = args;
  const done = args.subject === "ad_change" ? "changed" : "published";
  const subcode = args.subcode ?? null;
  const base = { code, subcode };

  if (code !== null && AUTH_CODES.has(code)) {
    const why =
      (subcode !== null ? AUTH_SUBCODE_REASON[subcode] : undefined) ??
      "the connection's sign-in expired or was revoked";
    return {
      ...base,
      kind: "auth",
      owner_sentence: `I couldn't reach Meta: ${why}. ${RECONNECT}`,
      connection_state: "paused",
      next_step: "reconnect",
      retryable: false,
    };
  }
  if ((code !== null && PERMISSION_CODES.has(code)) || (code === 100 && subcode === 33)) {
    return {
      ...base,
      kind: "permission",
      owner_sentence:
        "Meta says ScaleX isn't allowed to do that: a permission was removed, or the Page or account isn't assigned to the connection. Reconnect with the permissions listed on Connections.",
      connection_state: "paused",
      next_step: "reconnect",
      retryable: false,
    };
  }
  if (code === PAGE_LIMIT_CODE) {
    return {
      ...base,
      kind: "page_limit",
      owner_sentence:
        "Meta's limit for this Page is used up for now. Nothing was lost. I'll try again after a pause.",
      connection_state: "connected",
      next_step: "wait",
      retryable: true,
    };
  }
  if ((code !== null && RATE_LIMIT_CODES.has(code)) || status === 429) {
    return {
      ...base,
      kind: "rate_limit",
      owner_sentence:
        "Meta asked ScaleX to slow down. Nothing was lost. I'll try again after a pause.",
      connection_state: "connected",
      next_step: "wait",
      retryable: true,
    };
  }
  if (
    (code !== null && TEMPORARY_CODES.has(code)) ||
    (code === null && (status === 0 || status >= 500))
  ) {
    return {
      ...base,
      kind: "unavailable",
      owner_sentence: `Meta didn't answer just now. Nothing was ${done} — I'll try again.`,
      connection_state: "connected",
      next_step: "wait",
      retryable: true,
    };
  }
  return {
    ...base,
    kind: "unknown",
    owner_sentence: `Meta refused with ${code !== null ? `code ${code}` : `status ${status}`}; nothing was ${done}.`,
    connection_state: "connected",
    next_step: "check_item",
    retryable: false,
  };
}
