// /landing-v2 — where the v2 landing page was previewed before it became
// the front page (2026-11-16). Links to the preview keep working: they land
// on the front page.

import { permanentRedirect } from "next/navigation";

export default function LandingV2Preview() {
  permanentRedirect("/");
}
