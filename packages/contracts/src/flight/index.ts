// @fb/contracts/flight: flight-core public interface types, global constants (CONTRACT-v1 §3) and the
// transliteration table. Types and constants only: no implementation, no IO, no imports (T01 / T03 split).
// Sources: A-02 §7.1, §7.2, §7.6; CONTRACT-v1 §3.

// ---------------------------------------------------------------------------------------------
// Global constants (CONTRACT-v1 §3). Every implementation must import these, never hard-code them.
// ---------------------------------------------------------------------------------------------

/** Price per kilometre in USD (assignment). Integer-cent form: {@link PRICE_CENTS_PER_KM}. */
export const PRICE_PER_KM_USD = 0.13;
/** `priceCents = roundHalfUp(totalDistanceKm * PRICE_CENTS_PER_KM)` (A-02 §7.6). */
export const PRICE_CENTS_PER_KM = 13;

/** sha256 of `locations.db`; flight-core must refuse to start on mismatch (A-02 §7.6, CT-10). */
export const LOCATIONS_DB_SHA256 = 'fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f';

/**
 * Rounding (D-09): all computation uses unrounded float64. Only the display strings are rounded:
 * distance to 2 decimals, price = priceCents / 100 with 2 decimals (priceCents itself is roundHalfUp
 * of totalDistanceKm * 13).
 */
export const DISTANCE_DISPLAY_DECIMALS = 2;
export const PRICE_DISPLAY_DECIMALS = 2;
export const PRICE_ROUNDING_MODE = 'half-up' as const;

/** Two distances whose absolute difference is below this are treated as equal (A-02 §7.6). */
export const DISTANCE_TIE_EPSILON_KM = 1e-6;
/**
 * Tie-break order (D-09), applied in sequence: total distance, then fewer legs, then the city-name
 * sequence compared lexicographically by Unicode code point.
 */
export const TIE_BREAK_ORDER = ['totalDistance', 'legCount', 'citySequenceCodePointLex'] as const;
export type TieBreakKey = (typeof TIE_BREAK_ORDER)[number];

/** Per-run limits (D-40). Times in milliseconds. */
export const RUN_LIMITS = {
  maxTurns: 8,
  maxToolCalls: 12,
  requestTimeoutMs: 60_000,
  runTimeoutMs: 120_000,
  restartLimit: 3,
} as const;

/** LLM output cap (D-50). */
export const MAX_TOKENS = 4096;

/** Compaction watermarks in tokens and the summary quote cap (D-57). */
export const COMPACT_HIGH = 40_000;
export const COMPACT_LOW = 16_000;
export const COMPACT_MAX_QUOTES = 20;

/** Model (D-05, D-41, D-48): low reasoning effort, strict tool mode NOT used. */
export const MODEL_ID = 'deepseek-flash';
export const MODEL_REASONING = 'low' as const;
export const MODEL_STRICT_TOOLS = false as const;

// ---------------------------------------------------------------------------------------------
// Normalisation: transliteration table only. The `norm()` function itself is implemented by T03.
// Pipeline (A-02 §7.1, CONTRACT-v1 §3): NFKC + strip zero-width -> TRANSLITERATION_TABLE ->
// NFKD + strip combining marks + lowercase -> drop apostrophes and periods -> other non [0-9a-z]
// to space, collapse. After normalisation two different cities may share a name (San Jose /
// San José): such a hit MUST be reported as `ambiguous`, never silently picked.
// ---------------------------------------------------------------------------------------------

/**
 * Letters NFKD cannot decompose (R-01 §4). Case is preserved here; `norm` lowercases afterwards so
 * both capital and small forms end up identical.
 * TODO(T01-REVIEW): the task brief lists 11 entries; A-02 §7.1 step 2 additionally lists Œ, ð, ı, ħ.
 * The four extras are included here (A-02 is the normative source for norm). Confirm. Capital Ð / Ħ /
 * Þ are in neither list; add them if the golden test (711 names, only San Jose/San José collide) needs.
 */
export const TRANSLITERATION_TABLE: Readonly<Record<string, string>> = {
  ø: 'o',
  Ø: 'O',
  ł: 'l',
  Ł: 'L',
  æ: 'ae',
  Æ: 'AE',
  œ: 'oe',
  Œ: 'OE',
  ß: 'ss',
  đ: 'd',
  Đ: 'D',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ħ: 'h',
};

/** Zero-width characters removed in step 1 of the pipeline: U+200B-U+200F, U+2060, U+FEFF. */
export const ZERO_WIDTH_CHARS_PATTERN = '[\\u200B-\\u200F\\u2060\\uFEFF]';

// ---------------------------------------------------------------------------------------------
// Types (A-02 §7.1, §7.2, §7.6)
// ---------------------------------------------------------------------------------------------

/** One row of `locations.db` plus derived fields. Coordinates are fictional integer pairs. */
export interface City {
  /** `city_name` verbatim (NFC). The only form `quote_route` accepts. */
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly isHub: boolean;
  /** `served = isHub || connectedHubs.length > 0`. */
  readonly served: boolean;
  readonly connectedHubs: readonly string[];
}

/** Distance of one flight leg: unrounded float64 km (internal), never rounded for arithmetic. */
export interface Leg {
  readonly from: string;
  readonly to: string;
  readonly distanceKm: number;
}

/** Display strings; distance 2 decimals, price = priceCents / 100 with 2 decimals. */
export interface RouteDisplay {
  readonly legs: readonly string[];
  readonly totalDistanceKm: string;
  readonly priceUsd: string;
}

/** Pure computation result of a route query (no id, no timestamp). */
export interface Route {
  readonly from: string;
  readonly to: string;
  readonly legs: readonly Leg[];
  /** Intermediate cities (always hubs). */
  readonly transferCities: readonly string[];
  /** Sum of raw leg distances, not rounded. */
  readonly totalDistanceKm: number;
  /** `roundHalfUp(totalDistanceKm * 13)` */
  readonly priceCents: number;
  readonly display: RouteDisplay;
}

/** A persisted, immutable quote (A-02 §7.2 data). */
export interface Quote extends Route {
  /** `q_<ULID>` */
  readonly quoteId: string;
  /** Must equal {@link LOCATIONS_DB_SHA256}. */
  readonly dataSha256: string;
  /** ISO-8601 */
  readonly createdAt: string;
}

/** Nearest served city for an unserved one. Distance is a 2-decimal string (e.g. "120.95"). */
export interface NearestServed {
  readonly city: string;
  readonly distanceKm: string;
}

export interface CityMatch {
  readonly city: string;
  readonly isHub: boolean;
  readonly served: boolean;
  readonly connectedHubs: readonly string[];
  /** MUST be non-null when `served` is false (A-02 §7.1); null when served. */
  readonly nearestServed: NearestServed | null;
}

export type ResolveStatus = 'exact' | 'ambiguous' | 'suggest' | 'not_found';

export interface MatchedBy {
  readonly source: 'candidate' | 'original' | 'fuzzy';
  /** Index into `candidates` when `source` is `candidate`. */
  readonly index?: number;
}

export interface ResolveCityInput {
  /** What the user typed, any language, 1..80 chars. */
  readonly original: string;
  /** 1..3 English names, most likely first. */
  readonly candidates: readonly string[];
}

export interface ResolveResult {
  readonly status: ResolveStatus;
  /** At most 5 entries. */
  readonly matches: readonly CityMatch[];
  /** TODO(T01-REVIEW): A-02 §7.1 gives no value of matchedBy for `not_found`; typed optional. */
  readonly matchedBy?: MatchedBy;
}

/** Business failures of route computation. Codes are a subset of the agent error codes (A-02 §5.3). */
export type RouteErrorCode = 'CITY_NOT_FOUND' | 'CITY_NOT_SERVED' | 'SAME_CITY' | 'NO_ROUTE';

export type RouteResult =
  | { readonly ok: true; readonly route: Route }
  | {
      readonly ok: false;
      readonly code: RouteErrorCode;
      /** Present for CITY_NOT_SERVED (A-02 §7.2). */
      readonly nearestServed?: NearestServed;
    };

/**
 * flight-core public surface. Signatures only (T03 implements; T04 cross-checks with another algorithm).
 * Pure and synchronous after construction; loading/hash verification happens in the factory, not here.
 * TODO(T01-REVIEW): A-02 §7 does not define the exact TS surface of flight-core; this shape is derived
 * from §7.1/§7.2/§7.6 and is the T01 proposal. `normalize` is exposed because save_preference and
 * quote_route share `norm`.
 */
export interface FlightCore {
  /** `norm(s)` per the pipeline above. */
  normalize(s: string): string;
  /** Lookup by exact `city_name` (NFC compare only). */
  getCity(name: string): City | undefined;
  /** `served(c) = c.isHub || connectedHubs non-empty`. */
  isServed(name: string): boolean;
  /** Nearest served city (Euclidean, excluding itself; ties by normalised name). */
  nearestServed(name: string): NearestServed | null;
  /** D-37 matching flow. */
  resolveCity(input: ResolveCityInput): ResolveResult;
  /** Cheapest route: hub-only transfers, D-09 tie-breaks. */
  quoteRoute(from: string, to: string): RouteResult;
  /** sha256 actually computed from the loaded file (equals LOCATIONS_DB_SHA256 or startup fails). */
  readonly dataSha256: string;
}
