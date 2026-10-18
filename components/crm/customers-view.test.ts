import { describe, expect, it } from "vitest";
import { customersHeadline, filterContacts, maskEmail, matchesQuery } from "./customers-view";

describe("customersHeadline", () => {
  it("counts customers and the ones gone quiet, with comma thousands", () => {
    expect(customersHeadline(3884, 412)).toBe("3,884 customers. 412 have gone quiet.");
    expect(customersHeadline(1, 1)).toBe("1 customer. 1 has gone quiet.");
  });

  it("says so plainly when there is no one, or no one quiet", () => {
    expect(customersHeadline(0, 0)).toBe("No customers imported yet.");
    expect(customersHeadline(8, 0)).toBe("8 customers. None have gone quiet.");
  });
});

describe("maskEmail", () => {
  it("keeps two letters and the domain", () => {
    expect(maskEmail("lena@gmail.com")).toBe("le•••@gmail.com");
  });

  it("keeps one letter of a very short local part, and handles no email", () => {
    expect(maskEmail("jo@x.de")).toBe("j•••@x.de");
    expect(maskEmail(null)).toBe("no email");
    expect(maskEmail("not-an-address")).toBe("•••");
  });
});

describe("search and filter", () => {
  const people = [
    { name: "Lena Hof", email: "lena@gmail.com", lifecycle: "active" as const },
    { name: null, email: "lapsed1@walk.test", lifecycle: "lapsed" as const },
  ];

  it("matches name or email, case-insensitively", () => {
    expect(matchesQuery(people[0]!, "HOF")).toBe(true);
    expect(matchesQuery(people[1]!, "walk")).toBe(true);
    expect(matchesQuery(people[1]!, "lena")).toBe(false);
  });

  it("filters by lifecycle and query together", () => {
    expect(filterContacts(people, "lapsed", "")).toHaveLength(1);
    expect(filterContacts(people, "all", "gmail")).toEqual([people[0]]);
    expect(filterContacts(people, "active", "walk")).toEqual([]);
  });
});
