// Global constants that belong to the web entry (CONTRACT-v1 §3).
// TODO(T01-REVIEW): CONTRACT §3 does not say which entry owns PRICE_PER_KM_USD, and A-01 §1.3 does
// not list it as a web item (the formatting function lives in @fb/contracts/server). It is placed
// here on the parent's instruction; confirm it should not live in @fb/contracts/flight instead.

/** USD per km (the take-home spec). */
export const PRICE_PER_KM_USD = 0.13;

/**
 * Display rounding (CONTRACT §3, D-09). Internally everything is unrounded float64; only the
 * display strings are rounded: distance to 2 decimals, price rounded to 0.01 USD.
 * The frontend NEVER rounds by itself: it shows `Quote.display` as given (A-01 §4.5).
 * The one real formatting function lives in @fb/contracts/server, not here.
 */
export const DISPLAY_ROUNDING = {
  distanceKmDecimals: 2,
  priceUsdDecimals: 2,
} as const;

export type DisplayRounding = typeof DISPLAY_ROUNDING;
