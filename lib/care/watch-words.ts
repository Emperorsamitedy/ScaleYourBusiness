// The one sentence an owner reads when a proposal waits for the watch to
// end (rule 15). Plain words and a day they can read — never an ISO date
// or a rule number. Every proposal kind that holds during the watch says
// it the same way.

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "I'm watching until 6 Nov, and I propose nothing before then." */
export function watchingUntil(endsAt: string): string {
  const day = DAY.format(new Date(`${endsAt.slice(0, 10)}T00:00:00Z`));
  return `I'm watching until ${day}, and I propose nothing before then.`;
}
