// smoke:email — one sign-in email through the real sendLoginEmail path,
// and Resend's answer (its status and email id, nothing else).
//
// The link opens <APP_URL>/login and carries no token, so the email signs
// nobody in: what is under test is delivery — the key, the verified
// sender, the inbox — not the token, which the unit tests already cover.
// Nothing is written to the database.

import type { SendResult } from "../../lib/auth/email";
import type { Env, Print } from "./common";
import {
  Report,
  databaseLine,
  domainOf,
  fromAddress,
  httpsOrigin,
  missingKeys,
  parseArgs,
  plainAddress,
} from "./common";

export interface EmailDeps {
  send: (mail: { to: string; link: string }) => Promise<SendResult>;
}

export const EMAIL_KEYS = ["RESEND_API_KEY", "EMAIL_FROM", "APP_URL"] as const;

export async function runSmokeEmail(args: {
  env: Env;
  argv: readonly string[];
  print: Print;
  deps: EmailDeps;
}): Promise<number> {
  const { env, print, deps } = args;
  const r = new Report(print, env);
  const { flags, values } = parseArgs(args.argv);
  r.line("smoke:email — one sign-in email through sendLoginEmail, and Resend's answer.");
  r.line(`${databaseLine(env.DATABASE_URL)} This script doesn't use it.`);

  const missing = missingKeys(env, EMAIL_KEYS);
  if (missing.length > 0) {
    return r.refuse(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set.`);
  }
  const to = plainAddress(values.get("to"));
  if (!to) return r.refuse("Give the address to send to: --to you@your-domain.");
  const from = fromAddress(env.EMAIL_FROM);
  if (!from)
    return r.refuse(
      `EMAIL_FROM isn't an address I can read; write it as "SYB <hello@your-domain>".`,
    );
  if (from === "onboarding@resend.dev") {
    return r.refuse(
      "EMAIL_FROM is Resend's sandbox address, which only reaches the Resend account's owner. Use your verified domain.",
    );
  }
  const origin = httpsOrigin(env.APP_URL);
  if (!origin) return r.refuse("APP_URL must be an https origin, such as https://your-domain.");

  const link = `${origin}/login`;
  r.line(`About to send one email from ${domainOf(env.EMAIL_FROM)} to ${to}.`);
  r.line(`Its link opens ${link} and carries no token, so it signs nobody in.`);
  if (!flags.has("yes")) return r.refuse("Run it again with --yes to send.");

  let sent: SendResult;
  try {
    sent = await deps.send({ to, link });
  } catch (error) {
    r.fail(
      `The send threw before Resend answered (${(error as Error).name}). Check the network and RESEND_API_KEY.`,
    );
    return r.finish();
  }
  const status = sent.provider?.status;
  const id = sent.provider?.id ?? null;
  if (
    r.check(
      sent.delivered_via === "resend",
      `Resend accepted the email: status ${status ?? "unknown"}, id ${id ?? "none given"}.`,
      status === undefined
        ? "No request reached Resend."
        : `Resend refused the email: status ${status}. A 403 usually means the sender's domain isn't verified; 401 a wrong key; 429 the rate limit.`,
    )
  ) {
    r.check(
      id !== null,
      "Resend gave the email an id, so it can be found in Resend → Emails.",
      "Resend gave no email id.",
    );
  }
  if (sent.delivered_via === "resend") {
    r.line(
      `Now check ${to}: the email should arrive within a minute, from ${from}, and not in spam.`,
    );
  }
  return r.finish();
}
