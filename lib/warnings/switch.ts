// Warnings sent at once: the email's switch. Pure, so its rule is pinned by a
// unit test. lib/summary/prefs reads and writes users.notification_prefs;
// this decides.
//
//   warning_emails: true | false | absent.
// Absent means on: a warning that looks ahead (money tight in the weeks
// ahead, something that may run out before its next delivery) is worth one
// email the first time it appears, and it reached only the app and the
// Monday summary before. An explicit false is the owner's word and always
// wins. The switch is the owner's own, on Alerts and modules.

export const WARNING_PREF_KEY = "warning_emails";

/** What the owner said, if anything: true, false, or null for "never said". */
export function warningPref(prefs: unknown): boolean | null {
  if (prefs === null || typeof prefs !== "object") return null;
  const value = (prefs as Record<string, unknown>)[WARNING_PREF_KEY];
  return typeof value === "boolean" ? value : null;
}

/** Whether a warning's email goes out: unless the owner switched it off. */
export function warningEmailOn(pref: boolean | null): boolean {
  return pref !== false;
}
