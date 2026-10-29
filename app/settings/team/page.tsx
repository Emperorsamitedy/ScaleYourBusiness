// /settings/team — Your business · Team access: who can sign in (idea 52).

import type { Metadata } from "next";
import { TeamAccessScreen } from "../../../components/members/TeamAccessScreen";

export const metadata: Metadata = { title: "Team access — SYB" };

export default function TeamAccessPage() {
  return <TeamAccessScreen />;
}
