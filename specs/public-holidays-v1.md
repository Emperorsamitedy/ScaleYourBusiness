# Public holidays: what SYB relies on (v1)

The marketing teammate's point (recorded 2026-11-18): nothing in ScaleX reads
what happens outside the business: holidays, weather, prices. This is the
first outside signal, and the plainest: the days a country's law makes public
holidays. A supplier does not deliver on them and a bank or a payout provider
does not move money on them, so they matter to a delivery time and to the week
a payment lands in.

The plan is in `TASKS-FEEDBACK.md` ("Outside signals", S-1 to S-7). Four rules
ride with it, and a test holds each (`lib/signals/fence.test.ts`,
`lib/signals/holidays.test.ts`):

1. **Worked out, never fetched.** A public holiday is set by law: fixed dates,
   and a few that move with Easter. The calendar is the law's own list and the
   arithmetic of Easter. No request leaves, no connector is read, no model is
   called, and no data set is copied.
2. **No calendar, no answer.** A business whose country has no calendar here is
   shown no holidays and told there is no calendar yet. A business whose fact
   sheet holds no country is told nothing: no country is assumed (rule 5 of
   `CLAUDE.md`).
3. **Only from the day the text read was in force.** The list changes. A
   calendar answers from the day its text was in force and never for a day
   before it.
4. **Beside the figure, never in it.** A holiday is named next to a week of
   the cash forecast and next to a delivery time, with the law it comes from,
   and changes no figure. The code that works the figures out does not import
   the signal; the two meet only where a route hands both to a screen.

Every fact the calendar relies on is listed here, with `verified: true` when
the page named stated it on the day read and `verified: false` when it did
not. A `verified: false` line is never shown to an owner as a fact.

Pages read on **2026-11-21**, each fetched as it is served and read as its own
text, without a summariser: the National Legislation Database's text of the
Labour Code, `https://njt.jog.gov.hu/jogszabaly/2012-1-00-00`; Wikipedia's
"List of dates for Easter", "Good Friday", "Easter Monday" and "Whit Monday"
(the published dates the arithmetic is checked against); and the two
repository pages named under "Sources turned down".

## Hungary

| Fact                                                                                                                                                                                                         | verified |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| The page is "2012. évi I. törvény a munka törvénykönyvéről", and prints `2026.11.14.` under the title, in the element the page marks as the text's "hatály" (the day the text shown is in force from)        | true     |
| 102. § (1): "Munkaszüneti nap: január 1., március 15., nagypéntek, húsvéthétfő, május 1., pünkösdhétfő, augusztus 20., október 23., november 1. és december 24–26."                                          | true     |
| The page's footnote to 102. § (1): "A 102. § (1) bekezdése a 2026. évi LXXII. törvény 3. §-ával megállapított szöveg." (this wording was set by section 3 of Act LXXII of 2026)                              | true     |
| What Act LXXII of 2026 changed in the list, and which days were on it before                                                                                                                                 | false    |
| 102. § (4): the rostering rules for a public holiday apply when one falls on a Sunday, and to Easter Sunday and Whit Sunday. Neither Sunday is on the list in (1)                                            | true     |
| 102. § (5): the minister responsible for employment policy may, by decree each year and by 31 October of the year before, change the rostering of working days because of public holidays; a Sunday is never made a working day and the change stays inside one calendar month | true     |
| Easter Sunday fell or falls on 23 March 2008, 31 March 2024, 20 April 2025, 5 April 2026, 28 March 2027, 16 April 2028, 21 April 2030 and 25 April 2038 (the list's table and text); the arithmetic in `easterSunday` gives each of them (`lib/signals/holidays.test.ts`) | true     |
| Good Friday is 3 April 2026 and 26 March 2027, Easter Monday 6 April 2026 and 29 March 2027, Whit Monday 25 May 2026 and 17 May 2027: two days before Easter Sunday, one day after it, and fifty days after it | true     |

The calendar in `lib/signals/holidays.ts` is the list in 102. § (1) and
nothing else: twelve days a year. It is in force from 2026-11-14 as far as
ScaleX knows, so it answers from that day on.

## What a line may say

| Where                         | What is said                                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Cash flow, under a week       | The public holidays in that week, each with its day and its name                                                     |
| Cash flow, under the weeks    | How many fall in the weeks forecast and which, or that none does; that money due on one may arrive a day later and that this is not counted; the law, and the day its text was in force |
| Cash flow, another country    | That ScaleX has no public holiday calendar for that country yet                                                      |
| Stock, beside a delivery time | How many public holidays on a working day fall inside it, counted from today; opened, the days and their names       |
| Stock, in a reorder note      | The same line in full, and that they are not counted in the delivery time                                            |
| Stock, under the table        | The law, and the day its text was in force (only when some delivery time holds a holiday)                            |

A holiday on a Saturday or Sunday is named under its week of the forecast and
left out beside a delivery time: a supplier closed that day anyway loses
nothing to it.

## Sources turned down

Two projects publish holiday calendars. Neither is used: a calendar worked out
from the law needs no request, can name its source, and depends on nobody's
server. Their repository pages (`github.com/nager/Nager.Date`,
`github.com/openpotato/openholidaysapi.data`) were read on 2026-11-21 and are
recorded as found.

| Fact                                                                                                                                                                                  | verified |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Nager.Date's repository is labelled "MIT license"; its README's table lists the public REST API as needing no licence key, and the self-hosted container and the library as needing one | true     |
| Nager.Date asks a business to sponsor it before commercial use (a third party's account; the repository page says nothing of commercial use)                                          | false    |
| The OpenHolidays API data repository is labelled "ODbL-1.0 license"                                                                                                                   | true     |
| A sentence on the OpenHolidays site itself stating the licence of its data                                                                                                            | false    |

## What is not in scope

Every other country: each needs its own law read and listed the same way
before a business there is shown a single day (S-5). The working Saturdays and
moved rest days a minister sets by decree each year under 102. § (5): they are
not public holidays, and a calendar that ignored one would mislead more than
it helps, so they wait for the decree to be read each autumn (S-6). Regional
and local holidays, school holidays, bank-specific closing days and a
supplier's own closing days. Weather and prices: other signals, not built.
