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
    ],
    own_app_steps: [
      "In Meta Business Suite, check that your Facebook Page and its Instagram account both sit in your business portfolio.",
      "At developers.facebook.com, create a Business app owned by that same portfolio.",
      "Add the Pages and Instagram use cases to the app.",
      "In your business settings, add a system user, give it your Page and Instagram account, and generate a token for your app with exactly the permissions listed above — no more, no fewer.",
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
      "In your business settings, add a system user, give it your ad account, and generate a token for your app with exactly the permission listed above — no more.",
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

/**
 * Pilot route 1 (P3-20j): who may use Facebook sign-in while Meta hasn't
 * approved open sign-up, and the one thing the exact scope match means
 * for it. Shown beside the button, so nobody signs in to be refused.
 */
export const TESTER_NOTE =
  "During the pilot, Facebook sign-in works only for invited testers. First Samuel or Tedi at ScaleX adds you as a Tester on ScaleX's Meta app, and you accept the invite from your own Facebook account. Meta then asks you to approve exactly the permissions listed above, and you pick the Page or ad account here.";

/**
 * Meta hands SYB's app every permission a person ever granted it, so a
 * Facebook sign-in for the second consent would carry the first one's
 * permissions too, and the exact match refuses it by name.
 */
export const ONE_CONSENT_PER_FACEBOOK_ACCOUNT =
  "One Facebook account can connect publishing or ad management through sign-in, not both: Meta gives ScaleX's app everything you granted it before, and ScaleX refuses a token holding more than this consent names. For the other one, use your own Meta app below.";

/** Said where Facebook sign-in would be, while META_APP_ID and META_APP_SECRET aren't set. */
export const FACEBOOK_LOGIN_OFF = "Not switched on yet.";

/**
 * P3-20i: what the screen says about Meta's approvals. No line pretends
 * otherwise. `facebookLogin` is whether SYB's Meta app keys are set
 * (P3-20j): without them the sign-in route is shown, and said to be off.
 */
export function accessLevelCopy(level: MetaAccessLevel, facebookLogin = false): AccessLevelCopy {
  if (level === "advanced") {
    return {
      level,
      headline: "Meta has approved ScaleX to ask for these permissions.",
      body: "Any business can connect its own Page, Instagram account or ad account here.",
      routes: [
        {
          title: "Your own Meta app",
          available: true,
          detail: "Set up below, then paste the token.",
        },
        {
          title: "Sign in with Facebook",
          available: facebookLogin,
          detail: facebookLogin
            ? "Sign in, approve the permissions listed, and pick your Page or ad account."
            : FACEBOOK_LOGIN_OFF,
        },
      ],
    };
  }
  return {
    level,
    headline: "Meta hasn't approved ScaleX for open sign-up yet.",
    body: "Until ScaleX's company registration and Meta's approvals (Advanced Access, Business Verification and Tech Provider verification) are in place, Meta itself refuses these permissions on any Page or ad account ScaleX's own business doesn't own. Two pilot routes work meanwhile.",
    routes: [
      {
        title: "Invited testers: sign in with Facebook",
        available: facebookLogin,
        detail: facebookLogin
          ? "For testers the ScaleX team has added in Meta: Samuel or Tedi adds you in ScaleX's Meta app first, and you accept the invite."
          : `For testers the ScaleX team has added in Meta. ${FACEBOOK_LOGIN_OFF}`,
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
  "Connecting proves the token and records your consent. Nothing is published or changed until you approve each item, and publishing through ScaleX isn't switched on yet.";

/** Said beside disconnect: SYB's side forgets; Meta's side is the owner's to revoke. */
export const DISCONNECT_NOTE =
  "Disconnecting deletes the token here at once. It revokes nothing on Meta's side: to withdraw the permissions there, remove the app from your business settings.";

/**
 * P3-22d: the Marketing API access tier, said honestly. Meta reports it on
 * every ads call (`ads_api_access_tier`); the executor stores the last one
 * on the connection and the screen shows it verbatim beside these words.
 */
export const ADS_ACCESS_TIER_WORDS: Readonly<Record<string, string>> = {
  development_access: "development tier: Meta's lowest limits, meant for building",
  standard_access: "standard access: about 300 + 40 × active ads calls an hour on this ad account",
};

/** Before the first ads call there is nothing to show — and the screen says so. */
export const ADS_ACCESS_TIER_UNSEEN =
  "not seen yet — Meta reports it on ScaleX's first call for an ad change";

/** Beside the tier: what it means for the owner, and what lifts it. */
export const ADS_ACCESS_TIER_NOTE =
  "Meta limits how many calls ScaleX may make on this ad account each hour, by tier. That is enough for one business, not a customer base. ScaleX waits for the next run whenever Meta reports 75% of the limit used. Higher limits need Meta's review, which ScaleX applies for once 500 successful calls in 15 days exist.";

/** Pure: the tier as the owner reads it. Unknown tiers are shown as Meta named them. */
export function accessTierWords(tier: string | null): string {
  if (tier === null) return ADS_ACCESS_TIER_UNSEEN;
  return ADS_ACCESS_TIER_WORDS[tier] ?? tier;
}
