import { describe, expect, it } from "vitest";
import {
  InvalidFieldKeyError,
  isProfileSection,
  PROFILE_SECTIONS,
  sectionOfFieldKey,
} from "./sections";

describe("the fourteen profile sections — §5.1", () => {
  it("carries exactly fourteen, distinctly, in MAIN.txt order", () => {
    expect(PROFILE_SECTIONS).toHaveLength(14);
    expect(new Set(PROFILE_SECTIONS).size).toBe(14);
    expect(PROFILE_SECTIONS[0]).toBe("identity");
    expect(PROFILE_SECTIONS[13]).toBe("assets");
  });

  it("recognises members and rejects outsiders", () => {
    expect(isProfileSection("revenue")).toBe(true);
    expect(isProfileSection("finance")).toBe(false);
  });
});

describe("sectionOfFieldKey", () => {
  it("derives the section from a scalar key", () => {
    expect(sectionOfFieldKey("identity.legal_name")).toBe("identity");
  });

  it("derives the section from an entity-scoped key", () => {
    expect(sectionOfFieldKey("offers.7f3a.price")).toBe("offers");
  });

  it("rejects a key filed outside the fourteen sections", () => {
    expect(() => sectionOfFieldKey("finance.debt")).toThrow(InvalidFieldKeyError);
    expect(() => sectionOfFieldKey("")).toThrow(InvalidFieldKeyError);
    expect(() => sectionOfFieldKey(".legal_name")).toThrow(InvalidFieldKeyError);
  });
});
