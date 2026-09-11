// /signup — the same one-motion auth, met with sign-up words (P1-49).

import type { Metadata } from "next";
import { LoginScreen } from "../../components/auth/Login";

export const metadata: Metadata = { title: "Create your account — Ledgerline" };

export default function SignupPage() {
  return <LoginScreen variant="signup" />;
}
