// What the queue's evidence lines rest on (the approval-queue design,
// 2026-10-17: "3 · EVIDENCE — every line opens its record").
//
// A scenario assumption may name the profile field it came from
// (`source_field`). For those, the queue prints the field's basis class
// (components/report/basis.ts) and its source — read here from the
// CURRENT record, never a superseded one (rule 3). And when an open
// contradiction finding (validation_findings, kind "contradiction")
// touches one of those fields, the sheet says the sources disagree,
// with the finding's own message. Nothing here is inferred: no source
// field, no basis lookup; no open contradiction, no disagreement box.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { fieldRecords, validationFindings } from "../../db/schema";
import { displaySourceKind } from "../connectors/measured";

/** The inputs basisOf() needs, per field key. */
export interface EvidenceFact {
  status: string;
  source_kind: string;
  note: string | null;
  confidence: number;
}

export interface Disagreement {
  finding_id: string;
  field_keys: string[];
  message: string;
}

export interface FindingLike {
  id: string;
  kind: string;
  field_keys: unknown;
  message: unknown;
  resolution: unknown;
}

/**
 * Pure: the open contradiction findings that touch any of `keys`. A
 * resolved finding is history, not a disagreement; a finding with no
 * readable message is still shown, worded from its fields.
 */
export function disagreementsFor(
  findings: readonly FindingLike[],
  keys: ReadonlySet<string>,
): Disagreement[] {
  const out: Disagreement[] = [];
  for (const f of findings) {
    if (f.kind !== "contradiction" || f.resolution !== null) continue;
    const fieldKeys = Array.isArray(f.field_keys)
      ? f.field_keys.filter((k): k is string => typeof k === "string")
      : [];
    if (!fieldKeys.some((k) => keys.has(k))) continue;
    const en = (f.message as { en?: unknown } | null)?.en;
    out.push({
      finding_id: f.id,
      field_keys: fieldKeys,
      message:
        typeof en === "string" && en.trim() !== ""
          ? en.trim()
          : `${fieldKeys.join(" and ")} do not agree.`,
    });
  }
  return out;
}

/** Every source_field the given scenarios name. */
export function sourceFieldsOf(scenarios: readonly unknown[]): string[] {
  const keys = new Set<string>();
  for (const sc of scenarios) {
    const assumptions = (sc as { assumptions?: unknown } | null)?.assumptions;
    if (!Array.isArray(assumptions)) continue;
    for (const a of assumptions) {
      const k = (a as { source_field?: unknown } | null)?.source_field;
      if (typeof k === "string" && k !== "") keys.add(k);
    }
  }
  return [...keys];
}

/** The current record of each named field, as basis inputs, plus the open disagreements. */
export async function readEvidence(
  profileId: string,
  keys: readonly string[],
): Promise<{ facts: Record<string, EvidenceFact>; disagreements: Disagreement[] }> {
  if (keys.length === 0) return { facts: {}, disagreements: [] };
  const [rows, findings] = await Promise.all([
    db
      .select({
        field_key: fieldRecords.field_key,
        status: fieldRecords.status,
        source: fieldRecords.source,
        note: fieldRecords.note,
        confidence: fieldRecords.confidence,
      })
      .from(fieldRecords)
      .where(
        and(
          eq(fieldRecords.profile_id, profileId),
          inArray(fieldRecords.field_key, [...keys]),
          isNull(fieldRecords.superseded_at),
        ),
      ),
    db
      .select({
        id: validationFindings.id,
        kind: validationFindings.kind,
        field_keys: validationFindings.field_keys,
        message: validationFindings.message,
        resolution: validationFindings.resolution,
      })
      .from(validationFindings)
      .where(
        and(
          eq(validationFindings.profile_id, profileId),
          eq(validationFindings.kind, "contradiction"),
          isNull(validationFindings.resolution),
        ),
      ),
  ]);
  const facts: Record<string, EvidenceFact> = {};
  for (const r of rows) {
    facts[r.field_key] = {
      status: r.status,
      source_kind: displaySourceKind(r.source),
      note: r.note,
      confidence: Number(r.confidence),
    };
  }
  return { facts, disagreements: disagreementsFor(findings, new Set(keys)) };
}
