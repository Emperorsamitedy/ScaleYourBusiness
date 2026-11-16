// The track record's five counts as one stacked bar (components/charts/Viz
// SegBar) — the same figures lib/forecasts/view counts for the headline.

import type { Seg, Tone } from "../charts/Viz";
import type { TrackView, TrackWord } from "../../lib/forecasts/view";

const ORDER: readonly { word: TrackWord; tone: Tone }[] = [
  { word: "inside", tone: "ok" },
  { word: "above", tone: "ink" },
  { word: "below", tone: "alarm" },
  { word: "cant_tell", tone: "soft" },
  { word: "waiting", tone: "hollow" },
];

/** Pure: one segment per outcome, in the record's order; none when no forecast is counted. */
export function trackSegs(
  track: Pick<TrackView, TrackWord>,
  word: (w: TrackWord) => string,
): Seg[] {
  if (ORDER.every((o) => track[o.word] <= 0)) return [];
  return ORDER.map((o) => ({
    key: o.word,
    label: word(o.word),
    value: track[o.word],
    tone: o.tone,
  }));
}
