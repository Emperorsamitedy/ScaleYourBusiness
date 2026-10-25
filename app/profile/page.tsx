// The fact sheet — P1-59/60. Server wrapper; the screen is a client
// component reading GET /api/profile.

import type { Metadata } from "next";
import { FactSheetScreen } from "@/components/profile/FactSheet";

export const metadata: Metadata = {
  title: "Your fact sheet — SYB",
};

export default function ProfilePage() {
  return <FactSheetScreen />;
}
