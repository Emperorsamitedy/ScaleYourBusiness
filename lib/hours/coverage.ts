// What measured takings cover — shared by the trading-hours screens.
//
// Square records cash rung up at its till as payments (P2-28, Square
// docs checked 2026-10-13); every other connected source sees card
// payments only. Pure: no database, so connector tests can hold it too.

export function coverageLine(providers: readonly string[]): string {
  const cards = providers.filter((p) => p !== "square");
  if (providers.includes("square")) {
    return (
      `card and cash payments rung up in Square${cards.length > 0 ? `, and card payments through ${cards.join(", ")}` : ""}` +
      " — cash that never goes through a till isn't seen"
    );
  }
  return `card payments through ${providers.join(", ")} only — cash sales aren't seen by any connection`;
}
