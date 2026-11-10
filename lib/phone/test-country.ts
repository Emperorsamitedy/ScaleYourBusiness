// Test support for hard rule 6 (the v1 build spec §9.2): a phone line answers
// only where its business's country is unblocked in the compliance matrix,
// so the phone suites put their businesses in Hungary and unblock Hungary
// for the suite — then put its row back exactly as it was. Imported by tests
// only — no entry point of the phone tier reaches it.

import type { CountryRule } from "../compliance/matrix";
import { countryRule, removeCountryRule, setCountryRule } from "../compliance/matrix";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";

const ACTOR = "test suite";

function restoreOf(country: string, before: CountryRule | null): () => Promise<void> {
  return async () => {
    if (before === null) {
      if (await countryRule(country)) {
        await removeCountryRule({ country, actor: ACTOR, reason: "test: put the row back" });
      }
      return;
    }
    await setCountryRule({
      country,
      change: {
        recording_regime: before.recording_regime,
        criminal_penalty: before.criminal_penalty,
        outbound_consent_required: before.outbound_consent_required,
        legal_signoff_date: before.legal_signoff_date,
        legal_signoff_reference: before.legal_signoff_reference,
        blocked: before.blocked,
        outbound_blocked: before.outbound_blocked,
        execution_halted: before.execution_halted,
        note: before.note,
      },
      actor: ACTOR,
      reason: "test: put the row back",
    });
  };
}

/** Unblock the suite's country in the matrix; returns the restore for afterAll. */
export async function switchPhoneCountryOn(country = "HU"): Promise<() => Promise<void>> {
  const before = await countryRule(country);
  await setCountryRule({
    country,
    change: {
      blocked: false,
      execution_halted: false,
      legal_signoff_date: "2026-11-10",
      legal_signoff_reference: "test suite sign-off — never a real one",
    },
    actor: ACTOR,
    reason: "test: unblock phone answering for the suite",
  });
  return restoreOf(country, before);
}

/** Block the country again mid-suite (the switch's restore still puts the original back). */
export async function blockPhoneCountry(country = "HU"): Promise<void> {
  await setCountryRule({
    country,
    change: { blocked: true, outbound_blocked: true },
    actor: ACTOR,
    reason: "test: block phone answering",
  });
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
