// L-1: next-intl's keys and locales, typed from the English catalogue —
// a message key that doesn't exist in messages/en.json fails the build.

import type en from "../messages/en.json";
import type { AppLocale } from "../lib/i18n/locales";

declare module "next-intl" {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof en;
  }
}
