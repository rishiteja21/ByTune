/**
 * Market resolution — which country's YTM catalog a cold-start user sees.
 *
 * Pure and dependency-free on purpose: the resolver is wired to Electron's
 * OS signals in main.ts/music-service.ts, but every decision here is a
 * deterministic function of its inputs so it can be unit-tested directly.
 *
 * Priority (strongest signal first):
 *   1. development-only override (BYTUNE_MARKET) — dev/test builds ONLY,
 *      never honoured in a packaged app
 *   2. OS region code — on Windows `app.getLocaleCountryCode()` reads the
 *      user's regional *format* setting, i.e. their country. This is the
 *      "English Windows + India timezone" safeguard: the display language
 *      never decides the market.
 *   3. timezone → country — for OSes that report no region code.
 *   4. "US" — YouTube Music's own default region; the global/default feed.
 *
 * The market is deliberately a DEVICE-level property, not account data: it
 * describes where the device is (what content is available/relevant there),
 * it changes when the user moves, and it never leaks into another account.
 */

export type MarketSource = "override" | "os-region" | "timezone" | "default";

export interface MarketSignals {
  /** ISO 3166-1 alpha-2 country from the OS regional settings, or null. */
  osRegion?: string | null;
  /** IANA timezone ("Asia/Kolkata"), or null. */
  timeZone?: string | null;
  /** Development override value (BYTUNE_MARKET). Ignored unless isDev. */
  override?: string | null;
  /** True in unpackaged/dev runs only. */
  isDev?: boolean;
}

export interface ResolvedMarket {
  /** ISO 3166-1 alpha-2, uppercase — the InnerTube `gl`. */
  country: string;
  source: MarketSource;
}

/** YouTube Music's own default region — the provider's global fallback. */
export const DEFAULT_MARKET = "US";

/** Normalize to a strict ISO-3166 alpha-2 code, or null when unusable. */
export function normalizeCountry(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(clean) ? clean : null;
}

/**
 * IANA timezone → ISO-3166 alpha-2 for the zones ByTune can name confidently.
 * Deliberately NOT exhaustive: an unmapped zone yields null and the caller
 * falls back to the provider default rather than guessing a wrong country.
 * (Zone → country pairs follow the tz database's zone.tab.)
 */
const TZ_COUNTRY: Record<string, string> = {
  // South Asia
  "asia/kolkata": "IN", "asia/calcutta": "IN", "asia/karachi": "PK",
  "asia/dhaka": "BD", "asia/colombo": "LK", "asia/kathmandu": "NP",
  // North America
  "america/new_york": "US", "america/detroit": "US", "america/chicago": "US",
  "america/denver": "US", "america/phoenix": "US", "america/los_angeles": "US",
  "america/anchorage": "US", "pacific/honolulu": "US", "america/toronto": "CA",
  "america/vancouver": "CA", "america/winnipeg": "CA", "america/halifax": "CA",
  "america/mexico_city": "MX", "america/guatemala": "GT",
  // South America
  "america/sao_paulo": "BR", "america/bahia": "BR", "america/fortaleza": "BR",
  "america/bogota": "CO", "america/lima": "PE", "america/santiago": "CL",
  "america/buenos_aires": "AR", "america/montevideo": "UY",
  // Europe
  "europe/london": "GB", "europe/dublin": "IE", "europe/paris": "FR",
  "europe/madrid": "ES", "europe/barcelona": "ES", "europe/lisbon": "PT",
  "europe/berlin": "DE", "europe/munich": "DE", "europe/rome": "IT",
  "europe/milan": "IT", "europe/amsterdam": "NL", "europe/brussels": "BE",
  "europe/vienna": "AT", "europe/zurich": "CH", "europe/prague": "CZ",
  "europe/warsaw": "PL", "europe/budapest": "HU", "europe/bucharest": "RO",
  "europe/athens": "GR", "europe/stockholm": "SE", "europe/oslo": "NO",
  "europe/copenhagen": "DK", "europe/helsinki": "FI", "europe/moscow": "RU",
  "europe/saint_petersburg": "RU", "europe/kiev": "UA", "europe/kyiv": "UA",
  "europe/istanbul": "TR", "europe/minsk": "BY",
  // East / Southeast Asia
  "asia/tokyo": "JP", "asia/seoul": "KR", "asia/shanghai": "CN",
  "asia/hong_kong": "HK", "asia/taipei": "TW", "asia/singapore": "SG",
  "asia/kuala_lumpur": "MY", "asia/manila": "PH", "asia/jakarta": "ID",
  "asia/bangkok": "TH", "asia/ho_chi_minh": "VN", "asia/hanoi": "VN",
  // Middle East
  "asia/dubai": "AE", "asia/riyadh": "SA", "asia/qatar": "QA",
  "asia/kuwait": "KW", "asia/jerusalem": "IL", "asia/tel_aviv": "IL",
  "asia/amman": "JO", "asia/beirut": "LB", "asia/tehran": "IR",
  // Africa
  "africa/cairo": "EG", "africa/lagos": "NG", "africa/nairobi": "KE",
  "africa/accra": "GH", "africa/johannesburg": "ZA", "africa/casablanca": "MA",
  // Oceania
  "australia/sydney": "AU", "australia/melbourne": "AU",
  "australia/brisbane": "AU", "australia/perth": "AU",
  "pacific/auckland": "NZ",
};

/** IANA timezone → ISO country code, or null when the zone is unknown. */
export function timezoneToCountry(timeZone: string | null | undefined): string | null {
  if (typeof timeZone !== "string" || !timeZone.trim()) return null;
  return TZ_COUNTRY[timeZone.trim().toLowerCase()] ?? null;
}

/**
 * Resolve the device market. Never throws, never returns null — the last
 * step is always the provider's global default, so a feed built on this can
 * only ever degrade to "global", never to blank.
 */
export function resolveMarket(signals: MarketSignals): ResolvedMarket {
  // Development override — gated to dev builds at the resolver level so a
  // stray env var in a packaged app can never redirect real users' feeds.
  if (signals.isDev) {
    const override = normalizeCountry(signals.override);
    if (override) return { country: override, source: "override" };
  }
  const osRegion = normalizeCountry(signals.osRegion);
  if (osRegion) return { country: osRegion, source: "os-region" };
  const tz = timezoneToCountry(signals.timeZone);
  if (tz) return { country: tz, source: "timezone" };
  return { country: DEFAULT_MARKET, source: "default" };
}
