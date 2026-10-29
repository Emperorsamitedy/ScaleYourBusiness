// Reading Eurostat's JSON-stat 2.0 answers — idea 44, I-44.1. Pure: the
// fetch lives in scripts/fetch-benchmarks.ts, run by hand; the app never
// reaches Eurostat (no runtime network) and reads only the dated snapshot
// that script writes, specs/benchmarks-eurostat-v1.json.
//
// What Eurostat's API returns (checked 2026-10-29 against
// /eurostat/web/user-guides/data-browser/api-data-access/ and live answers):
//   · `id` names the dimensions in order and `size` their lengths;
//     `dimension[d].category.index` maps a code to its position.
//   · `value` is sparse: an object keyed by the flat row-major position
//     (the last dimension varies fastest). A position that isn't there
//     has no value. Never read as zero.
//   · `status` is sparse the same way, holding a flag where there is one,
//     with or without a value: "e" (estimated) beside a value, "|C"
//     (confidential) with none. `extension.status.label` names the flags
//     the answer carries.
//   · `updated` is the dataset's last update, an ISO date-time.

export interface JsonStat {
  version?: string;
  label?: string;
  updated?: string;
  id: string[];
  size: number[];
  dimension: Record<
    string,
    { label?: string; category: { index: Record<string, number>; label?: Record<string, string> } }
  >;
  value: Record<string, number | null> | (number | null)[];
  status?: Record<string, string> | string[];
  extension?: { status?: { label?: Record<string, string> } };
}

/** One observation: its codes by dimension, its value (null: none published) and flag. */
export interface Observation {
  codes: Record<string, string>;
  value: number | null;
  flag: string | null;
}

function at<T>(src: Record<string, T> | T[] | undefined, n: number): T | undefined {
  if (src === undefined) return undefined;
  return Array.isArray(src) ? src[n] : src[String(n)];
}

/** Pure: every position that holds a value or a flag, decoded. Empty positions are skipped. */
export function observations(d: JsonStat): Observation[] {
  if (d.id.length !== d.size.length) throw new Error("JSON-stat: id and size disagree");
  const codesByDim = d.id.map((dim) => {
    const index = d.dimension[dim]?.category.index;
    if (!index) throw new Error(`JSON-stat: no index for ${dim}`);
    const codes: string[] = [];
    for (const [code, pos] of Object.entries(index)) codes[pos] = code;
    return codes;
  });
  const total = d.size.reduce((n, s) => n * s, 1);
  const out: Observation[] = [];
  for (let n = 0; n < total; n++) {
    const raw = at(d.value, n);
    const flag = at(d.status, n) ?? null;
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    if (value === null && flag === null) continue;
    const codes: Record<string, string> = {};
    let rest = n;
    for (let i = d.id.length - 1; i >= 0; i--) {
      const size = d.size[i]!;
      codes[d.id[i]!] = codesByDim[i]![rest % size]!;
      rest = Math.floor(rest / size);
    }
    out.push({ codes, value, flag: flag === "" ? null : flag });
  }
  return out;
}

/** Pure: the flag labels an answer carries ("|C" → "confidential"), trimmed of Eurostat's pipes. */
export function flagLabels(d: JsonStat): Record<string, string> {
  const labels = d.extension?.status?.label ?? {};
  const out: Record<string, string> = {};
  for (const [code, label] of Object.entries(labels)) {
    out[code] = label.replace(/^\|/, "").trim();
  }
  return out;
}

/** True when a flag marks a confidential cell: Eurostat's "c", sent as "|C" on this API. */
export function isConfidential(flag: string | null): boolean {
  return flag !== null && /(^|\|)c$/i.test(flag.trim());
}

/** A cell's figure for one indicator: its latest year with a value, or why there is none. */
export type Latest =
  | { value: number; year: number; flag?: string }
  | { missing: "confidential"; year: number }
  | { missing: "not_published" };

/**
 * Pure: the latest year with a value among one cell's observations for one
 * indicator. With none, "confidential" when Eurostat flagged a year so
 * (the latest such year), else "not_published". Never a zero.
 */
export function latest(
  obs: readonly { year: number; value: number | null; flag: string | null }[],
): Latest {
  const sorted = [...obs].sort((a, b) => b.year - a.year);
  const hit = sorted.find((o) => o.value !== null);
  if (hit && hit.value !== null) {
    return hit.flag
      ? { value: hit.value, year: hit.year, flag: hit.flag }
      : { value: hit.value, year: hit.year };
  }
  const secret = sorted.find((o) => isConfidential(o.flag));
  return secret ? { missing: "confidential", year: secret.year } : { missing: "not_published" };
}
