"use client";

// The sign-up screen's right-hand panel (2026-11-16): a looping tour of
// real ScaleX screens inside a phone, over the holographic growth image.
//
// The screens are screenshots of the demo business (Fernhill Ceramics,
// scripts/seed-demo.ts) at phone size, so the tour shows what is built and
// nothing invented. The loop is pure CSS (app/auth-v2.css): eleven slides,
// three seconds each; with reduced motion the first screen simply stays.

import { useTranslations } from "next-intl";

/** The screens in order: file under public/auth/reel and its caption key. */
export const REEL = [
  ["01-home.jpg", "home"],
  ["02-report.jpg", "report"],
  ["03-proposals.jpg", "proposals"],
  ["04-cash.jpg", "cash"],
  ["05-stock.jpg", "stock"],
  ["06-customers.jpg", "customers"],
  ["07-support.jpg", "support"],
  ["08-competitors.jpg", "competitors"],
  ["09-benchmarks.jpg", "benchmarks"],
  ["10-connections.jpg", "connections"],
  ["11-chat.jpg", "chat"],
] as const;

export const REEL_STEP_SECONDS = 3;

function StatusBar() {
  return (
    <div className="ip-status">
      <span>9:41</span>
      <svg width="64" height="12" viewBox="0 0 64 12" fill="#FFFFFF" aria-hidden="true">
        <rect x="0" y="8" width="3" height="4" rx="1" />
        <rect x="4.5" y="6" width="3" height="6" rx="1" />
        <rect x="9" y="3.5" width="3" height="8.5" rx="1" />
        <rect x="13.5" y="1" width="3" height="11" rx="1" />
        <path d="M28 3.4a9 9 0 0 1 12 0l-1.4 1.5a7 7 0 0 0-9.2 0z M30.6 6.2a5.2 5.2 0 0 1 6.8 0L36 7.7a3.2 3.2 0 0 0-4 0z M33 9.3a1.6 1.6 0 0 1 2 0L34 10.7z" />
        <rect
          x="45"
          y="1.5"
          width="15"
          height="9"
          rx="2.6"
          fill="none"
          stroke="#FFFFFF"
          strokeOpacity="0.45"
        />
        <rect x="46.5" y="3" width="11" height="6" rx="1.5" />
        <rect x="60.8" y="4.3" width="1.6" height="3.4" rx="0.8" fillOpacity="0.45" />
      </svg>
    </div>
  );
}

export function AuthReel() {
  const t = useTranslations("auth.reel");
  return (
    <aside className="ax-visual" aria-label={t("label")}>
      <img className="ax-visual-bg" src="/auth/holo.jpg" alt="" />
      <div className="ax-visual-shade" />
      <div className="iphone">
        <span className="ip-btn ip-action" />
        <span className="ip-btn ip-vol-up" />
        <span className="ip-btn ip-vol-down" />
        <span className="ip-btn ip-power" />
        <span className="ip-btn ip-camera" />
        <div className="ip-body">
          <div className="ip-bezel">
            <div className="ip-screen">
              <StatusBar />
              <div className="ip-island" />
              <div className="ip-view">
                {REEL.map(([file, key], i) => (
                  <img
                    key={file}
                    className="reel-slide"
                    src={`/auth/reel/${file}`}
                    alt={t(key)}
                    style={{ animationDelay: `${i * REEL_STEP_SECONDS}s` }}
                  />
                ))}
              </div>
              <div className="ip-home" />
              <div className="ip-glare" />
            </div>
          </div>
        </div>
      </div>
      <div className="reel-caps" aria-hidden="true">
        {REEL.map(([file, key], i) => (
          <span
            key={file}
            className="reel-cap"
            style={{ animationDelay: `${i * REEL_STEP_SECONDS}s` }}
          >
            {t(key)}
          </span>
        ))}
      </div>
      <div className="reel-track" aria-hidden="true">
        <span className="reel-bar" />
      </div>
    </aside>
  );
}
