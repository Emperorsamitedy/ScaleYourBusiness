// The consent screen's data — P3-20h and P3-20i (Session D, layer D1).
//
// What the Execution section of /connections renders, kept as data the
// way SCOPE_GUIDE renders the read side: which write connections are
// offered, what the owner pastes, the phrase they type to confirm, the
// step-by-step setup for the owner's own Meta app (pilot route 2), and
// the access-level wording. The consent lines themselves are NOT here:
// the screen renders EXECUTION_SCOPE_REGISTRY's `consent` verbatim, so it
// cannot promise anything the registry doesn't declare.
//
// Access-level honesty (P3-20i): until Meta grants Advanced Access,
// Business Verification and Tech Provider verification, Meta refuses
// these permissions on assets SYB's own business doesn't own. The screen
// says so from META_ACCESS_LEVEL rather than guessing on Meta's behalf.

import type { MetaAccessLevel } from "../env";
import type { ExecutionProviderId } from "./scopes";

export interface ExecutionCredentialField {
  name: string;
  label: string;
  placeholder: string;
  secret: boolean;
  /** Optional fields may be left empty; everything else is required. */
  optional?: boolean;
}

export interface ExecutionSetup {
  /** What the owner types to confirm — the act, in their words, not "OK". */
  confirm_phrase: string;
  credential_fields: readonly ExecutionCredentialField[];
  /** Pilot route 2: the owner's own Meta app, step by step. */
  own_app_steps: readonly string[];
}

/** Offered on the consent screen. The fixtures are proven in tests, never offered. */
export const OFFERED_EXECUTION: readonly ExecutionProviderId[] = ["meta_publish", "meta_ads"];

export const EXECUTION_SETUP: Readonly<Partial<Record<ExecutionProviderId, ExecutionSetup>>> = {
  meta_publish: {
    confirm_phrase: "allow publishing",
    credential_fields: [
      {
        name: "access_token",
        label: "access token",
        placeholder: "System user access token",
        secret: true,
      },
      { name: "page_id", label: "Page id", placeholder: "Facebook Page id", secret: false },
      {
        name: "ig_user_id",
        label: "Instagram account id",
        placeholder: "Instagram account id (to publish there too)",
        secret: false,
        optional: true,
      },
      {
        name: "page_access_token",
        label: "Page token",
        placeholder: "Page token (only if asked for one)",
        secret: true,
        optional: true,
      },
    ],
    own_app_steps: [
      "In Meta Business Suite, check that your Facebook Page and its Instagram account both sit in your business portfolio.",
      "At developers.facebook.com, create a Business app owned by that same portfolio.",
      "Add the Pages and Instagram use cases to the app.",
      "In your business settings, add a system user, give it your Page and Instagram account, and generate a token for your app with exactly the permissions listed below — no more, no fewer.",
      "Paste the token here with your Page id and, to publish to Instagram too, the Instagram account id.",
    ],
  },
  meta_ads: {
    confirm_phrase: "allow ad changes",
    credential_fields: [
      {
        name: "access_token",
        label: "access token",
        placeholder: "System user access token",
        secret: true,
      },
      {
        name: "ad_account_id",
        label: "ad account id",
        placeholder: "Ad account id, with or without act_",
        secret: false,
      },
    ],
    own_app_steps: [
      "In Meta Business Suite, check that your ad account sits in your business portfolio.",
      "At developers.facebook.com, create a Business app owned by that same portfolio.",
      "Add the Marketing API use case to the app.",
      "In your business settings, add a system user, give it your ad account, and generate a token for your app with exactly the permission listed below — no more.",
      "Paste the token here with the ad account id from Ads Manager.",
    ],
  },
};

/** The typed confirmation matches when it is the phrase, ignoring case and outer spaces. */
export function confirmationMatches(provider: ExecutionProviderId, typed: string): boolean {
  const phrase = EXECUTION_SETUP[provider]?.confirm_phrase;
  return phrase !== undefined && typed.trim().toLowerCase() === phrase;
}

export interface AccessLevelCopy {
  level: MetaAccessLevel;
  headline: string;
  body: string;
  routes: { title: string; available: boolean; detail: string }[];
}

/** P3-20i: what the screen says about Meta's approvals. No line pretends otherwise. */
export function accessLevelCopy(level: MetaAccessLevel): AccessLevelCopy {
  if (level === "advanced") {
    return {
      level,
      headline: "Meta has approved SYB to ask for these permissions.",
      body: "Any business can connect its own Page, Instagram account or ad account here.",
      routes: [
        {
          title: "Your own Meta app",
          available: true,
          detail: "Set up below, then paste the token.",
        },
        {
          title: "Sign in with Facebook",
          available: false,
          detail: "Not switched on yet.",
        },
      ],
    };
  }
  return {
    level,
    headline: "Meta hasn't approved SYB for open sign-up yet.",
    body: "Until SYB's company registration and Meta's approvals (Advanced Access, Business Verification and Tech Provider verification) are in place, Meta itself refuses these permissions on any Page or ad account SYB's own business doesn't own. Two pilot routes work meanwhile.",
    routes: [
      {
        title: "Invited testers: sign in with Facebook",
        available: false,
        detail: "For testers the SYB team has added in Meta. Not switched on yet.",
      },
      {
        title: "Your own Meta app",
        available: true,
        detail: "Your app, your business portfolio, your token. Set up below.",
      },
    ],
  };
}

/** Said beside every consent: connecting proves and records; it publishes nothing. */
export const NOTHING_SENT_YET =
  "Connecting proves the token and records your consent. Nothing is published or changed until you approve each item, and publishing through SYB isn't switched on yet.";

/** Said beside disconnect: SYB's side forgets; Meta's side is the owner's to revoke. */
export const DISCONNECT_NOTE =
  "Disconnecting deletes the token here at once. It revokes nothing on Meta's side: to withdraw the permissions there, remove the app from your business settings.";
