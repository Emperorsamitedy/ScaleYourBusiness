// /carts — Customers · Abandoned carts: what was left, and who may be reminded (idea 47).

import type { Metadata } from "next";
import { CartsScreen } from "../../components/carts/CartsScreen";

export const metadata: Metadata = { title: "Abandoned carts — SYB" };

export default function CartsPage() {
  return <CartsScreen />;
}
