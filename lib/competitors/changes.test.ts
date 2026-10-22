// Feature 35 — what changed between two reads, in words. Pure.

import { describe, expect, it } from "vitest";
import { money } from "../core/money";
import type { ObservedOffer } from "./changes";
import { detectChanges, offersLabel, offersSignature } from "./changes";
import { offerKey } from "./extract";

const at = "2026-10-19T07:00:00.000Z";
const offer = (
  name: string,
  minor: number,
  url = "https://nova.example/prices",
  currency = "EUR",
): ObservedOffer => ({
  key: offerKey(name),
  name,
  price: money(minor, currency),
  from: false,
  method: "pattern",
  url,
  fetched_at: at,
});

const run = (
  before: ObservedOffer[],
  after: ObservedOffer[],
  fresh = ["https://nova.example/prices"],
  ratings: [number | null, number | null] = [null, null],
) =>
  detectChanges({
    competitor: "Studio Nova",
    before,
    after,
    freshUrls: new Set(fresh),
    ratingBefore: ratings[0] === null ? null : { rating: ratings[0], best: 5, count: 200 },
    ratingAfter: ratings[1] === null ? null : { rating: ratings[1], best: 5, count: 212 },
  });

describe("change detection", () => {
  it("words a price cut and a rise", () => {
    const changes = run(
      [offer("Cut and colour", 8500), offer("Blow dry", 3000)],
      [offer("Cut and colour", 6900), offer("Blow dry", 3200)],
    );
    expect(changes.map((c) => [c.flag, c.sentence])).toEqual([
      ["CHEAPER", "Studio Nova cut its cut and colour price from €85 to €69."],
      ["DEARER", "Studio Nova raised its blow dry price from €30 to €32."],
    ]);
  });

  it("words an offer added and one removed", () => {
    const changes = run([offer("Keratin treatment", 15000)], [offer("Balayage", 12000)]);
    expect(changes.map((c) => [c.flag, c.sentence])).toEqual([
      ["NEW", "Studio Nova now lists balayage at €120."],
      ["GONE", "Studio Nova no longer lists keratin treatment (it was €150)."],
    ]);
  });

  it("never calls an offer gone when its page wasn't read this time", () => {
    const changes = run([offer("Keratin treatment", 15000, "https://nova.example/other")], []);
    expect(changes).toEqual([]);
  });

  it("never converts a currency: the change is said, not computed", () => {
    const changes = run([offer("Cut", 4500)], [offer("Cut", 1800000, undefined, "HUF")]);
    expect(changes.map((c) => c.flag)).toEqual(["CHANGED"]);
  });

  it("notes a rating that moved by a tenth or more, and not less", () => {
    expect(run([], [], [], [4.6, 4.8]).map((c) => c.sentence)).toEqual([
      "Studio Nova's rating moved from 4.6 to 4.8 (212 reviews).",
    ]);
    expect(run([], [], [], [4.71, 4.75])).toEqual([]);
  });

  it("gives equal observations equal signatures, whatever their read times", () => {
    const a = [offer("Cut", 4500)];
    const b = [{ ...offer("Cut", 4500), fetched_at: "2026-10-26T07:00:00.000Z" }];
    expect(offersSignature(a)).toBe(offersSignature(b));
    expect(offersSignature(a)).not.toBe(offersSignature([offer("Cut", 4600)]));
    expect(offersLabel(a)).toBe("1 price seen: Cut €45");
  });
});
