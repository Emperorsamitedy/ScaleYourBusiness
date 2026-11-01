// next-intl's request configuration — L-1 (TASKS-LANGUAGES.md).
//
// No language in the URL: the locale comes from the language cookie,
// through the status gate (lib/i18n/server requestLocale), so every route
// keeps its address. The catalogue for that locale is the only one sent.
// Dates are formatted in UTC, as the hand-written formatters always were.

import { getRequestConfig } from "next-intl/server";
import { requestLocale } from "../lib/i18n/server";

export default getRequestConfig(async () => {
  const locale = await requestLocale();
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: "UTC",
  };
});
