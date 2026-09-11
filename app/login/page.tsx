// /login — P1-49. Server wrapper; the form is a client component.

import type { Metadata } from "next";
import { LoginScreen } from "../../components/auth/Login";

export const metadata: Metadata = {
  title: "Sign in — Ledgerline",
};

export default function LoginPage() {
  return <LoginScreen />;
}
