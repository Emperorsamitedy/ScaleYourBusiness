// Write access on /connections in the reader's words — L-3d. Pure, and
// safe in the browser.
//
// lib/execution/setup.ts and lib/execution/scopes.ts stay the source of
// what the consent screen says, in English, and the API still sends it.
// These say the same lines from the "connections.write" catalogue, keyed
// by the setup's own ids (the access level, the tier, the operation, the
// step's place), so another language reads them too; words.test.ts holds
// every English line to the setup's own. The consent lines and the
// confirmation phrase are not here: a consent's hash covers them as shown
// and typed, so they stay the registry's English.

import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";

export interface AccessWords {
  level: string;
  headline: string;
  body: string;
  routes: { title: string; available: boolean; detail: string }[];
}

const english = () => englishTr("connections.write");

/** accessLevelCopy (lib/execution/setup.ts), said in the reader's words. */
export function accessWords(
  level: "standard" | "advanced",
  facebookLogin: boolean,
  tr: Tr = english(),
): AccessWords {
  const off = tr("facebookOff");
  if (level === "advanced") {
    return {
      level,
      headline: tr("access.advanced.headline"),
      body: tr("access.advanced.body"),
      routes: [
        { title: tr("route.ownApp"), available: true, detail: tr("route.ownAppAdvanced") },
        {
          title: tr("route.signIn"),
          available: facebookLogin,
          detail: facebookLogin ? tr("route.signInOn") : off,
        },
      ],
    };
  }
  return {
    level,
    headline: tr("access.standard.headline"),
    body: tr("access.standard.body"),
    routes: [
      {
        title: tr("route.testers"),
        available: facebookLogin,
        detail: facebookLogin ? tr("route.testersOn") : tr("route.testersOff", { off }),
      },
      { title: tr("route.ownApp"), available: true, detail: tr("route.ownAppStandard") },
    ],
  };
}

/** The figures in the ads access words (ADS_ACCESS_TIER_WORDS, ADS_ACCESS_TIER_NOTE), typed once (rule 3). */
export const ADS_TIER_FIGURES = {
  baseCalls: 300,
  callsPerAd: 40,
  pauseAt: 75,
  reviewCalls: 500,
  reviewDays: 15,
} as const;

/** accessTierWords (lib/execution/setup.ts) in the reader's words; an unknown tier as Meta named it. */
export function tierWords(tier: string | null, tr: Tr = english()): string {
  if (tier === null) return tr("tier.unseen");
  if (tier === "development_access") return tr("tier.development_access");
  if (tier === "standard_access") {
    return tr("tier.standard_access", {
      base: ADS_TIER_FIGURES.baseCalls,
      perAd: ADS_TIER_FIGURES.callsPerAd,
    });
  }
  return tier;
}

/** ADS_ACCESS_TIER_NOTE in the reader's words. */
export function tierNote(tr: Tr = english(), percent = `${ADS_TIER_FIGURES.pauseAt}%`): string {
  return tr("tier.note", {
    share: percent,
    calls: ADS_TIER_FIGURES.reviewCalls,
    days: ADS_TIER_FIGURES.reviewDays,
  });
}
