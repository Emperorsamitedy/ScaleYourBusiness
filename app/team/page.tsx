// /team — Insights · Team cover (Phase 5 Session E, P5-20; rule 28).
// Off by default: the screen says how to switch it on and shows nothing else.

import type { Metadata } from "next";
import { TeamScreen } from "../../components/team/TeamScreen";

export const metadata: Metadata = { title: "Team cover — SYB" };

export default function TeamPage() {
  return <TeamScreen />;
}
