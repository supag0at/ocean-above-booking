// @fb/flight-core: pure domain logic behind the FlightCore contract (@fb/contracts/flight, A-02 §7.6).
// Construction loads and verifies locations.db; every method afterwards is pure and synchronous.
import {
  PRICE_CENTS_PER_KM,
  type City,
  type FlightCore,
  type NearestServed,
  type ResolveCityInput,
  type ResolveResult,
  type Route,
  type RouteResult,
} from '@fb/contracts/flight';
import { formatKm, formatUsdCents } from '@fb/contracts/web';
import { euclid, loadNetwork, type Network } from './data.ts';
import { compareCodePoint, normalize } from './normalize.ts';
import { resolveCity } from './resolve.ts';
import { cheapestPath } from './route.ts';

export { FlightDataError } from './data.ts';
export { normalize, compareCodePoint } from './normalize.ts';

export interface FlightCoreOptions {
  /** Path of locations.db; opened read-only. */
  readonly dbPath: string;
  /** Raw bytes of the same file; their sha256 must equal LOCATIONS_DB_SHA256 or construction throws. */
  readonly dbBytes: Uint8Array;
}

/** `priceCents = Math.round(totalKm × 13)` (A-02 §7.6, M-22 ②; half-up for positive values). */
export function priceCentsFor(totalKm: number): number {
  return Math.round(totalKm * PRICE_CENTS_PER_KM);
}

/** Display string for a distance: 2 decimals, same formatter the web uses. */
export function displayKm(km: number): string {
  return formatKm(km, 'en');
}

export function createFlightCore(options: FlightCoreOptions): FlightCore {
  return new FlightCoreImpl(loadNetwork(options.dbPath, options.dbBytes));
}

class FlightCoreImpl implements FlightCore {
  readonly dataSha256: string;
  readonly #net: Network;
  readonly #byNorm: ReadonlyMap<string, readonly number[]>;
  readonly #nearest = new Map<number, NearestServed | null>();

  constructor(net: Network) {
    this.#net = net;
    this.dataSha256 = net.dataSha256;
    const byNorm = new Map<string, number[]>();
    net.nodes.forEach((n, i) => {
      if (n.norm === '') return;
      const list = byNorm.get(n.norm) ?? [];
      list.push(i);
      byNorm.set(n.norm, list);
    });
    for (const list of byNorm.values()) {
      list.sort((a, b) => compareCodePoint(net.nodes[a]!.city.name, net.nodes[b]!.city.name));
    }
    this.#byNorm = byNorm;
  }

  normalize(s: string): string {
    return normalize(s);
  }

  getCity(name: string): City | undefined {
    const i = this.#idx(name);
    return i === undefined ? undefined : this.#net.nodes[i]!.city;
  }

  isServed(name: string): boolean {
    return this.getCity(name)?.served ?? false;
  }

  nearestServed(name: string): NearestServed | null {
    const i = this.#idx(name);
    return i === undefined ? null : this.#nearestOf(i);
  }

  resolveCity(input: ResolveCityInput): ResolveResult {
    return resolveCity(this.#net, this.#byNorm, input, (i) => this.#nearestOf(i));
  }

  quoteRoute(from: string, to: string): RouteResult {
    const a = this.#idx(from);
    const b = this.#idx(to);
    if (a === undefined || b === undefined) return { ok: false, code: 'CITY_NOT_FOUND' };
    if (a === b) return { ok: false, code: 'SAME_CITY' };
    for (const i of [a, b]) {
      if (!this.#net.nodes[i]!.city.served) {
        const nearest = this.#nearestOf(i);
        return { ok: false, code: 'CITY_NOT_SERVED', ...(nearest === null ? {} : { nearestServed: nearest }) };
      }
    }
    const label = cheapestPath(this.#net, a, b);
    if (label === null) return { ok: false, code: 'NO_ROUTE' };
    return { ok: true, route: this.#toRoute(label.path) };
  }

  #idx(name: string): number | undefined {
    return this.#net.index.get(name.normalize('NFC'));
  }

  #toRoute(path: readonly number[]): Route {
    const cities = path.map((i) => this.#net.nodes[i]!.city);
    const legs = cities
      .slice(1)
      .map((c, k) => ({ from: cities[k]!.name, to: c.name, distanceKm: euclid(cities[k]!, c) }));
    let total = 0;
    for (const l of legs) total += l.distanceKm; // unrounded float64, left to right
    const priceCents = priceCentsFor(total);
    return {
      from: cities[0]!.name,
      to: cities[cities.length - 1]!.name,
      legs,
      transferCities: cities.slice(1, -1).map((c) => c.name),
      totalDistanceKm: total,
      priceCents,
      display: {
        legs: legs.map((l) => displayKm(l.distanceKm)),
        totalDistanceKm: displayKm(total),
        priceUsd: formatUsdCents(priceCents, 'en'),
      },
    };
  }

  /** Euclidean nearest served city excluding itself; ties by normalised name, then raw name (code point). */
  #nearestOf(i: number): NearestServed | null {
    if (this.#nearest.has(i)) return this.#nearest.get(i)!;
    const self = this.#net.nodes[i]!;
    let best: { j: number; km: number } | undefined;
    this.#net.nodes.forEach((n, j) => {
      if (j === i || !n.city.served) return;
      const km = euclid(self.city, n.city);
      if (best === undefined || km < best.km) {
        best = { j, km };
        return;
      }
      if (km === best.km) {
        const cur = this.#net.nodes[best.j]!;
        const c = compareCodePoint(n.norm, cur.norm) || compareCodePoint(n.city.name, cur.city.name);
        if (c < 0) best = { j, km };
      }
    });
    const result =
      best === undefined ? null : { city: this.#net.nodes[best.j]!.city.name, distanceKm: displayKm(best.km) };
    this.#nearest.set(i, result);
    return result;
  }
}
