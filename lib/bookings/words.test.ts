// L-4c: the bookings sentences in every language (lib/bookings/words.ts).
// English is held byte for byte to what the code said before L-4 — the
// pre-L-4 builder is kept below as the reference, and every measure of a
// few hundred generated windows must read exactly as it did. Then a few
// sentences in German, Russian plurals at 1/3/5/21, and Chinese joins with
// no space after full-width punctuation.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { DECIMAL_STYLE_MESSAGES } from "../core/money";
import { localeTr } from "../i18n/request-tr";
import type { AppLocale } from "../i18n/locales";
import {
  BOOKING_WINDOW_DAYS,
  MIN_DUE_APPOINTMENTS,
  MIN_REBOOK_CLIENTS,
  REBOOK_DAYS,
  bookingMeasures,
  daysBetween,
  shiftDate,
} from "./measures";
import type { MeasureOptions } from "./measures";
import { BookingImportError, MAX_IMPORT_ROWS } from "./rows";
import type { BookingStatus, MeasuredAppointment } from "./types";
import type { Say } from "./words";
import { CONNECTIONS_WORDS, sayRefusal } from "./words";

const say = async (locale: AppLocale): Promise<Say> => ({
  tr: await localeTr(locale, CONNECTIONS_WORDS),
  locale,
});

/* ── the pre-L-4 English, kept as the reference ── */

type Said = { status: "measured"; arithmetic: string } | { status: "unmeasured"; reason: string };

function legacy(
  appointments: readonly MeasuredAppointment[],
  asOf: string,
  options: MeasureOptions,
): Record<string, Said> {
  const inWindow = (a: { day: string }, from: string, to: string) => a.day >= from && a.day <= to;
  const from = shiftDate(asOf, -(BOOKING_WINDOW_DAYS - 1));
  const win = appointments.filter((a) => inWindow(a, from, asOf));
  const count = (s: string) => win.filter((a) => a.status === s).length;
  const completed = count("completed");
  const noShows = count("no_show");
  const late = options.lateSeparated ? count("cancelled_late") : null;
  const due = completed + noShows + (late ?? 0);
  const period = `${from} to ${asOf}`;
  const rate = (part: number, noun: string): Said =>
    due < MIN_DUE_APPOINTMENTS
      ? {
          status: "unmeasured",
          reason: `${due} due appointment${due === 1 ? "" : "s"} between ${from} and ${asOf}; I need at least ${MIN_DUE_APPOINTMENTS} to call a rate`,
        }
      : {
          status: "measured",
          arithmetic: `${part} ${noun} of ${due} due appointments (completed ${completed} + no-shows ${noShows}${late === null ? "" : ` + late cancellations ${late}`}), ${period}`,
        };
  let revenue: Said;
  const priced = win.filter((a) => a.status === "completed" && a.price_minor !== null);
  const currencies = [...new Set(priced.map((a) => a.currency ?? "?"))].sort();
  if (completed === 0) {
    revenue = { status: "unmeasured", reason: `no completed appointments ${period}` };
  } else if (priced.length === 0) {
    revenue = {
      status: "unmeasured",
      reason: `${options.sourceName} has no prices for these appointments`,
    };
  } else if (currencies.length !== 1 || currencies[0] === "?") {
    revenue = {
      status: "unmeasured",
      reason: `the prices are in ${currencies.join(" and ")}, and currencies never blend`,
    };
  } else {
    const unpriced = completed - priced.length;
    revenue = {
      status: "measured",
      arithmetic:
        `the listed price of ${priced.length} completed appointment${priced.length === 1 ? "" : "s"}, ${period}` +
        (unpriced > 0 ? ` (${unpriced} had no price and count as nothing)` : ""),
    };
  }
  const cap = options.capacityPerWeek;
  const utilisation: Said =
    cap === null || !Number.isFinite(cap) || cap <= 0
      ? {
          status: "unmeasured",
          reason:
            "you haven't told me how many appointments you can take a week, so I can't say how full you are — I won't assume a capacity",
        }
      : {
          status: "measured",
          arithmetic: `${completed} completed of a stated ${cap} a week × ${BOOKING_WINDOW_DAYS / 7} weeks = ${cap * (BOOKING_WINDOW_DAYS / 7)} slots, ${period}`,
        };
  let rebooking: Said;
  if (!appointments.some((a) => a.client_key !== null)) {
    rebooking = {
      status: "unmeasured",
      reason: `${options.sourceName} has no client id, email or phone I can follow, so I can't see who came back`,
    };
  } else {
    const cohortTo = shiftDate(asOf, -REBOOK_DAYS);
    const cohortFrom = shiftDate(cohortTo, -(BOOKING_WINDOW_DAYS - 1));
    const HELD = new Set(["completed", "no_show", "cancelled_late", "booked_future"]);
    const visits = new Map<string, string[]>();
    const later = new Map<string, string[]>();
    for (const a of appointments) {
      if (a.client_key === null) continue;
      if (a.status === "completed" && inWindow(a, cohortFrom, cohortTo)) {
        visits.set(a.client_key, [...(visits.get(a.client_key) ?? []), a.day]);
      }
      if (HELD.has(a.status)) later.set(a.client_key, [...(later.get(a.client_key) ?? []), a.day]);
    }
    const cohort = visits.size;
    if (cohort < MIN_REBOOK_CLIENTS) {
      rebooking = {
        status: "unmeasured",
        reason:
          `${cohort} client${cohort === 1 ? "" : "s"} had a completed appointment between ${cohortFrom} and ${cohortTo}; ` +
          `I need at least ${MIN_REBOOK_CLIENTS}, each with ${REBOOK_DAYS} days after it, to call a rebooking rate`,
      };
    } else {
      let back = 0;
      for (const [client, days] of visits) {
        const next = later.get(client) ?? [];
        if (
          days.some((d) =>
            next.some((n) => {
              const gap = daysBetween(d, n);
              return gap >= 1 && gap <= REBOOK_DAYS;
            }),
          )
        ) {
          back++;
        }
      }
      rebooking = {
        status: "measured",
        arithmetic:
          `${back} of ${cohort} clients with a completed appointment between ${cohortFrom} and ${cohortTo} ` +
          `booked again within ${REBOOK_DAYS} days`,
      };
    }
  }
  return {
    no_show_rate: rate(noShows, "no-shows"),
    late_cancellation_rate:
      late === null
        ? {
            status: "unmeasured",
            reason: `${options.sourceName} doesn't separate late cancellations: it counts them as no-shows when you mark them`,
          }
        : rate(late, "late cancellations"),
    rebooking_rate: rebooking,
    revenue,
    utilisation,
  };
}

/* ── generated windows ── */

const AS_OF = "2026-10-21";
const STATUSES: BookingStatus[] = [
  "completed",
  "completed",
  "completed",
  "no_show",
  "cancelled_late",
  "cancelled",
  "booked_future",
];

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function scenario(seed: number): { appts: MeasuredAppointment[]; options: MeasureOptions } {
  const r = rng(seed);
  const n = Math.floor(r() * 140);
  const clients = 1 + Math.floor(r() * 40);
  const keyed = r() > 0.2;
  const priced = r();
  const currencies = r() > 0.85 ? ["EUR", "HUF"] : ["EUR"];
  const appts: MeasuredAppointment[] = Array.from({ length: n }, () => {
    const pricedOne = priced > 0.3 && r() > 0.15;
    return {
      day: shiftDate(AS_OF, -Math.floor(r() * 110)),
      status: STATUSES[Math.floor(r() * STATUSES.length)] as BookingStatus,
      client_key: keyed ? `c${Math.floor(r() * clients)}` : null,
      price_minor: pricedOne ? 1000 + Math.floor(r() * 9000) : null,
      currency: pricedOne ? (currencies[Math.floor(r() * currencies.length)] as string) : null,
    };
  });
  const square = r() > 0.6;
  const caps = [null, 0, 20, 37.5, 120];
  return {
    appts,
    options: {
      lateSeparated: !square,
      capacityPerWeek: caps[Math.floor(r() * caps.length)] ?? null,
      sourceName: square ? "Square" : "your bookings export",
      sourceKind: square ? "square" : "import",
    },
  };
}

const said = (m: { status: string; arithmetic?: string; reason?: string }) =>
  m.status === "measured" ? { status: m.status, arithmetic: m.arithmetic } : m;

describe("the bookings measures in English (byte for byte as before L-4)", () => {
  it("reads every generated window exactly as the pre-L-4 code did", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const { appts, options } = scenario(seed);
      const m = bookingMeasures(appts, AS_OF, options);
      const want = legacy(appts, AS_OF, options);
      for (const k of Object.keys(want)) {
        const got = m[k as keyof typeof m] as {
          status: string;
          arithmetic?: string;
          reason?: string;
        };
        const w = want[k] as Said;
        expect(said(got), `seed ${seed} ${k}`).toEqual(w);
        kinds.add(`${k}:${w.status}`);
      }
    }
    // The generator reaches every measure both measured and not.
    for (const k of ["no_show_rate", "late_cancellation_rate", "rebooking_rate", "revenue"]) {
      expect(kinds.has(`${k}:measured`), k).toBe(true);
      expect(kinds.has(`${k}:unmeasured`), k).toBe(true);
    }
  });

  it("says each refusal of an import exactly as before", () => {
    const old: [ConstructorParameters<typeof BookingImportError>[0], string][] = [
      [{ key: "tooLarge" }, "that file is too large for one import — split it by date"],
      [{ key: "needsRows" }, "the file needs a header row and at least one appointment"],
      [
        { key: "tooMany", values: { max: MAX_IMPORT_ROWS } },
        `one import takes up to ${MAX_IMPORT_ROWS} appointments — split the file by date`,
      ],
      [
        { key: "noDate" },
        "I couldn't find a date column — the header needs one, such as Date or Start",
      ],
      [
        { key: "noStatus" },
        "I couldn't find a status column. Without it a kept appointment and a no-show look the same, so I won't guess",
      ],
      [
        { key: "noCurrency" },
        "the file has a price column — say which currency it is in (three letters, e.g. EUR)",
      ],
      [
        { key: "bothOrders" },
        "the dates in this file are written both day-first and month-first (13/01 and 01/13), so I can't read them",
      ],
      [
        { key: "saidDayFirst" },
        "you said the dates are day first, but the file has dates that only read month first",
      ],
      [
        { key: "saidMonthFirst" },
        "you said the dates are month first, but the file has dates that only read day first",
      ],
      [
        { key: "ambiguousDates" },
        "dates like 03/04/2026 could be 3 April or 4 March — say whether the day or the month comes first",
      ],
      [{ key: "decimal.ambiguous" }, DECIMAL_STYLE_MESSAGES.ambiguous],
      [{ key: "decimal.both" }, DECIMAL_STYLE_MESSAGES.both],
      [{ key: "decimal.contradicts_stated" }, DECIMAL_STYLE_MESSAGES.contradicts_stated],
      [
        { key: "noneRead", values: { rows: 12 }, skipped: { no_date: 3, unknown_status: 9 } },
        "none of the 12 rows could be read (3 no date, 9 unknown status)",
      ],
      [{ key: "noneRead", values: { rows: 1 }, skipped: {} }, "none of the 1 rows could be read"],
      [{ key: "notSetUp" }, "the bookings import could not be set up"],
      [{ key: "notRecorded" }, "the import could not be recorded"],
    ];
    for (const [words, english] of old) {
      expect(new BookingImportError(words).message).toBe(english);
      expect(sayRefusal(words)).toBe(english);
    }
  });
});

/* ── other languages ── */

const window25 = (): MeasuredAppointment[] => [
  ...Array.from({ length: 20 }, () => ({
    day: AS_OF,
    status: "completed" as const,
    client_key: null,
    price_minor: 4000,
    currency: "EUR",
  })),
  ...Array.from({ length: 5 }, () => ({
    day: AS_OF,
    status: "no_show" as const,
    client_key: null,
    price_minor: null,
    currency: null,
  })),
];

describe("the bookings sentences in another language", () => {
  it("says the measures in German, with German dates and figures", async () => {
    const de = await say("de-DE");
    const m = bookingMeasures(
      window25(),
      AS_OF,
      {
        lateSeparated: false,
        capacityPerWeek: 37.5,
        sourceName: "Square",
        sourceKind: "square",
      },
      de,
    );
    expect(m.no_show_rate).toMatchObject({
      status: "measured",
      arithmetic:
        "5-mal nicht erschienen bei 25 fälligen Terminen (wahrgenommen 20 + nicht erschienen 5), 24. Sept. 2026 bis 21. Okt. 2026",
    });
    expect(m.late_cancellation_rate).toMatchObject({
      reason:
        "Square trennt kurzfristige Absagen nicht ab: Wenn Sie sie markieren, zählen sie als Nichterscheinen",
    });
    expect(m.utilisation).toMatchObject({
      arithmetic:
        "20 wahrgenommen von angegebenen 37,5 pro Woche × 4 Wochen = 150 Plätze, 24. Sept. 2026 bis 21. Okt. 2026",
    });
    expect(m.revenue).toMatchObject({
      arithmetic:
        "der Listenpreis von 20 wahrgenommenen Terminen, 24. Sept. 2026 bis 21. Okt. 2026",
    });
  });

  it("names the import in the reader's words, and English keeps the code's own name", async () => {
    const opts = {
      lateSeparated: true,
      capacityPerWeek: null,
      sourceName: "your bookings export",
      sourceKind: "import" as const,
    };
    expect(bookingMeasures([], AS_OF, opts, await say("de-DE")).revenue).toMatchObject({
      reason: "keine wahrgenommenen Termine, 24. Sept. 2026 bis 21. Okt. 2026",
    });
    const priceless = window25().map((a) => ({ ...a, price_minor: null, currency: null }));
    expect(bookingMeasures(priceless, AS_OF, opts, await say("de-DE")).revenue).toMatchObject({
      reason: "Ihr Buchungsexport enthält keine Preise für diese Termine",
    });
    expect(bookingMeasures(priceless, AS_OF, opts).revenue).toMatchObject({
      reason: "your bookings export has no prices for these appointments",
    });
  });

  it("refuses an import in German", async () => {
    const de = await say("de-DE");
    expect(sayRefusal({ key: "tooMany", values: { max: MAX_IMPORT_ROWS } }, de)).toBe(
      "ein Import nimmt bis zu 50.000 Termine auf – teilen Sie die Datei nach Datum auf",
    );
    expect(sayRefusal({ key: "ambiguousDates" }, de)).toBe(
      "Datumsangaben wie 03/04/2026 könnten der 3. April oder der 4. März sein – sagen Sie, ob der Tag oder der Monat zuerst steht",
    );
  });

  it("chooses every Russian plural form: 1, 3, 5 and 21", async () => {
    const { tr } = await say("ru-RU");
    const due = (n: number) =>
      tr("bookings.rate.noShow", {
        part: "0",
        due: n,
        n: String(n),
        breakdown: "…",
        period: "…",
      });
    expect(due(1)).toContain("из 1 наступившей записи");
    expect(due(3)).toContain("из 3 наступивших записей");
    expect(due(5)).toContain("из 5 наступивших записей");
    expect(due(21)).toContain("из 21 наступившей записи");
    const priced = (n: number) =>
      tr("bookings.revenue.sum", { count: n, n: String(n), period: "…" });
    expect(priced(1)).toBe("указанная цена 1 состоявшейся записи, …");
    expect(priced(3)).toBe("указанная цена 3 состоявшихся записей, …");
    expect(priced(5)).toBe("указанная цена 5 состоявшихся записей, …");
    expect(priced(21)).toBe("указанная цена 21 состоявшейся записи, …");
  });

  it("joins Chinese with no space after full-width punctuation", async () => {
    const zh = await say("zh-Hans");
    const refused = sayRefusal(
      { key: "noneRead", values: { rows: 12 }, skipped: { no_date: 3, unknown_status: 9 } },
      zh,
    );
    expect(refused).toBe("一行都无法读取（共 12 行；没有日期：3、状态未知：9）");
    expect(refused).not.toMatch(/[；：、，（）] /);
    const m = bookingMeasures(
      window25(),
      AS_OF,
      { lateSeparated: true, capacityPerWeek: null, sourceName: "Square", sourceKind: "square" },
      zh,
    );
    expect(m.no_show_rate).toMatchObject({
      arithmetic:
        "25 个到期预约中有 5 个爽约（已完成 20 + 爽约 5 + 临时取消 0），2026年9月24日 至 2026年10月21日",
    });
  });
});
