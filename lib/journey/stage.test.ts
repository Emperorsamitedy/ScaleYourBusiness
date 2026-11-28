import { describe, expect, it } from "vitest";
import { type JourneyFacts, journeyOf, statusOf } from "./stage";

const NEW: JourneyFacts = {
  currency_chosen: false,
  facts: 0,
  core_done: false,
  has_report: false,
  connections: 0,
  mode_decided: false,
};

describe("journeyOf: where an owner stands in getting started", () => {
  it("a brand-new business starts at the language step and is not set up", () => {
    const j = journeyOf(NEW);
    expect(j.next).toBe("language");
    expect(j.set_up).toBe(false);
    expect(j.done).toBe(0);
    expect(j.interview_started).toBe(false);
  });

  it("once the currency is chosen, the interview is next", () => {
    expect(journeyOf({ ...NEW, currency_chosen: true }).next).toBe("interview");
  });

  it("an interview with answers but no finished core is started, not done", () => {
    const j = journeyOf({ ...NEW, currency_chosen: true, facts: 7 });
    expect(j.next).toBe("interview");
    expect(j.interview_started).toBe(true);
  });

  it("a finished core makes the diagnosis next, still not set up", () => {
    const j = journeyOf({ ...NEW, currency_chosen: true, facts: 30, core_done: true });
    expect(j.next).toBe("diagnosis");
    expect(j.set_up).toBe(false);
    expect(j.interview_started).toBe(false);
  });

  it("the first report sets the owner up; connecting is next", () => {
    const j = journeyOf({
      ...NEW,
      currency_chosen: true,
      facts: 30,
      core_done: true,
      has_report: true,
    });
    expect(j.set_up).toBe(true);
    expect(j.next).toBe("connect");
    expect(j.done).toBe(3);
  });

  it("a business set up before this screen existed is not sent back to the language step", () => {
    const j = journeyOf({ ...NEW, facts: 40, has_report: true });
    expect(j.steps.find((s) => s.step === "language")?.done).toBe(true);
    expect(j.steps.find((s) => s.step === "interview")?.done).toBe(true);
    expect(j.set_up).toBe(true);
  });

  it("all five done leaves nothing next", () => {
    const j = journeyOf({
      currency_chosen: true,
      facts: 50,
      core_done: true,
      has_report: true,
      connections: 2,
      mode_decided: true,
    });
    expect(j.next).toBeNull();
    expect(j.done).toBe(5);
  });

  it("a connection made early does not skip the steps before it", () => {
    const j = journeyOf({ ...NEW, connections: 1 });
    expect(j.next).toBe("language");
    expect(j.steps.find((s) => s.step === "connect")?.done).toBe(true);
  });
});

describe("statusOf: the word beside each step", () => {
  it("a new business: language next, the diagnosis after the questions, the mode after the diagnosis", () => {
    const j = journeyOf(NEW);
    expect(statusOf(j, "language")).toBe("next");
    expect(statusOf(j, "interview")).toBe("later");
    expect(statusOf(j, "diagnosis")).toBe("afterInterview");
    expect(statusOf(j, "connect")).toBe("later");
    expect(statusOf(j, "mode")).toBe("afterDiagnosis");
  });

  it("a set-up business: the first three done, connecting next, the mode open", () => {
    const j = journeyOf({ ...NEW, currency_chosen: true, core_done: true, has_report: true });
    expect(statusOf(j, "diagnosis")).toBe("done");
    expect(statusOf(j, "connect")).toBe("next");
    expect(statusOf(j, "mode")).toBe("later");
  });
});
