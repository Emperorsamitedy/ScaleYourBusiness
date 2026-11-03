// The intake's live reading — one derived figure that moves as answers land
// (owner design intake-v2, right column).
//
// The figure is lib/economics' own arithmetic (rule 6: it carries its
// formula and inputs), run on the CURRENT records rather than a snapshot.
// The intake state is re-read after every answer; taking a snapshot per
// read would write a frozen copy of the profile each time for a view
// nobody needs to reproduce (the same reasoning as record-view.ts). So the
// view is assembled in memory from the rows the service already loaded,
// and nothing is written.
//
// Pure: rows in, view and reading out.

import type { EconomicsResult } from "../economics/unit-economics";
import type { EconWords } from "../economics/words";
import { ENGLISH_ECON, econText } from "../economics/words";
import type { Field } from "../core/field";
import type { FieldRecordRow } from "../profile/field-codec";
import { rowToField } from "../profile/field-codec";
import type { SnapshotEntity, SnapshotView } from "../profile/snapshot";
import type { LiveReading } from "./types";

/**
 * A SnapshotView over the current records, for computeEconomics. It is
 * NOT a snapshot: nothing is stored, so its summary names no snapshot
 * (id "current-records", empty hash). Only `facts` and `entities` are read
 * by the economics engine. A row that fails the Field codec is left out
 * rather than allowed in without its invariants.
 */
export function currentRecordsView(
  profileId: string,
  rows: readonly FieldRecordRow[],
  entities: readonly SnapshotEntity[],
  at: string,
): SnapshotView {
  const facts = new Map<string, Field<unknown>>();
  for (const row of rows) {
    try {
      facts.set(row.field_key, rowToField<unknown>(row));
    } catch {
      // A corrupt row cannot re-enter the system wearing a Field's type.
    }
  }
  return {
    summary: {
      id: "current-records",
      profile_id: profileId,
      taken_at: at,
      content_hash: "",
      fact_count: facts.size,
      entity_count: entities.length,
      reason: "current-records",
    },
    facts,
    entities: [...entities],
  };
}

/**
 * The figure the card shows: the blended margin, when the economics engine
 * could compute one. It is the one percentage the engine produces on a
 * fixed 0–100 scale, which is what a dial needs; money figures have no
 * natural scale to put a needle on. Null — and the card hides — when the
 * engine refused (no priced offer with a cost to deliver).
 *
 * L-4a: the label and the formula in the reader's language ("econWords"),
 * English by default.
 */
export function liveReadingOf(
  economics: EconomicsResult,
  words: EconWords = ENGLISH_ECON,
): LiveReading | null {
  const blended = economics.blended_margin_pct;
  if (blended === null || !Number.isFinite(blended.value)) return null;
  return {
    label: words.tr("live.label"),
    value_pct: blended.value,
    formula: econText(blended.formula, "formula", words),
    inputs: new Set(blended.derived_from).size,
    stated_pct: economics.stated_vs_computed_margin?.stated_pct ?? null,
  };
}
