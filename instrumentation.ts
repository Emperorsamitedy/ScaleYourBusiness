// P0-07b — server-side Sentry bootstrap. Next.js calls register() once
// per runtime at startup. Everything no-ops cleanly when SENTRY_DSN is
// unset (local dev, CI), so monitoring is configuration, not code.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs";
