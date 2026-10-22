// Answers a visitor typed BEFORE the intake existed for them — the optional
// "Website" on the sign-up screen — waiting in this browser's storage. The
// intake offers them back as a draft in the matching question; nothing is
// recorded until the owner presses Record, so the answer stays theirs, said
// on the record, like any other (rules 2 and 5).
//
// Which field may be prefilled from which key is data (rule 4). The key
// keeps its first name, "pending_store", so anything already saved still reads.

export const BROWSER_PREFILL: Readonly<Record<string, string>> = {
  "presence.website_url": "syb.pending_store",
};

type Store = Pick<Storage, "getItem" | "removeItem">;

function storage(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null; // storage blocked (private window, policy): nothing to offer
  }
}

/** The waiting draft for a field, or null. Never throws. */
export function prefillFor(fieldKey: string, store: Store | null = storage()): string | null {
  const key = BROWSER_PREFILL[fieldKey];
  if (!key || !store) return null;
  try {
    const v = store.getItem(key)?.trim() ?? "";
    return v === "" ? null : v;
  } catch {
    return null;
  }
}

/** Once the field is answered (or skipped), the draft has done its job. */
export function clearPrefill(fieldKey: string, store: Store | null = storage()): void {
  const key = BROWSER_PREFILL[fieldKey];
  if (!key || !store) return;
  try {
    store.removeItem(key);
  } catch {
    /* storage blocked: nothing to clear */
  }
}
