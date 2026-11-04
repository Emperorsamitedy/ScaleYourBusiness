// L-4c: Team cover's sentences come from the "teamWords" catalogue. In
// English they are the words lib/team/coverage always wrote (the old
// literals are pinned here); in the other languages the figures, dates
// and weekdays follow the reader, Russian counts take all their forms,
// and Chinese joins two sentences without a space.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import type { Weekday } from "../hours/schedule";
import type { AppLocale } from "../i18n/locales";
import type { CoverageInput, TeamLang } from "./coverage";
import { daysText, englishTeam, rangeWords, rolesOf, runText, teamCoverage } from "./coverage";

const lang = (locale: AppLocale): TeamLang => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
  const t = createTranslator({
    locale,
    messages,
    namespace: "teamWords" as "common",
  }) as unknown as TeamLang["tr"];
  return { tr: (k, v) => t(k, v), locale };
};

const AS_OF = "2026-10-24"; // a Saturday
const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const WD: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const weekdayOf = (day: string) => WD[new Date(`${day}T00:00:00Z`).getUTCDay()] as Weekday;

function slots(days: number, perHour: (w: Weekday, h: number) => number, timed = true) {
  const out: NonNullable<CoverageInput["bookings"]>["slots"][number][] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = addDays(AS_OF, -i);
    for (let h = 0; h < 24; h++) {
      for (let k = 0; k < perHour(weekdayOf(day), h); k++) {
        out.push({
          day,
          start_time: timed ? `${String(h).padStart(2, "0")}:00` : null,
          status: "completed",
        });
      }
    }
  }
  return out;
}

/** Saturdays short at 10 and 12–13, quiet at 11; Fridays 10–14 lifted by the season. */
function week(over: Partial<CoverageInput> = {}): CoverageInput {
  return {
    asOf: AS_OF,
    bookings: {
      source: "your bookings export",
      first_day: addDays(AS_OF, -55),
      slots: slots(56, (w, h) =>
        w === "sat"
          ? (({ 10: 7, 11: 1, 12: 7, 13: 4 } as Record<number, number>)[h] ?? 0)
          : w === "fri" && h >= 10 && h < 14
            ? 2
            : 0,
      ),
    },
    takings: null,
    capacityPerWeek: 25,
    openHours: null,
    season: {
      status: "busy_ahead",
      starts_on: "2026-12-01",
      ends_on: "2026-12-27",
      in_progress: false,
      index: 1.7,
      low: 1.6,
      high: 1.9,
    },
    roles: [{ role_title: "Stylist", hours_per_week: 4 }],
    ...over,
  };
}

const ok = (r: ReturnType<typeof teamCoverage>) => {
  if (r.status !== "ok") throw new Error(`refused: ${r.headline}`);
  return r;
};
const refused = (r: ReturnType<typeof teamCoverage>) => {
  if (r.status !== "refused") throw new Error("not refused");
  return r;
};

describe("English is the code's own words, byte for byte", () => {
  it("gives the same bytes with the English catalogue as with no language at all", () => {
    for (const input of [week(), week({ capacityPerWeek: null }), week({ bookings: null })]) {
      expect(JSON.stringify(teamCoverage(input, englishTeam()))).toBe(
        JSON.stringify(teamCoverage(input)),
      );
    }
  });

  it("says the reading as the code always said it", () => {
    const r = ok(teamCoverage(week()));
    expect(r.headline).toBe(
      "Saturdays 10:00–11:00 ran 224% booked; one stylist covers about 6.3 appointments an hour at your stated 25 a week.",
    );
    const quiet = r.findings.find((f) => f.band === "quiet");
    expect(quiet?.words).toBe("Saturdays 11:00–12:00 ran 32% booked");
    expect(quiet?.range_words).toBe(
      "(32% on every day of the middle half of the 8 Saturdays read)",
    );
    expect(quiet?.reason).toBe(
      "about 0.5 people are on in an average open hour, by the role hours you gave",
    );
    expect(quiet?.note).toBe(
      "Saturdays 11:00–12:00: the quietest open stretch. If you ever trim the rota, this is where it would cost the least demand.",
    );
    // The screen's one line is the range and the reason, as it joined them before.
    for (const f of r.findings) expect(f.line).toBe(`${f.range_words}; ${f.reason}.`);
    expect(r.findings[0]?.note).toBe(
      "Saturdays 10:00–11:00: demand ran past what your stated capacity covers. If you want to take more of it, this is where another stylist would add cover first.",
    );
    expect(r.season.words).toBe(
      "Your busy stretch starts on 1 Dec: last year it ran 1.7× (1.6–1.9×) your normal week. At its low end, these hours would also run past your stated capacity: Fridays 10:00–14:00.",
    );
    expect(r.assumed).toEqual([
      "capacity is the same in every open hour: your stated 25 appointments a week ÷ 8 open hours = 3.1 appointments an hour",
      "an appointment counts in the hour it starts",
      "opening hours for Fridays and Saturdays aren't stated, so they are read from when appointments start (on at least 25% of those days)",
      "role hours are spread evenly over the open hours: I don't know the rota",
      "every role you listed counts toward serving clients",
    ]);
    expect(r.limits).toEqual([
      "This reads roles and hours only. It never looks at who worked when, and it says nothing about any person.",
      "The notes are for you to weigh. Nothing changes a rota, a shift or anyone's hours.",
    ]);
  });

  it("refuses in the words it always used", () => {
    const none = refused(teamCoverage(week({ bookings: null })));
    expect(none.headline).toBe("Nothing measures demand by the hour yet.");
    expect(none.reason).toBe(
      "Cover by the hour needs your bookings (an export, or Square) or hourly sales from a connected till, payment account or shop.",
    );
    expect(none.can).toEqual(["list the roles you gave me and their hours"]);
    expect(none.cannot).toEqual([
      "say which hours run over what your stated capacity covers",
      "say which open hours are quiet",
      "borrow a pattern from other businesses like yours",
    ]);
    const cap = refused(teamCoverage(week({ capacityPerWeek: null })));
    expect(cap.reason).toBe(
      "You haven't told me how many appointments you can take a week (question 1.4.2.3b), and I won't assume one.",
    );
    const few = refused(
      teamCoverage(
        week({
          bookings: { source: "x", first_day: addDays(AS_OF, -9), slots: slots(10, () => 1) },
        }),
      ),
    );
    expect(few.headline).toBe("10 days of bookings so far; cover by the hour needs 28.");
    expect(few.reason).toBe(
      "Your bookings run from 15 Oct to 24 Oct. Four of each weekday is the least I'll band an hour on.",
    );
    expect(few.can).toEqual(["count the appointments in the 10 days there are"]);
    const times = refused(
      teamCoverage(
        week({
          bookings: {
            source: "x",
            first_day: addDays(AS_OF, -55),
            slots: slots(56, () => 1, false),
          },
        }),
      ),
    );
    expect(times.reason).toBe(
      "None of the 1344 appointments from 30 Aug to 24 Oct says when it started.",
    );
  });

  it("keeps the helpers' English", () => {
    expect(runText("sat", 10, 14)).toBe("Saturdays 10:00–14:00");
    expect(daysText(["sat", "fri"])).toBe("Fridays and Saturdays");
    expect(daysText(["tue", "wed", "thu"])).toBe("Tuesdays to Thursdays");
    expect(daysText(["mon", "wed", "fri"])).toBe("Mondays, Wednesdays and Fridays");
    expect(rangeWords({ low: 0.91, high: 1 }, 8, "Saturdays")).toBe(
      "(91–100% on the middle half of the 8 Saturdays read)",
    );
    expect(rolesOf([{ role_title: null, hours_per_week: 4 }], 4)[0]?.role).toBe("Untitled role");
  });

  it("agrees at one, where the old words said “1 … aren't”", () => {
    const r = ok(
      teamCoverage(
        week({
          bookings: {
            source: "x",
            first_day: addDays(AS_OF, -55),
            slots: [
              ...week().bookings!.slots,
              { day: AS_OF, start_time: null, status: "completed" },
            ],
          },
        }),
      ),
    );
    expect(r.notes.at(-1)).toBe("1 appointment had no start time and isn't placed in an hour.");
  });
});

describe("German: the reader's figures, dates and weekdays", () => {
  const de = lang("de-DE");

  it("writes the reading in German, the owner's role title as given", () => {
    const r = ok(teamCoverage(week(), de));
    expect(r.headline).toBe(
      "Samstags 10:00–11:00: zu 224\u00a0% gebucht; eine Person als Stylist deckt etwa 6,3 Termine pro Stunde ab, bei Ihren angegebenen 25 pro Woche.",
    );
    expect(r.findings[0]?.line).toBe(
      "(224\u00a0% an jedem Tag der mittleren Hälfte der ausgewerteten 8 Samstage); eine Person als Stylist deckt etwa 6,3 Termine pro Stunde ab, bei Ihren angegebenen 25 pro Woche.",
    );
    expect(r.season.words).toBe(
      "Ihre starke Phase beginnt am 1. Dez.: Letztes Jahr lag sie bei 1,7× (1,6–1,9×) einer normalen Woche. Schon am unteren Ende gingen auch diese Stunden über Ihre angegebene Kapazität hinaus: freitags 10:00–14:00.",
    );
    expect(r.assumed[2]).toBe(
      "für Freitag und Samstag sind keine Öffnungszeiten angegeben, daher werden sie daraus abgelesen, wann Termine beginnen (an mindestens 25\u00a0% dieser Tage)",
    );
    // Facts stay as given: the stored source, and the role.
    expect(r.basis.demand).toBe("your bookings export");
    expect(r.roles[0]?.role).toBe("Stylist");
  });

  it("refuses in German, and names a missing title in German", () => {
    const cap = refused(teamCoverage(week({ capacityPerWeek: null }), de));
    expect(cap.reason).toBe(
      "Sie haben mir nicht gesagt, wie viele Termine Sie pro Woche annehmen können (Frage 1.4.2.3b), und eine Annahme treffe ich dazu nicht.",
    );
    expect(rolesOf([{ role_title: "  ", hours_per_week: 4 }], 4, de)[0]?.role).toBe(
      "Rolle ohne Titel",
    );
    expect(daysText(["tue", "wed", "thu"], de)).toBe("Dienstag bis Donnerstag");
  });
});

describe("Russian: every counting form", () => {
  const ru = lang("ru-RU");

  it("counts appointments, days read and days of history 1, 3, 5 and 21", () => {
    const forms = [1, 3, 5, 21].map((n) => ru.tr("appts", { n, v: String(n) }));
    expect(forms).toEqual(["1 запись", "3 записи", "5 записей", "21 запись"]);
    const sat = [1, 3, 5, 21].map((days) => ru.tr("rangeCount.sat", { days }));
    expect(sat).toEqual(["1 субботы", "3 суббот", "5 суббот", "21 субботы"]);
    const history = [1, 3, 5, 21].map(
      (history) =>
        refused(
          teamCoverage(
            week({
              bookings: {
                source: "x",
                first_day: addDays(AS_OF, -(history - 1)),
                slots: slots(history, () => 1),
              },
            }),
            ru,
          ),
        ).headline,
    );
    expect(history).toEqual([
      "Записи пока есть за 1 день; для покрытия по часам нужно 28.",
      "Записи пока есть за 3 дня; для покрытия по часам нужно 28.",
      "Записи пока есть за 5 дней; для покрытия по часам нужно 28.",
      "Записи пока есть за 21 день; для покрытия по часам нужно 28.",
    ]);
  });

  it("words a fractional count as Russian does (“0,5 человека”)", () => {
    const quiet = ok(teamCoverage(week(), ru)).findings.find((f) => f.band === "quiet");
    expect(quiet?.reason).toBe(
      "в средний открытый час на месте примерно 0,5 человека, по указанным вами часам ролей",
    );
    expect(quiet?.range_words).toBe(
      "(32\u00a0% во все дни средней половины из прочитанных 8 суббот)",
    );
  });
});

describe("Chinese: full-width punctuation, and two sentences joined without a space", () => {
  const zh = lang("zh-Hans");

  it("joins the headline and the reason with full-width punctuation and no space", () => {
    const r = ok(teamCoverage(week(), zh));
    expect(r.headline).toBe(
      "每周六 10:00–11:00 的预约率为 224%；按您所述每周 25 计，每位“Stylist”每小时约接待 6.3 个预约。",
    );
    expect(r.findings[0]?.line).toBe(
      "（在已读取的 8 个周六中，居中一半的每一天都是 224%）；按您所述每周 25 计，每位“Stylist”每小时约接待 6.3 个预约。",
    );
    // The season's two sentences meet with no space between them.
    expect(r.season.words).toBe(
      "您的繁忙期从 12月1日 开始：去年这段时间是平常一周的 1.7 倍（1.6–1.9 倍）。按其下限，以下时段也会超出您所述的接待能力：每周五 10:00–14:00。",
    );
    for (const s of [r.headline, r.season.words, ...r.findings.map((f) => f.line)]) {
      expect(s, s).not.toMatch(/[。；：，）] /);
    }
  });
});
