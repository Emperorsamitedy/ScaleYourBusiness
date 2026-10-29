// /reviews — Customers · Reviews: forwarded and pasted reviews, and suggested replies (idea 45).

import type { Metadata } from "next";
import { ReviewsScreen } from "../../components/reviews/ReviewsScreen";

export const metadata: Metadata = { title: "Reviews — SYB" };

export default function ReviewsPage() {
  return <ReviewsScreen />;
}
