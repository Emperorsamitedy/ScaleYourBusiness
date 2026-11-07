// What the fact sheet and the report print for an answer that isn't
// plain text: entities by name, never by id; yes/no as words, never
// "true"; a measured fact's source without its connection's id. And
// repr() — what diagnosis evidence was written from — unchanged.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import {
  datesInWords,
  displayValue,
  entityNamesOf,
  goalWords,
  keysInWords,
  repr,
  sourceDetail,
} from "./factsheet";

const MUG = "f8872a88-1607-4a5f-a35d-75fbdea4192b";
const BOWL = "5a3bf431-b85d-43cf-8df2-c127441a6e1e";
const UNNAMED = "6d98cfef-d568-4707-90fc-c72e51206ce9";
const COST = "a25fe33b-a0b0-452f-930b-ff63d642e476";
const CHANNEL = "0098681c-b9aa-4ef8-b298-765bb2f50ff4";
const GOAL = "ba86f2a4-c683-41da-99ca-a2b667492ef0";

const names = entityNamesOf([
  [`offers.${MUG}.name`, { value: "Speckled Everyday Mug" }],
  [`offers.${BOWL}.name`, { value: "Large Serving Bowl" }],
  [`offers.${BOWL}.price`, { value: { amount_minor: 8900, currency: "EUR" } }],
  [`offers.${UNNAMED}.name`, { value: "  " }],
  [`costs.${COST}.label`, { value: "Studio rent" }],
  [`costs.${COST}.category`, { value: { code: "rent" } }],
  [`channels.${CHANNEL}.type`, { value: { code: "social_organic" } }],
  [`channels.${CHANNEL}.platform`, { value: { code: "instagram" } }],
  [`goals.${GOAL}.statement`, { value: "G".repeat(80) }],
]);

describe("entityNamesOf", () => {
  it("names each entity by its best naming field, and nothing else", () => {
    expect(new Map(names)).toEqual(
      new Map([
        [MUG, "Speckled Everyday Mug"],
        [BOWL, "Large Serving Bowl"],
        [COST, "Studio rent"],
        // The platform names a channel before its type, whichever came first.
        [CHANNEL, "instagram"],
        [GOAL, `${"G".repeat(59)}…`],
      ]),
    );
  });
});

describe("displayValue", () => {
  it("names one entity, a list of them, and the entity-list marker", () => {
    expect(displayValue(MUG, names)).toBe("Speckled Everyday Mug");
    expect(displayValue({ code: MUG }, names)).toBe("Speckled Everyday Mug");
    expect(displayValue([{ code: MUG }, { code: BOWL }], names)).toBe(
      "Speckled Everyday Mug, Large Serving Bowl",
    );
    // A vocabulary code is not a reference.
    expect(displayValue({ code: "social_organic" }, names)).toBe("social organic");
    expect(displayValue([MUG, BOWL], names)).toBe("Speckled Everyday Mug, Large Serving Bowl");
    expect(displayValue({ entity_ids: [BOWL, MUG] }, names)).toBe(
      "Large Serving Bowl, Speckled Everyday Mug",
    );
  });

  it("leaves an id with no recorded name as it is", () => {
    expect(displayValue([MUG, UNNAMED], names)).toBe(`Speckled Everyday Mug, ${UNNAMED}`);
    expect(displayValue(MUG)).toBe(MUG);
  });

  it("says yes and no, not true and false", () => {
    expect(displayValue(true)).toBe("yes");
    expect(displayValue(false)).toBe("no");
    // Owner text that happens to say "true" is owner text.
    expect(displayValue("true")).toBe("true");
  });

  it("leaves repr(), the evidence's own form, exactly as it was", () => {
    expect(repr(true)).toBe("true");
    expect(repr(MUG)).toBe(MUG);
  });
});

describe("sourceDetail", () => {
  it("drops the connection's id from a measured fact's method", () => {
    expect(
      sourceDetail({
        method:
          "sum(sessions.daily) over 2026-09-30.2026-10-29 (30 days, 30 observations) from ga4 connection 38ad8a7c-c047-40af-932a-4dcc264c9f3a",
      }),
    ).toBe("sum(sessions.daily) over 2026-09-30.2026-10-29 (30 days, 30 observations) from ga4");
  });

  it("drops a bracketed connection id too", () => {
    expect(
      sourceDetail({
        method:
          "count of completed appointments from bookings export from Fresha, imported 2026-11-07 (connection bb138ef8-7c81-4e22-8123-0f4c138d8f72)",
      }),
    ).toBe("count of completed appointments from bookings export from Fresha, imported 2026-11-07");
  });

  it("keeps a URL and a question id as they are", () => {
    expect(sourceDetail({ researched_url: "https://example.com/about" })).toBe(
      "https://example.com/about",
    );
    expect(sourceDetail({ question_id: "4.2" })).toBe("4.2");
  });
});

describe("goalWords", () => {
  it("says a goal's measure and its baseline in words, not JSON", () => {
    expect(
      displayValue({
        metric: "orders",
        set_on: "2026-10-21",
        currency: null,
        deadline: "2027-04-21",
        direction: "increase",
        target_per_30d: 750,
      }),
    ).toBe("raise orders to 750 per 30 days by 2027-04-21");
    expect(
      displayValue({
        to: "2026-10-20",
        from: "2026-09-23",
        per_30d: 4_753_830,
        currency: "EUR",
        days_measured: 23,
      }),
    ).toBe("47 538 EUR per 30 days, measured 2026-09-23 to 2026-10-20 (23 days)");
  });

  it("leaves every other object alone", () => {
    expect(goalWords({ code: "solo" })).toBeNull();
    expect(goalWords([1, 2])).toBeNull();
  });
});

describe("keysInWords", () => {
  it("names each entity once with the fields used, and words any other key", () => {
    expect(
      keysInWords(
        [
          `offers.${MUG}.name`,
          `offers.${MUG}.description`,
          `offers.${BOWL}.price`,
          "identity.business_name",
          "fulfilment.shipping_regions",
        ],
        names,
      ),
    ).toBe(
      "Speckled Everyday Mug (name, description); Large Serving Bowl (price); business name; shipping regions",
    );
  });

  it("never prints an id, even for an entity with no name on file", () => {
    expect(keysInWords([`offers.${UNNAMED}.price`], names)).toBe("one of your entries (price)");
  });
});

describe("siteCheckWords", () => {
  it("says what the site's pages show and don't, not their JSON", () => {
    expect(
      displayValue({
        pages: ["https://shop.example/", "https://shop.example/pages/contact"],
        results: {
          prices: "https://shop.example/",
          faq: null,
          contact_email: "https://shop.example/pages/contact",
        },
        version: "1.0.0",
      }),
    ).toBe("2 pages read · shows: prices, contact email · not found: faq");
  });

  it("writes a measured fact's ISO days out, and leaves timestamps alone", () => {
    expect(
      datesInWords(
        "Measured from bookings export from Fresha, imported 2026-11-07, 2026-10-10 to 2026-11-06.",
      ),
    ).toBe(
      "Measured from bookings export from Fresha, imported 7 Nov 2026, 10 Oct 2026 to 6 Nov 2026.",
    );
    expect(datesInWords("count of completed appointments; over 2026-10-10..2026-11-06")).toBe(
      "count of completed appointments; over 10 Oct 2026 to 6 Nov 2026",
    );
    expect(datesInWords("synced 2026-11-07T09:00:00Z")).toBe("synced 2026-11-07T09:00:00Z");
    expect(datesInWords(null)).toBeNull();
  });
});
