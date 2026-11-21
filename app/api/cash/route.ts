// The cash forecast's API — Phase 5 Session B (P5-07..10).
//
//   GET /api/cash[?slow=20&slow_week=0&order=7000&order_week=4&hire=1900&hire_week=0
//                 &price_item=<key>&price_step=0.05]
//       the 13-week forecast from the owner's own numbers, its first tight
//       week, and the four scenarios side by side (the query sets their
//       sizes; anything missing or out of bounds is the default)
//
// GET only, and there is no other verb (rule 26: finance is read and
// modelled, never moved — lib/cash/fence.test.ts fails the build if this
// route grows one). Reading needs the intake cookie, as /api/simulate
// does. Arithmetic over rows the profile and the connectors already hold:
// no model, no network.
//
// I-54a: when cash today is an imported bank statement's balance, the
// plain forecast's next four weekly closing balances go on SYB's own track
// record (lib/forecasts), once per week, as the seasons screen does. That
// is a record of what was said, never a change to any money.
//
// L-4b: what the screen reads (the forecast's sentences, the tight week,
// the scenarios) is in the request's language ("cashWords"); the track
// record's claims are built from the English forecast, as before (rule 7).

import { type NextRequest, NextResponse } from "next/server";
import { resolveAccess } from "../../../lib/auth/access";
import { latestBalance, loadCashInputs } from "../../../lib/cash/load";
import { cashClaims } from "../../../lib/forecasts/claims";
import { recordForecastsQuietly } from "../../../lib/forecasts/record";
import type { CashForecast } from "../../../lib/cash/model";
import { forecastCash } from "../../../lib/cash/model";
import type { PriceEffect, ScenarioCell, ScenarioChoice } from "../../../lib/cash/scenarios";
import {
  compareScenarios,
  defaultChoice,
  parseChoice,
  priceEffect,
} from "../../../lib/cash/scenarios";
import type { TightWeek } from "../../../lib/cash/warnings";
import { tightWeek } from "../../../lib/cash/warnings";
import { logSafeError } from "../../../lib/core/log-safe";
import { minorUnitExponent } from "../../../lib/core/money";
import { requestWords } from "../../../lib/i18n/request-words";
import type { PriceItemRaw } from "../../../lib/simulate/pricing";
import { PRICING, simulatePrice } from "../../../lib/simulate/pricing";
import { gatherPricingInputs } from "../../../lib/simulate/pricing-inputs";
import { SIM_WORDS } from "../../../lib/simulate/words";
import { loadOutside } from "../../../lib/signals/outside";
import type { OutsideView } from "../../../lib/signals/view";
import { daySpan } from "../../../lib/signals/view";

export interface CashView {
  forecast: CashForecast;
  /**
   * Outside signals for the forecast's weeks (lib/signals): the public
   * holidays of the business's country, with the law they come from. Shown
   * beside the weeks and counted in nothing. Null when the forecast refused,
   * or when the signal could not be read: the forecast never waits on it.
   */
  outside: OutsideView | null;
  tight: TightWeek | null;
  /** Null when the forecast refused. */
  scenarios: ScenarioCell[] | null;
  choice: ScenarioChoice | null;
  /** The items what-if pricing can run, and the one chosen. */
  price: {
    items: { key: string; name: string }[];
    item: string | null;
    step: number;
    steps: readonly number[];
  } | null;
}

/** An item what-if pricing can give a profit range for: a price, a cost, a volume. */
const priceable = (i: PriceItemRaw) =>
  i.price !== null &&
  i.volume !== null &&
  i.unit_cost !== null &&
  i.unit_cost.currency.toUpperCase() === i.currency.toUpperCase();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no intake session" }, { status: 401 });
  try {
    const now = new Date();
    const inputs = await loadCashInputs(access.account_id, access.profile_id, now);
    const words = await requestWords("cashWords");
    // The recorded claims read the English forecast; the screen reads the reader's.
    const english = forecastCash(inputs);
    const forecast = words.locale === "en" ? english : forecastCash(inputs, {}, words);
    if (forecast.status !== "ready" || english.status !== "ready") {
      return NextResponse.json({
        forecast,
        outside: null,
        tight: null,
        scenarios: null,
        choice: null,
        price: null,
      } satisfies CashView);
    }

    // Outside signals: what the law makes a public holiday in the weeks forecast.
    // Arithmetic over the business's own country; a failure leaves the forecast whole.
    let outside: OutsideView | null = null;
    try {
      const first = forecast.weeks[0];
      const last = forecast.weeks[forecast.weeks.length - 1];
      if (first && last) {
        outside = await loadOutside(access.profile_id, first.start, daySpan(first.start, last.end));
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "cash_outside_failed",
          account_id: access.account_id,
          ...logSafeError(error),
        }),
      );
    }

    if (forecast.start.basis === "OBSERVED") {
      await recordForecastsQuietly(
        cashClaims(
          { account_id: access.account_id, profile_id: access.profile_id },
          english,
          await latestBalance(access.account_id, inputs.today),
          now,
        ),
        { account_id: access.account_id, event: "forecast_cash_recorded" },
      );
    }

    const q = Object.fromEntries(request.nextUrl.searchParams.entries());
    const choice = parseChoice(
      q,
      defaultChoice(inputs, forecast),
      minorUnitExponent(forecast.currency),
    );

    // The price change: what-if pricing's own arithmetic on one item.
    let effect: PriceEffect | null = null;
    let price: CashView["price"] = null;
    try {
      const sim = await requestWords(SIM_WORDS, words.locale);
      const pricing = await gatherPricingInputs(access.profile_id, now, sim);
      const items = pricing.items.filter(priceable);
      const stepRaw = Number(q.price_step);
      const step = PRICING.steps.includes(stepRaw) ? stepRaw : PRICING.default_steps[0]!;
      const item = items.find((i) => i.key === q.price_item) ?? items[0] ?? null;
      if (item)
        effect = priceEffect(
          simulatePrice(item, { kind: "share", share: step }, pricing.archetype, sim),
          item,
          words,
          words.locale === "en" ? undefined : sim,
        );
      price = {
        items: items.map((i) => ({ key: i.key, name: i.name })),
        item: item?.key ?? null,
        step,
        steps: PRICING.steps,
      };
    } catch (error) {
      // What-if pricing failing leaves its scenario missing, never the forecast.
      console.error(
        JSON.stringify({
          event: "cash_pricing_failed",
          account_id: access.account_id,
          ...logSafeError(error),
        }),
      );
    }

    return NextResponse.json({
      forecast,
      outside,
      tight: tightWeek(forecast, words),
      scenarios: compareScenarios(inputs, forecast, choice, effect, words),
      choice,
      price,
    } satisfies CashView);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "cash_view_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on my side" }, { status: 500 });
  }
}
