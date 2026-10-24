// smoke:widget — the support widget, walked by a person.
//
// It prints the business's site key (public by design: it scopes, it
// authenticates nothing), the snippet an owner pastes into their site and
// the /support/test page that embeds it, then what to try and what to
// check. It reads two facts first — that support settings exist, and that
// some knowledge is published to answer from — and writes nothing.

import { widgetSnippet } from "../../lib/support/snippet";
import type { Env, Print } from "./common";
import { Report, databaseLine, httpsOrigin, missingKeys, parseArgs } from "./common";

export interface WidgetDeps {
  /** The business's public site key and name, or null when it has no support settings. */
  settings: (profileId: string) => Promise<{ site_key: string; business_name: string } | null>;
  /** How many knowledge entries are published for strangers to be answered from. */
  approvedKnowledge: (profileId: string) => Promise<number>;
}

export const WIDGET_KEYS = ["DATABASE_URL", "APP_URL"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runSmokeWidget(args: {
  env: Env;
  argv: readonly string[];
  print: Print;
  deps: WidgetDeps;
}): Promise<number> {
  const { env, print, deps } = args;
  const r = new Report(print, env);
  const { values } = parseArgs(args.argv);
  r.line("smoke:widget — the support widget on a test page, walked by you.");
  r.line(databaseLine(env.DATABASE_URL));

  const missing = missingKeys(env, WIDGET_KEYS);
  if (missing.length > 0) {
    return r.refuse(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set.`);
  }
  const origin = httpsOrigin(env.APP_URL);
  if (!origin) return r.refuse("APP_URL must be an https origin, such as https://your-domain.");
  const profileId = values.get("profile")?.trim() ?? "";
  if (!UUID_RE.test(profileId))
    return r.refuse("Give the business's profile id: --profile <uuid>.");

  const settings = await deps.settings(profileId);
  if (
    !r.check(
      settings !== null,
      `The business has a site key, so the widget can greet as "${settings?.business_name}".`,
      "This business has no support settings yet. Sign in as its owner and open /support once; that creates the site key.",
    )
  ) {
    return r.finish();
  }
  const s = settings!;
  const approved = await deps.approvedKnowledge(profileId);
  r.check(
    approved > 0,
    `${approved} knowledge ${approved === 1 ? "entry is" : "entries are"} published, so a covered question can get a grounded answer.`,
    "No knowledge is published, so every question becomes a handover. Approve and publish at least one entry on /support first.",
  );

  r.line("");
  r.line(`Site key (public by design): ${s.site_key}`);
  r.line("The snippet the owner pastes into their site:");
  r.line(`  ${widgetSnippet(origin, s.site_key)}`);
  r.line(`The test page, which embeds the same script: ${origin}/support/test`);
  r.line("  Open it signed in as this business's owner; it reads the owner's own site key.");
  r.line("");
  r.line("Try:");
  r.line("  a. Ask a question one of the published entries covers, in your own words.");
  r.line('  b. Then ask for a person: "Can I talk to a human?"');
  r.line("Check:");
  r.line(
    "  1. Before you type, the widget's head says it is an automated assistant, not a person,",
  );
  r.line("     and that you can ask for a human any time.");
  r.line("  2. The answer to (a) comes from the published entry and invents nothing beyond it.");
  r.line("  3. Asking for a person hands over: the widget says someone will reply, and a ticket");
  r.line("     appears on /support with your question as its summary.");
  r.line(
    "Use test words only, never a real customer's. Erase the conversation on /support afterwards.",
  );
  r.line(
    "The answers run on the deployment, so it needs ANTHROPIC_API_KEY there, whatever this shell holds.",
  );
  return r.finish();
}
