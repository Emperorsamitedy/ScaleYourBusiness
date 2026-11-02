// /reviews — Customers · Reviews: forwarded and pasted reviews, and suggested replies (idea 45).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ReviewsScreen } from "../../components/reviews/ReviewsScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reviews.meta");
  return { title: t("title") };
}

export default function ReviewsPage() {
  return <ReviewsScreen />;
}
