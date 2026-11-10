// The owner's guide to creating a NAV technical user — the multi-market spec
// §E.4: Hungarian first, one real screenshot per step.
//
// The steps are data: Hungarian words (English beside them for an owner
// reading in English), and the screenshot each needs under
// public/nav-guide/ (listed for the owner in public/nav-guide/README.md).
// The guide goes live only when every screenshot is there: navGuideReady()
// is the gate the page and /ops read, so it can't ship with an empty slot.

import { existsSync } from "node:fs";
import path from "node:path";

export interface GuideStep {
  image: string;
  hu: string;
  en: string;
}

export const NAV_GUIDE_STEPS: readonly GuideStep[] = [
  {
    image: "step-1-login.png",
    hu: "Lépjen be az Online Számla rendszerbe (onlineszamla.nav.gov.hu) az ügyfélkapus azonosításával.",
    en: "Sign in to Online Számla (onlineszamla.nav.gov.hu) with your government login.",
  },
  {
    image: "step-2-users.png",
    hu: "Nyissa meg a Felhasználók menüt.",
    en: "Open the Users (Felhasználók) menu.",
  },
  {
    image: "step-3-new.png",
    hu: "Válassza az Új felhasználó, majd a Technikai felhasználó lehetőséget.",
    en: "Choose New user (Új felhasználó), then Technical user (Technikai felhasználó).",
  },
  {
    image: "step-4-rights.png",
    hu: "A jogosultságoknál CSAK a Számlák lekérdezése legyen bejelölve. A SYB csak olvas: semmilyen más jogot ne adjon.",
    en: "Under permissions, tick ONLY Query invoices (Számlák lekérdezése). SYB only reads: give it nothing else.",
  },
  {
    image: "step-5-keys.png",
    hu: "Mentés után a NAV megmutatja a felhasználónevet, a jelszót és az aláírókulcsot. Ezeket írja be a SYB-be. A cserekulcsra nincs szükség — a SYB soha nem kéri.",
    en: "After saving, NAV shows the login, password and signature key. Enter those in SYB. The exchange key isn't needed — SYB never asks for it.",
  },
  {
    image: "step-6-done.png",
    hu: "A technikai felhasználó aktívként jelenik meg. Bármikor törölheti: ezzel a SYB hozzáférése is megszűnik.",
    en: "The technical user shows as active. You can delete it any time, which ends SYB's access too.",
  },
];

export const NAV_GUIDE_DIR = path.join("public", "nav-guide");

/** The screenshots still missing, by file name. */
export function navGuideMissing(root: string = process.cwd()): string[] {
  return NAV_GUIDE_STEPS.map((s) => s.image).filter(
    (f) => !existsSync(path.join(root, NAV_GUIDE_DIR, f)),
  );
}

/** The gate: the guide is offered only when every step has its real screenshot. */
export function navGuideReady(root?: string): boolean {
  return navGuideMissing(root).length === 0;
}
