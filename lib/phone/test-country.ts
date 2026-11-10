// Test support for hard rule 6 (architecture-v2 D6): a phone line answers
// only where its business's country is on PHONE_ANSWERING_COUNTRIES, so the
// phone suites put their businesses in Hungary and switch Hungary on.
// Imported by tests only — no entry point of the phone tier reaches it.

import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { PHONE_COUNTRIES_KEY } from "./countries";

/** Switch the suite's country on; returns the restore for afterAll. */
export function switchPhoneCountryOn(countries = "HU"): () => void {
  const saved = process.env[PHONE_COUNTRIES_KEY];
  process.env[PHONE_COUNTRIES_KEY] = countries;
  return () => {
    if (saved === undefined) delete process.env[PHONE_COUNTRIES_KEY];
    else process.env[PHONE_COUNTRIES_KEY] = saved;
  };
}

/** legal.country as an owner would type it. */
export async function inPhoneCountry(profileId: string, country = "Hungary"): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<string>({
      id: fieldId("legal.country"),
      value: country,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}
