// The benchmark resolver's cold-start ladder — the multi-market spec §D.1.
//
//   1. national  the live cohort in the reader's own country, k ≥ 7
//   2. regional  live cohorts in neighbouring countries (same NACE, same
//                segment); the label names them and warns their cost base
//                differs
//   3. official  official statistics, with their vintage (v1 spec §5.4)
//   4. none
//
// Every answer says which rung it came from, so a served benchmark always
// carries its origin — never a silent fallback. A money benchmark's
// regional rung counts only neighbours in the reader's own currency: a
// cohort has one currency (§A.7) and nothing is converted to compare.
//
// The rungs are handed in as sources, so the ladder is the same whatever
// computes them (today's peer aggregate; Phase 4's measured cohorts).

import neighboursFile from "../../specs/benchmark-neighbours-v1.json";
import type { AppLocale } from "../i18n/locales";
import { LOCALES } from "../i18n/locales";

export type Rung = "national" | "regional" | "official" | "none";

export interface Origin {
  rung: Rung;
  /** regional: the neighbouring countries whose businesses it came from. */
  countries?: string[];
  /** official: the statistics' source and reference year. */
  source?: string;
  vintage?: string;
}

export interface Served<V> {
  value: V | null;
  origin: Origin;
  /** The origin in plain words, in every app language — the UI shows the reader's. */
  label: Readonly<Record<AppLocale, string>>;
}

export interface Sources<V> {
  national: () => Promise<V | null>;
  /** The neighbours' pooled cohort, or null below k = 7. */
  regional: (countries: readonly string[]) => Promise<V | null>;
  official: () => Promise<{ value: V; source: string; vintage: string } | null>;
}

const NEIGHBOURS = (neighboursFile as { neighbours: Record<string, string[]> }).neighbours;

export function neighboursOf(country: string): string[] {
  return [...(NEIGHBOURS[country.toUpperCase()] ?? [])];
}

// Each label in each language. Country names come from Intl in the
// reader's language, so no country is ever translated by hand.
const WORDS: Record<AppLocale, Record<Rung, string>> = {
  en: {
    national: "Compared with similar businesses in your country.",
    regional:
      "Compared with similar businesses in {countries} — not yet enough in your country. Their costs aren't yours: rent, wages and prices differ.",
    official:
      "From official statistics ({source}, {vintage}) — not yet enough similar businesses using ScaleX.",
    none: "No comparison yet: not enough similar businesses, and no official figure fits.",
  },
  "es-ES": {
    national: "Comparado con negocios similares de tu país.",
    regional:
      "Comparado con negocios similares de {countries}; aún no hay suficientes en tu país. Sus costes no son los tuyos: alquileres, salarios y precios difieren.",
    official:
      "Según estadísticas oficiales ({source}, {vintage}); aún no hay suficientes negocios similares usando ScaleX.",
    none: "Aún no hay comparación: no hay suficientes negocios similares ni una cifra oficial que encaje.",
  },
  "de-DE": {
    national: "Verglichen mit ähnlichen Betrieben in Ihrem Land.",
    regional:
      "Verglichen mit ähnlichen Betrieben in {countries} – in Ihrem Land sind es noch zu wenige. Deren Kosten sind nicht Ihre: Mieten, Löhne und Preise unterscheiden sich.",
    official:
      "Aus amtlicher Statistik ({source}, {vintage}) – noch zu wenige ähnliche Betriebe nutzen ScaleX.",
    none: "Noch kein Vergleich: zu wenige ähnliche Betriebe und keine passende amtliche Zahl.",
  },
  "fr-FR": {
    national: "Comparé à des entreprises similaires de votre pays.",
    regional:
      "Comparé à des entreprises similaires en {countries} — pas encore assez dans votre pays. Leurs coûts ne sont pas les vôtres : loyers, salaires et prix diffèrent.",
    official:
      "D’après la statistique officielle ({source}, {vintage}) — pas encore assez d’entreprises similaires sur ScaleX.",
    none: "Pas encore de comparaison : trop peu d’entreprises similaires, et aucun chiffre officiel ne correspond.",
  },
  "hu-HU": {
    national: "Hasonló hazai vállalkozásokhoz viszonyítva.",
    regional:
      "Hasonló vállalkozásokhoz viszonyítva itt: {countries} — az Ön országában még nincs elég. Az ő költségeik nem az Önéi: a bérleti díjak, a bérek és az árak eltérnek.",
    official:
      "Hivatalos statisztika alapján ({source}, {vintage}) — még nem használ elég hasonló vállalkozás ScaleX-et.",
    none: "Még nincs összehasonlítás: kevés a hasonló vállalkozás, és nincs illő hivatalos adat.",
  },
  "ru-RU": {
    national: "В сравнении с похожими компаниями в вашей стране.",
    regional:
      "В сравнении с похожими компаниями в странах: {countries} — в вашей стране их пока мало. Их расходы не ваши: аренда, зарплаты и цены отличаются.",
    official:
      "По официальной статистике ({source}, {vintage}) — похожих компаний в ScaleX пока мало.",
    none: "Сравнения пока нет: мало похожих компаний и нет подходящих официальных данных.",
  },
  "zh-Hans": {
    national: "与您所在国家的同类企业相比。",
    regional:
      "与{countries}的同类企业相比——您所在国家的同类企业还不够多。他们的成本与您不同：租金、工资和价格都有差异。",
    official: "来自官方统计（{source}，{vintage}）——使用 ScaleX 的同类企业还不够多。",
    none: "暂无比较：同类企业不足，也没有合适的官方数据。",
  },
};

function countryList(codes: readonly string[], locale: AppLocale): string {
  const names = new Intl.DisplayNames([locale === "zh-Hans" ? "zh-Hans" : locale], {
    type: "region",
  });
  const named = codes.map((c) => names.of(c) ?? c);
  return new Intl.ListFormat([locale], { type: "conjunction" }).format(named);
}

/** The origin in words, in every app language. */
export function originLabels(origin: Origin): Record<AppLocale, string> {
  const out = {} as Record<AppLocale, string>;
  for (const locale of LOCALES) {
    out[locale] = WORDS[locale][origin.rung]
      .replace("{countries}", countryList(origin.countries ?? [], locale))
      .replace("{source}", origin.source ?? "")
      .replace("{vintage}", origin.vintage ?? "");
  }
  return out;
}

/** Walk the ladder; return the first rung that answers, and say which. */
export async function resolveBenchmark<V>(
  country: string,
  sources: Sources<V>,
): Promise<Served<V>> {
  const national = await sources.national();
  if (national !== null) {
    const origin: Origin = { rung: "national" };
    return { value: national, origin, label: originLabels(origin) };
  }
  const near = neighboursOf(country);
  if (near.length > 0) {
    const regional = await sources.regional(near);
    if (regional !== null) {
      const origin: Origin = { rung: "regional", countries: near };
      return { value: regional, origin, label: originLabels(origin) };
    }
  }
  const official = await sources.official();
  if (official !== null) {
    const origin: Origin = { rung: "official", source: official.source, vintage: official.vintage };
    return { value: official.value, origin, label: originLabels(origin) };
  }
  const origin: Origin = { rung: "none" };
  return { value: null, origin, label: originLabels(origin) };
}
