// /pipeline — Customers · Pipeline (P5-17), for a business that sells to businesses.

import type { Metadata } from "next";
import { PipelineScreen } from "../../components/pipeline/PipelineScreen";

export const metadata: Metadata = { title: "Pipeline — SYB" };

export default function PipelinePage() {
  return <PipelineScreen />;
}
