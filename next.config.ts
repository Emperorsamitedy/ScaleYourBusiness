import type { NextConfig } from "next";

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

const nextConfig: NextConfig = {
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

export default nextConfig;
