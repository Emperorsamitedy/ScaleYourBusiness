import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// L-1 (TASKS-LANGUAGES.md): next-intl, configured in i18n/request.ts — the
// language from a cookie, never in the URL, so no proxy/middleware is needed.
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Security headers — the security review of 2026-10-17 found none at all.
//
// No page of this app may be framed by another site (the consent screen
// and the approval queue are clickjacking targets), the browser must not
// guess content types, and URLs don't travel to other sites in the
// Referer. The support widget is unaffected: owners embed it as a
// <script>, never as a frame. A full script CSP waits until the inline
// scripts Next.js and Sentry emit are nonce'd — a broken CSP is worse than
// the restrictive directives below, which break nothing.
const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

// P3-52: the cutting room shells out to the FFmpeg/ffprobe binaries these
// packages ship. Bundled, their path resolves inside the bundle and the
// binary isn't there (found by running it: the render waited with "FFmpeg
// isn't here"), so they load from node_modules, and the binaries are traced
// into the functions that cut. _Verify at build_ on Vercel: the binary lands
// in the function and fits its size limit; if not, the render waits, honestly.
const FFMPEG_FILES = [
  "./node_modules/ffmpeg-static/ffmpeg*",
  "./node_modules/ffprobe-static/bin/linux/x64/**",
];

// Every route that cuts a clip, or labels and reads one back
// (lib/content/generate/label). P6-03: /api/studio generates, collects and
// picks AI video candidates, and /api/cron/collect-video collects them in
// the background; without the binaries there, every paid clip failed to be
// labelled. lib/content/ffmpeg-routes.test.ts holds this to the imports.
const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  outputFileTracingIncludes: {
    "/api/content/media": FFMPEG_FILES,
    "/api/cron/render-footage": FFMPEG_FILES,
    "/api/studio": FFMPEG_FILES,
    "/api/cron/collect-video": FFMPEG_FILES,
  },
  async headers() {
    return [
      { source: "/(.*)", headers: SECURITY_HEADERS },
      // The operator panel takes its key in the URL; it must never leave in a Referer.
      { source: "/ops", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      { source: "/api/ops", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
      // Idea 51: a shared report's token is its URL. It must never leave in a
      // Referer, never be indexed, and never sit in a shared cache.
      {
        source: "/shared/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
