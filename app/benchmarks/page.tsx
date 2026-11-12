// /benchmarks — Insights · Compared with similar businesses (idea 44).

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BenchmarksScreen } from "../../components/benchmarks/BenchmarksScreen";
import { PeerPanel } from "../../components/peers/PeerPanel";
import { resolveAccess } from "../../lib/auth/access";
import { requestLocale } from "../../lib/i18n/server";
import { trFor } from "../../lib/i18n/server-tr";
import { peerBenchmarks } from "../../lib/peers/benchmark";
import { hasPeerConsent } from "../../lib/peers/consent";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("benchmarks.meta");
  return { title: t("title") };
}

export const dynamic = "force-dynamic";

/** The live peer comparison (v1 spec §5) is read here, on the server; the Eurostat sheets load below it. */
export default async function BenchmarksPage() {
  const access = await resolveAccess();
  if (!access) return <BenchmarksScreen />;
  const locale = await requestLocale();
  const [benchmarks, contributing] = await Promise.all([
    peerBenchmarks(access.profile_id),
    hasPeerConsent(access.profile_id),
  ]);
  return (
    <BenchmarksScreen
      peers={
        <PeerPanel
          benchmarks={benchmarks}
          contributing={contributing}
          locale={locale}
          tr={trFor(locale, "peers")}
        />
      }
    />
  );
}
