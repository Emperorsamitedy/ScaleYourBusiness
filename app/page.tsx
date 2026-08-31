// The landing page — cinematic liquid-glass, full spec fidelity
// (owner-directed): background videos, Framer Motion, the works. The
// screen itself is a client component; this wrapper carries metadata.
//
// The previous landing's instruments (MorphDemo, Reel, Arc, Trust) are
// parked in components/landing/, not deleted.

import type { Metadata } from "next";
import { CineLanding } from "@/components/landing/cine/CineLanding";

export const metadata: Metadata = {
  title: "Ledgerline — where your business actually leaks money",
  description:
    "Answer questions about your business for about fifteen minutes. Get back a read on where the money goes, with the arithmetic shown for every figure.",
};

export default function Home() {
  return <CineLanding />;
}
