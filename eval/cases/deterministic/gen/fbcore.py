"""T13a reference computation used ONLY to produce expected values for eval/cases.

This is NOT the oracle (eval/oracle/** is an isolated task) and NOT flight-core.
It is deliberately written as an exhaustive enumeration (bounded DFS over all
hub paths whose length is within EPS of the optimum), not Dijkstra, so that
tie-breaking is decided by an explicit sort, which is easy to audit.

Algorithm (A-02 §7.6, CONTRACT-v1 §3, D-09):
  * served(c) = is_hub or connected_hubs non-empty
  * undirected graph: every hub_links pair + every (non-hub, hub in connected_hubs)
  * edge weight = float64 Euclidean distance between integer coordinates (km)
  * intermediate nodes must be hubs (non-hub cities are only endpoints)
  * cheapest = minimal total distance; ties (|d1-d2| < 1e-6) broken by
    (number of legs asc, city sequence compared by Unicode code point asc)
  * totalDistanceKm = sum of raw leg distances (no rounding)
  * priceCents = roundHalfUp(totalDistanceKm * 13)
  * display: km -> 2 decimals (half-up on the raw value), USD = priceCents/100
  * nearestServed(c) = argmin Euclidean distance over served cities != c,
    ties by norm(name) lexicographic
"""
import math
import sqlite3
import unicodedata
import re
import heapq
import hashlib
import os
from decimal import Decimal, ROUND_HALF_UP

EPS = 1e-6
DB_SHA256 = "fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f"

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "locations.db"))

# ---------------------------------------------------------------- norm (A-02 §7.1 + CONTRACT M-19)
ZERO_WIDTH = re.compile("[​-‏⁠﻿]")
TRANSLIT = {
    "ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe",
    "ß": "ss", "đ": "d", "Đ": "d", "ð": "d", "Ð": "d", "þ": "th", "Þ": "th",
    "ı": "i", "ħ": "h", "Ħ": "h",
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = ZERO_WIDTH.sub("", s)
    s = "".join(TRANSLIT.get(ch, ch) for ch in s)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = re.sub(r"['’.]", "", s)
    s = re.sub(r"[^0-9a-z]+", " ", s)
    return s.strip()


# ---------------------------------------------------------------- data
class World:
    def __init__(self, path=DB_PATH):
        with open(path, "rb") as f:
            self.sha256 = hashlib.sha256(f.read()).hexdigest()
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        self.coord, self.is_hub, self.conn = {}, {}, {}
        for name, coord, hub, ch in con.execute("select city_name, coordinate, is_hub, connected_hubs from locations"):
            x, y = (int(v) for v in coord.split(","))
            self.coord[name] = (x, y)
            self.is_hub[name] = bool(hub)
            self.conn[name] = [h for h in ch.split(";") if h] if ch else []
        self.hub_links = [(a, b) for a, b in con.execute("select hub_a, hub_b from hub_links")]
        con.close()
        self.cities = sorted(self.coord)
        self.hubs = sorted(c for c in self.cities if self.is_hub[c])
        self.adj = {c: set() for c in self.cities}
        for a, b in self.hub_links:
            self.adj[a].add(b); self.adj[b].add(a)
        for c in self.cities:
            for h in self.conn[c]:
                self.adj[c].add(h); self.adj[h].add(c)
        self.by_norm = {}
        for c in self.cities:
            self.by_norm.setdefault(norm(c), []).append(c)

    def served(self, c):
        return self.is_hub[c] or len(self.conn[c]) > 0

    def d(self, a, b):
        (x1, y1), (x2, y2) = self.coord[a], self.coord[b]
        return math.hypot(x1 - x2, y1 - y2)

    # -------------------------------------------------------- routing
    def _may_pass(self, node, dst):
        return node == dst or self.is_hub[node]

    def dist_to(self, dst):
        """Dijkstra from dst over nodes allowed as intermediates (hubs) -> lower bounds."""
        best = {dst: 0.0}
        pq = [(0.0, dst)]
        while pq:
            du, u = heapq.heappop(pq)
            if du > best[u]:
                continue
            if u != dst and not self.is_hub[u]:
                continue  # non-hub reached: it can only be an endpoint, do not expand
            for v in self.adj[u]:
                nd = du + self.d(u, v)
                if nd < best.get(v, math.inf):
                    best[v] = nd
                    heapq.heappush(pq, (nd, v))
        return best

    def all_optimal_paths(self, src, dst):
        """Every simple path src->dst (intermediates hubs) with total <= best + EPS."""
        h = self.dist_to(dst)
        if src not in h:
            return math.inf, []
        best = h[src]
        out = []

        def dfs(u, acc, path, seen):
            if u == dst:
                out.append((acc, list(path)))
                return
            for v in self.adj[u]:
                if v in seen or v not in h:
                    continue
                if v != dst and not self.is_hub[v]:
                    continue
                nacc = acc + self.d(u, v)
                if nacc + h[v] <= best + EPS:
                    seen.add(v); path.append(v)
                    dfs(v, nacc, path, seen)
                    path.pop(); seen.discard(v)

        dfs(src, 0.0, [src], {src})
        return best, out

    def route(self, src, dst):
        if src == dst:
            return {"error": "SAME_CITY"}
        for c in (src, dst):
            if c not in self.coord:
                return {"error": "CITY_NOT_FOUND", "city": c}
        for c in (src, dst):
            if not self.served(c):
                return {"error": "CITY_NOT_SERVED", "city": c, "nearestServed": self.nearest_served(c)}
        best, paths = self.all_optimal_paths(src, dst)
        if not paths:
            return {"error": "NO_ROUTE"}
        # recompute exact sums along each path in path order (summation order matters for float)
        cands = []
        for _, p in paths:
            legs = [self.d(p[i], p[i + 1]) for i in range(len(p) - 1)]
            tot = 0.0
            for x in legs:
                tot += x
            cands.append((tot, p, legs))
        mind = min(c[0] for c in cands)
        tied = [c for c in cands if abs(c[0] - mind) < EPS]
        tied.sort(key=lambda c: (len(c[1]) - 1, [list(map(ord, s)) for s in c[1]]))
        tot, p, legs = tied[0]
        cents = round_half_up(tot * 13)
        return {
            "from": src, "to": dst,
            "path": p,
            "legs": [{"from": p[i], "to": p[i + 1], "distanceKm": legs[i]} for i in range(len(legs))],
            "transferCities": p[1:-1],
            "totalDistanceKm": tot,
            "priceCents": cents,
            "display": {
                "legs": [fmt2(x) for x in legs],
                "totalDistanceKm": fmt2(tot),
                "priceUsd": f"{cents // 100}.{cents % 100:02d}",
            },
            "tieCount": len(tied),
            "tiedAlternatives": [c[1] for c in tied[1:]],
        }

    def nearest_served(self, c, k=1):
        cand = [(self.d(c, o), norm(o), o) for o in self.cities if o != c and self.served(o)]
        cand.sort(key=lambda t: (t[0], t[1]))
        res = [{"city": o, "distanceKm": fmt2(dd), "raw": dd} for dd, _, o in cand[:k]]
        return res[0] if k == 1 else res


def round_half_up(x: float) -> int:
    return int(Decimal(repr(x)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def fmt2(x: float) -> str:
    return str(Decimal(repr(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


# ---------------------------------------------------------------- resolve_city (A-02 §7.1)
def dl_distance(a: str, b: str) -> int:
    """Unrestricted Damerau-Levenshtein (true DL, allows edits between transposed chars)."""
    INF = len(a) + len(b)
    da = {}
    d = [[0] * (len(b) + 2) for _ in range(len(a) + 2)]
    d[0][0] = INF
    for i in range(len(a) + 1):
        d[i + 1][0] = INF; d[i + 1][1] = i
    for j in range(len(b) + 1):
        d[0][j + 1] = INF; d[1][j + 1] = j
    for i in range(1, len(a) + 1):
        db = 0
        for j in range(1, len(b) + 1):
            i1 = da.get(b[j - 1], 0); j1 = db
            cost = 0 if a[i - 1] == b[j - 1] else 1
            if cost == 0:
                db = j
            d[i + 1][j + 1] = min(d[i][j] + cost, d[i + 1][j] + 1, d[i][j + 1] + 1,
                                  d[i1][j1] + (i - i1 - 1) + 1 + (j - j1 - 1))
        da[a[i - 1]] = i
    return d[len(a) + 1][len(b) + 1]


def osa_distance(a: str, b: str) -> int:
    """Optimal string alignment (restricted DL) - used to flag cases where variants disagree."""
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1): d[i][0] = i
    for j in range(len(b) + 1): d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[len(a)][len(b)]


def fuzzy_score(q: str, name_norm: str, dist=dl_distance):
    if not q:
        return None
    if name_norm.startswith(q) or q.startswith(name_norm):
        return 0.92
    if q in name_norm or name_norm in q:
        return 0.88
    m = max(len(q), len(name_norm))
    dd = dist(q, name_norm)
    if dd <= max(1, m // 4):
        return 1 - dd / m
    return None


def resolve(world: World, original: str, candidates, dist=dl_distance):
    items = [("candidate", i, c) for i, c in enumerate(candidates)] + [("original", None, original)]
    for src, idx, s in items:
        hits = world.by_norm.get(norm(s), [])
        if hits:
            mb = {"source": src}
            if idx is not None:
                mb["index"] = idx
            return {"status": "exact" if len(hits) == 1 else "ambiguous",
                    "matches": sorted(hits), "matchedBy": mb}
    best = {}  # city -> (score, candIdx)
    for i, c in enumerate(candidates):
        q = norm(c)
        for city in world.cities:
            sc = fuzzy_score(q, norm(city), dist)
            if sc is None:
                continue
            if city not in best or sc > best[city][0] or (sc == best[city][0] and i < best[city][1]):
                best[city] = (sc, i)
    ranked = sorted(((sc, i, norm(city), city) for city, (sc, i) in best.items() if sc >= 0.6),
                    key=lambda t: (-t[0], t[1], t[2]))[:5]
    if ranked:
        return {"status": "suggest", "matches": [{"city": t[3], "score": round(t[0], 4)} for t in ranked],
                "matchedBy": {"source": "fuzzy"}}
    return {"status": "not_found", "matches": []}
