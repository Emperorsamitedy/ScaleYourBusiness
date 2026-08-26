// Server-side Sentry init (P0-07b). Errors only — tracing and replay
// stay off to protect the free-tier quota; the €50/month discipline
// applies to observability too. Enabled solely by SENTRY_DSN presence.

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? "",
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.VERCEL_ENV ?? "development",
  tracesSampleRate: 0,
  // The intake runs on cookie-scoped anonymous profiles; no PII beyond
  // what the owner typed, and answers never belong in error payloads.
  sendDefaultPii: false,
  beforeSend(event) {
    // Telemetry-sink noise never reaches quota: that route already
    // swallows its own failures by design.
    if (event.request?.url?.includes("/api/intake/events")) return null;
    return event;
  },
});
