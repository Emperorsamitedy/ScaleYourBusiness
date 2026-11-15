// The installable app — idea 53 (I-53.1). Served by Next at
// /manifest.webmanifest, and linked from every page's <head>.
//
// It exists so an owner can put SYB on their phone's Home Screen: on an
// iPhone, web push reaches only a Home Screen web app (iOS 16.4 or later,
// Apple's "Sending web push notifications in web apps and browsers"), and
// MDN's manifest guide gives the members a browser needs to install one.
// It opens on the approval queue, because that is what a phone is for here.
// Nothing is cached for offline use: see public/sw.js.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "ScaleX",
    short_name: "ScaleX",
    description: "What waits for your yes, and the card to decide it on.",
    start_url: "/proposals",
    scope: "/",
    display: "standalone",
    // The sheet system's masthead and desk (ux-spec §2).
    background_color: "#0d1321",
    theme_color: "#0D1321",
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
