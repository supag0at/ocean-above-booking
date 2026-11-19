"""Independent reference oracle for the Ocean Above route engine.

Algorithm: Floyd-Warshall over the hub graph (tracking path + leg count for
tie-breaking), then combine "O's reachable hubs x D's reachable hubs".
Standard library only. Run with: python -I oracle.py <cmd> ...
"""
import argparse
import hashlib
import json
import math
import os
import sqlite3
import sys

EXPECTED_SHA256 = "fc4134475ab5d0b0d1e2c2ab081b4a41da59dbdb25ff7ee147b935d33007386f"
EPS = 1e-6
HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.normpath(os.path.join(HERE, "..", "..", "locations.db"))


def die(msg):
    sys.stderr.write(msg + "\n")
    sys.exit(2)


def load(db_path=DB_PATH):
    with open(db_path, "rb") as f:
        h = hashlib.sha256(f.read()).hexdigest()
    if h != EXPECTED_SHA256:
        die("locations.db sha256 mismatch: " + h)
    uri = "file:" + db_path.replace("\\", "/").replace("?", "%3F").replace("#", "%23") + "?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    coords, is_hub, conn = {}, {}, {}
    for name, coord, hub, ch in con.execute(
            "SELECT city_name, coordinate, is_hub, connected_hubs FROM locations"):
        x, y = coord.split(",")
        coords[name] = (float(x), float(y))
        is_hub[name] = bool(hub)
        conn[name] = [s.strip() for s in ch.split(";") if s.strip()] if not hub else []
    links = [(a, b) for a, b in con.execute("SELECT hub_a, hub_b FROM hub_links")]
    con.close()
    return Data(coords, is_hub, conn, links)


def better(a, b):
    """Is candidate a=(dist, legs, seq) strictly better than b under the spec?"""
    if b is None:
        return True
    if a[0] < b[0] - EPS:
        return True
    if a[0] > b[0] + EPS:
        return False
    if a[1] != b[1]:
        return a[1] < b[1]
    return a[2] < b[2]


class Data:
    def __init__(self, coords, is_hub, conn, links):
        self.coords, self.is_hub, self.conn = coords, is_hub, conn
        self.hubs = sorted(c for c in coords if is_hub[c])
        self.cities = sorted(coords)
        self.links = links
        self._floyd()

    def dist(self, a, b):
        ax, ay = self.coords[a]
        bx, by = self.coords[b]
        dx, dy = ax - bx, ay - by
        return math.sqrt(dx * dx + dy * dy)

    def serviced(self, c):
        return self.is_hub[c] or bool(self.conn[c])

    def _floyd(self):
        H = self.hubs
        best = {}  # (i,j) -> (dist, legs, seq tuple)
        for h in H:
            best[(h, h)] = (0.0, 0, (h,))
        for a, b in self.links:
            d = self.dist(a, b)
            for u, v in ((a, b), (b, a)):
                c = (d, 1, (u, v))
                if better(c, best.get((u, v))):
                    best[(u, v)] = c
        for k in H:
            for i in H:
                ik = best.get((i, k))
                if ik is None:
                    continue
                for j in H:
                    kj = best.get((k, j))
                    if kj is None:
                        continue
                    c = (ik[0] + kj[0], ik[1] + kj[1], ik[2] + kj[2][1:])
                    if better(c, best.get((i, j))):
                        best[(i, j)] = c
        self.hubbest = best

    def _access(self, c):
        """Hubs directly reachable from c as first/last leg: (hub, dist)."""
        if self.is_hub[c]:
            return [(c, 0.0)]
        return [(h, self.dist(c, h)) for h in self.conn[c]]

    def _total(self, seq):
        t = 0.0
        for i in range(len(seq) - 1):
            t += self.dist(seq[i], seq[i + 1])
        return t

    def route(self, o, d):
        """Return best seq tuple or None. Both must be serviced and distinct."""
        best = None
        for a, da in self._access(o):
            for b, db in self._access(d):
                hb = self.hubbest.get((a, b))
                if hb is None:
                    continue
                seq = hb[2]
                if not self.is_hub[o]:
                    seq = (o,) + seq
                if not self.is_hub[d]:
                    seq = seq + (d,)
                c = (da + hb[0] + db, len(seq) - 1, seq)
                if better(c, best):
                    best = c
        return best[2] if best else None

    def all_from(self, o):
        """Best route from o to every other serviced city (grouped by last hub)."""
        arr = {}
        for a, da in self._access(o):
            for b in self.hubs:
                hb = self.hubbest.get((a, b))
                if hb is None:
                    continue
                seq = hb[2] if self.is_hub[o] else (o,) + hb[2]
                c = (da + hb[0], len(seq) - 1, seq)
                if better(c, arr.get(b)):
                    arr[b] = c
        out = {}
        for d in self.cities:
            if d == o or not self.serviced(d):
                continue
            if self.is_hub[d]:
                c = arr.get(d)
                if c:
                    out[d] = c[2]
                continue
            best = None
            for b in self.conn[d]:
                x = arr.get(b)
                if x is None:
                    continue
                seq = x[2] + (d,)
                c = (x[0] + self.dist(b, d), len(seq) - 1, seq)
                if better(c, best):
                    best = c
            if best:
                out[d] = best[2]
        return out

    def nearest(self, c):
        best = None
        for o in self.cities:
            if o == c or not self.serviced(o):
                continue
            k = (self.dist(c, o), o)
            if best is None or k < best:
                best = k
        return best[1], best[0]

    def resolve(self, name):
        if name in self.coords:
            return name
        m = [c for c in self.cities if c.casefold() == name.strip().casefold()]
        return m[0] if len(m) == 1 else None


def price_cents(total):
    return int(math.floor(total * 13 + 0.5))  # round half up


def describe(data, seq):
    legs = [{"from": seq[i], "to": seq[i + 1], "distanceKm": data.dist(seq[i], seq[i + 1])}
            for i in range(len(seq) - 1)]
    total = data._total(seq)
    return {
        "ok": True,
        "legs": legs,
        "transferCities": list(seq[1:-1]),
        "path": list(seq),
        "totalDistanceKm": total,
        "totalDistanceKm2dp": round(total, 2),
        "priceCents": price_cents(total),
    }


def cmd_route(data, a, b):
    o, d = data.resolve(a), data.resolve(b)
    if o is None or d is None:
        return {"ok": False, "error": "UNKNOWN_CITY",
                "unknown": [x for x, r in ((a, o), (b, d)) if r is None]}
    if o == d:
        return {"ok": False, "error": "SAME_CITY"}
    ns = [c for c in (o, d) if not data.serviced(c)]
    if ns:
        return {"ok": False, "error": "NO_SERVICE", "cities": ns}
    seq = data.route(o, d)
    if seq is None:
        return {"ok": False, "error": "NO_ROUTE"}
    return describe(data, seq)


def cmd_nearest(data, c):
    r = data.resolve(c)
    if r is None:
        return {"ok": False, "error": "UNKNOWN_CITY"}
    n, dist = data.nearest(r)
    return {"ok": True, "city": r, "serviced": data.serviced(r), "nearest": n, "distanceKm": dist}


def cmd_dump(data, out):
    n = 0
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        for o in data.cities:
            if not data.serviced(o):
                continue
            res = data.all_from(o)
            for d in data.cities:
                seq = res.get(d)
                if seq is None:
                    continue
                total = data._total(seq)
                f.write(json.dumps({"from": o, "to": d, "totalDistanceKm": total,
                                    "priceCents": price_cents(total), "path": list(seq)},
                                   ensure_ascii=False) + "\n")
                n += 1
    return n


def main():
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to GBK; city names contain non-ASCII
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest="cmd", required=True)
    r = sp.add_parser("route")
    r.add_argument("frm")
    r.add_argument("to")
    nn = sp.add_parser("nearest")
    nn.add_argument("city")
    dp = sp.add_parser("dump")
    dp.add_argument("--out", required=True)
    a = p.parse_args()
    data = load()
    if a.cmd == "route":
        print(json.dumps(cmd_route(data, a.frm, a.to), ensure_ascii=False, indent=2))
    elif a.cmd == "nearest":
        print(json.dumps(cmd_nearest(data, a.city), ensure_ascii=False, indent=2))
    else:
        print(cmd_dump(data, a.out))


if __name__ == "__main__":
    main()
