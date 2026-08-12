import { ZONE_COUNTRY } from "@/lib/timezone-countries";

/**
 * The searchable timezone list every picker shares.
 *
 * A timezone's honest name is a city, but nobody thinks in IANA ids: people
 * look for "Turkey" or "US", and a picker that only matches "Europe/Istanbul"
 * makes them translate first. So each zone carries a haystack of everything a
 * person might type — the id, the city, the country's English name and its
 * two-letter code — and one filter reads them all. The *list* stays a list of
 * timezones: a country search surfaces that country's zones (all four US
 * mainland clocks for "us"), it does not collapse them.
 */

export type ZoneEntry = {
  /** The IANA id — what every API call carries. */
  zone: string;
  /** The id's last segment, underscores as spaces: "New York". */
  city: string;
  /** English country name via `Intl.DisplayNames`, or null (UTC, Etc/*). */
  country: string | null;
  /** What a row shows: "New York, United States" or the bare city. */
  label: string;
  haystack: string;
};

let cache: ZoneEntry[] | null = null;

/** All zones the runtime supports, alphabetical by city. Built once. */
export function zoneEntries(): ZoneEntry[] {
  if (cache) return cache;

  // `type: "region"` never throws on the codes zone.tab uses; a runtime
  // without DisplayNames just searches by zone names alone.
  let regionNames: Intl.DisplayNames | null = null;
  try {
    regionNames = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    regionNames = null;
  }

  cache = Intl.supportedValuesOf("timeZone")
    .map((zone) => {
      const city = (zone.split("/").pop() ?? zone).replaceAll("_", " ");
      const code = ZONE_COUNTRY[zone];
      let country: string | null = null;
      if (code && regionNames) {
        try {
          country = regionNames.of(code) ?? null;
        } catch {
          country = null;
        }
      }
      return {
        zone,
        city,
        country,
        label: country ? `${city}, ${country}` : city,
        haystack:
          `${zone.replaceAll("_", " ")} ${city} ${country ?? ""} ${code ?? ""}`.toLowerCase(),
      };
    })
    .sort((a, b) => a.city.localeCompare(b.city) || a.zone.localeCompare(b.zone));
  return cache;
}

/**
 * Every whitespace-separated token must match (so "istanbul turkey" narrows
 * rather than widens), and rows whose city or country *starts* with the
 * query come first — typing "in" should lead with India, not bury it under
 * every city containing the pair.
 */
export function filterZones(entries: ZoneEntry[], query: string): ZoneEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return entries;
  const tokens = needle.split(/\s+/u);

  const rank = (entry: ZoneEntry): number => {
    if (entry.city.toLowerCase().startsWith(needle)) return 0;
    if (entry.country?.toLowerCase().startsWith(needle)) return 1;
    return 2;
  };

  return entries
    .filter((entry) => tokens.every((token) => entry.haystack.includes(token)))
    .sort((a, b) => rank(a) - rank(b));
}

/** The trigger's text for a picked zone: "Istanbul, Türkiye". */
export function zoneLabel(zone: string): string {
  const entry = zoneEntries().find((candidate) => candidate.zone === zone);
  return entry ? entry.label : zone.replaceAll("_", " ");
}
