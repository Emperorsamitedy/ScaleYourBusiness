// Where an owner stands in getting started (ux-spec §7.0, "The journey",
// owner, 2026-11-28: "the flow and everything kind of looks like broken
// to me… plan that"). Pure: every caller reads the same five facts and
// gets the same answer, so sign-in, Getting started, Home and the menu can
// never disagree about what comes next.
//
// The five steps, in order:
//   language  – the business's language and currency (the first step)
//   interview – the core questions, with Lex or on the form
//   diagnosis – the first report
//   connect   – a read-only data connection (optional)
//   mode      – how Lex works for this business
//
// An owner is SET UP once the first diagnosis exists. Before that, Home
// is Getting started; after it, the two remaining steps are a card on
// Home until they are done.

export const JOURNEY_STEPS = ["language", "interview", "diagnosis", "connect", "mode"] as const;
export type JourneyStep = (typeof JOURNEY_STEPS)[number];

/** What the database says about one business, read by lib/journey/read.ts. */
export interface JourneyFacts {
  /** The business's currency has been chosen (the language step's answer). */
  currency_chosen: boolean;
  /** Current facts on the profile, from any source. */
  facts: number;
  /** The interview's core questions were all answered at least once. */
  core_done: boolean;
  /** A diagnosis report exists. */
  has_report: boolean;
  /** Connections that are connected now. */
  connections: number;
  /** A "how Lex works" decision exists. */
  mode_decided: boolean;
}

export interface Journey {
  /** Each step, done or not, in order. */
  steps: { step: JourneyStep; done: boolean }[];
  /** The first step not done; null when all five are. */
  next: JourneyStep | null;
  /** The first diagnosis exists: Home opens, and the rest is optional. */
  set_up: boolean;
  /** The interview has begun but its core is not done. */
  interview_started: boolean;
  /** Steps done, of five. */
  done: number;
}

/** Pure: where this business stands. */
export function journeyOf(f: JourneyFacts): Journey {
  const doneBy: Record<JourneyStep, boolean> = {
    // A business that already has a report was set up before this screen
    // existed: its language step is not asked again.
    language: f.currency_chosen || f.has_report,
    interview: f.core_done || f.has_report,
    diagnosis: f.has_report,
    connect: f.connections > 0,
    mode: f.mode_decided,
  };
  const steps = JOURNEY_STEPS.map((step) => ({ step, done: doneBy[step] }));
  const next = steps.find((s) => !s.done)?.step ?? null;
  return {
    steps,
    next,
    set_up: f.has_report,
    interview_started: !doneBy.interview && f.facts > 0,
    done: steps.filter((s) => s.done).length,
  };
}

export type StepStatus = "done" | "next" | "later" | "afterInterview" | "afterDiagnosis";

/**
 * Pure: the word beside a step on Getting started. The first step not done
 * is "next"; a step that needs an earlier one says which; any other open
 * step can be done whenever the owner likes.
 */
export function statusOf(journey: Journey, step: JourneyStep): StepStatus {
  const doneOf = (s: JourneyStep) => journey.steps.find((r) => r.step === s)?.done === true;
  if (doneOf(step)) return "done";
  if (journey.next === step) return "next";
  if (step === "diagnosis" && !doneOf("interview")) return "afterInterview";
  if (step === "mode" && !doneOf("diagnosis")) return "afterDiagnosis";
  return "later";
}

/** Where each step is done. The interview's two ways are both offered on its card. */
export const STEP_HREF: Record<JourneyStep, string> = {
  language: "/start#language",
  interview: "/intake",
  diagnosis: "/report",
  connect: "/connections",
  mode: "/mode",
};

/** The interview with Lex, in the conversation (components/chat/LexInterview). */
export const INTERVIEW_WITH_LEX = "/chat?interview=1";
