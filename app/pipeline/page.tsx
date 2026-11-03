// /pipeline — Customers · Pipeline (P5-17), for a business that sells to businesses.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PipelineScreen } from "../../components/pipeline/PipelineScreen";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pipeline.meta");
  return { title: t("title") };
}

export default function PipelinePage() {
  return <PipelineScreen />;
}
