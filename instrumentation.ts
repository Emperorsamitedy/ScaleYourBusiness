// P0-07b — server-side Sentry bootstrap. Next.js calls register() once
// per runtime at startup. Everything no-ops cleanly when SENTRY_DSN is
// unset (local dev, CI), so monitoring is configuration, not code.
//
// The multi-market spec §B.4: a country's own prices switched on while the
// per-tier usage quotas are unconfirmed fails the start, loudly. A database
// that can't be reached at boot is logged, not fatal: the check guards a
// configuration mistake, not availability.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    if (process.env.DATABASE_URL) {
      const { priceBookStartupCheck } = await import("./lib/billing/price-book");
      const problem = await priceBookStartupCheck().catch((error: unknown) => {
        console.error(
          JSON.stringify({
            event: "price_book_startup_check_unavailable",
            account_id: null,
            name: error instanceof Error ? error.name : "unknown",
          }),
        );
        return null;
      });
      if (problem !== null) throw new Error(`startup check failed: ${problem}`);
    }
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs";
