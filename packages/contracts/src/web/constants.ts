// Global constants that belong to the web entry (CONTRACT-v1 §3).
// M-13: PRICE_PER_KM_USD is NOT here. The browser must not hold anything that can compute a price
// (H-01); the per-km rate lives only in @fb/contracts/flight.

/**
 * Display rounding (CONTRACT §3, D-09). Internally everything is unrounded float64; only the
 * display strings are rounded: distance to 2 decimals, price rounded to 0.01 USD.
 * The frontend NEVER computes prices: it shows `Quote.display` as given (A-01 §4.5) and may only
 * format values the API already computed with `formatKm` / `formatUsdCents` (format.ts, M-13).
 */
export const DISPLAY_ROUNDING = {
  distanceKmDecimals: 2,
  priceUsdDecimals: 2,
} as const;

export type DisplayRounding = typeof DISPLAY_ROUNDING;

/**
 * Shared uuid `pattern` (M-15): contracts never use the JSON-Schema format keyword, so no ajv-formats dependency.
 * Anchored, case-insensitive hex. Reused by web and server schemas.
 */
export const UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
