// smoke:inbound — the support inbox, end to end, with a person in the loop.
//
// It prints the business's inbound address and the steps to send it one
// email, then watches the database (read-only) until a ticket from that
// sender lands, or the timeout passes. The email itself is the tester's
// own; the script writes nothing — the deployed webhook does, exactly as
// it would for a customer.

import type { Env, Print } from "./common";
import {
  Report,
  databaseLine,
  httpsOrigin,
  missingKeys,
  ownSenderAddresses,
  parseArgs,
  plainAddress,
} from "./common";

export interface InboundLanding {
  ticket_id: string;
  channel: string;
  status: string;
  sender_auth: string | null;
  has_contact: boolean;
  suppressed_address: boolean;
}

export interface InboundDeps {
  /** The routing token of the business's inbound address, or null when it has no support settings. */
  inboundToken: (profileId: string) => Promise<string | null>;
  /** Ids of inbound messages from this sender already on file, so an old one isn't mistaken for the test. */
  seenMessageIds: (profileId: string, from: string) => Promise<string[]>;
  /** A new inbound message from this sender, not among `seen`, with its ticket. */
  findLanding: (
    profileId: string,
    from: string,
    seen: readonly string[],
  ) => Promise<InboundLanding | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const INBOUND_KEYS = ["DATABASE_URL", "SUPPORT_INBOUND_DOMAIN"] as const;
export const DEFAULT_TIMEOUT_S = 180;
export const MAX_TIMEOUT_S = 900;
export const POLL_MS = 5_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runSmokeInbound(args: {
  env: Env;
  argv: readonly string[];
  print: Print;
  deps: InboundDeps;
}): Promise<number> {
  const { env, print, deps } = args;
  const r = new Report(print, env);
  const { values } = parseArgs(args.argv);
  r.line("smoke:inbound — one email to a business's inbound address becomes a ticket.");
  r.line(databaseLine(env.DATABASE_URL));

  const missing = missingKeys(env, INBOUND_KEYS);
  if (missing.length > 0) {
    return r.refuse(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set.`);
  }
  const domain = env.SUPPORT_INBOUND_DOMAIN!.trim().toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    return r.refuse("SUPPORT_INBOUND_DOMAIN isn't a domain I can read.");
  }
  const profileId = values.get("profile")?.trim() ?? "";
  if (!UUID_RE.test(profileId))
    return r.refuse("Give the business's profile id: --profile <uuid>.");
  const from = plainAddress(values.get("from"));
  if (!from) return r.refuse("Give the address you'll send from: --from you@your-domain.");
  if (ownSenderAddresses(env).includes(from)) {
    return r.refuse(
      `${from} is one of ScaleX's own sending addresses, and the inbox drops its own mail by design. Send from another address.`,
    );
  }
  const timeoutRaw = values.get("timeout");
  const timeoutS =
    timeoutRaw === undefined
      ? DEFAULT_TIMEOUT_S
      : Math.min(MAX_TIMEOUT_S, Math.max(10, Number.parseInt(timeoutRaw, 10) || DEFAULT_TIMEOUT_S));
  if ((env.RESEND_WEBHOOK_SECRET?.trim() ?? "") === "") {
    r.line(
      "Note: RESEND_WEBHOOK_SECRET isn't set in this shell. That's fine here, but the deployment must have it, or its inbox refuses every delivery.",
    );
  }

  const token = await deps.inboundToken(profileId);
  if (
    !r.check(
      token !== null,
      "The business has support settings, so it has an inbound address.",
      "This business has no support settings yet. Sign in as its owner and open /support once; that creates the inbound address.",
    )
  ) {
    return r.finish();
  }
  const address = `s-${token}@${domain}`;
  const seen = await deps.seenMessageIds(profileId, from);
  r.line("");
  r.line(`The business's inbound address is ${address}`);
  r.line("Do this now:");
  r.line(`  a. From ${from}, write a new email to ${address}.`);
  r.line(
    `  b. Give it any subject, such as "Smoke test: inbound", and a line of text. Don't use a real customer's words.`,
  );
  r.line(`  c. Send it. I'll watch for the ticket for ${timeoutS} seconds.`);
  r.line(
    "  (If the business forwards its own support mailbox here, sending to that mailbox tests the forward too.)",
  );
  r.line("");

  const deadline = deps.now() + timeoutS * 1000;
  let landing: InboundLanding | null = null;
  while (deps.now() < deadline) {
    landing = await deps.findLanding(profileId, from, seen);
    if (landing) break;
    await deps.sleep(POLL_MS);
  }
  if (
    !r.check(
      landing !== null,
      `A ticket landed from ${from}: ticket ${landing?.ticket_id}, by email, ${landing?.status}.`,
      `No ticket from ${from} within ${timeoutS} seconds. Check, in order: the domain's MX record points at Resend; Resend → Webhooks has ${httpsOrigin(env.APP_URL) ?? "<APP_URL>"}/api/support/inbound for email.received and its log shows a 200; the deployment's RESEND_WEBHOOK_SECRET is that webhook's secret.`,
    )
  ) {
    return r.finish();
  }
  const l = landing!;
  r.check(
    l.channel === "email",
    "The ticket's channel is email.",
    `The ticket's channel is ${l.channel}, not email.`,
  );
  r.line(
    `Sender authentication: ${l.sender_auth ?? "not recorded"}${l.sender_auth === "verified" ? "" : " — an unverified sender is never tied to an existing contact, by design"}.`,
  );
  r.line(
    l.suppressed_address
      ? "The address is on the suppression list, so no contact was made and replies to it are refused."
      : l.has_contact
        ? "The sender is a consent-unsure contact now. Erase it on /customers when you're done, so it doesn't sit in the owner's list."
        : "No contact is tied to the ticket.",
  );
  return r.finish();
}
