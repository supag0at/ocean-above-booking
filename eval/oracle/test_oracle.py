"""Self-tests for oracle.py.  Run: python -I -m unittest test_oracle -v  (from eval/oracle)."""
import math
import os
import random
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import oracle  # noqa: E402

NO_SERVICE = ['Abu Dhabi', 'Austin', 'Columbus', 'Fort Lauderdale', 'Iquitos',
              'Los Cabos', 'Pokhara', 'Savannah', 'Srinagar', 'Stuttgart']


def raw_tables():
    con = sqlite3.connect("file:" + oracle.DB_PATH.replace("\\", "/") + "?mode=ro", uri=True)
    loc = {r[0]: r for r in con.execute("SELECT * FROM locations")}
    links = list(con.execute("SELECT hub_a, hub_b FROM hub_links"))
    con.close()
    return loc, links


LOC, LINKS = raw_tables()


def xy(c):
    a, b = LOC[c][1].split(",")
    return float(a), float(b)


def dd(a, b):
    (x1, y1), (x2, y2) = xy(a), xy(b)
    return math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2)


class OracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = oracle.load()

    def test_hub_to_hub_direct(self):
        r = oracle.cmd_route(self.data, "Addis Ababa", "Dubai")
        self.assertTrue(r["ok"])
        self.assertEqual(r["path"], ["Addis Ababa", "Dubai"])
        self.assertEqual(r["transferCities"], [])
        self.assertAlmostEqual(r["totalDistanceKm"], dd("Addis Ababa", "Dubai"), places=9)
        self.assertEqual(r["priceCents"], math.floor(dd("Addis Ababa", "Dubai") * 13 + 0.5))

    def test_spoke_to_hub_direct(self):
        r = oracle.cmd_route(self.data, "Aarhus", "Santiago")
        self.assertEqual(r["path"], ["Aarhus", "Santiago"])

    def test_spoke_two_hubs_spoke(self):
        # Agadir -> Miami -> Nairobi -> Genoa (Miami-Nairobi is a direct hub link,
        # Agadir only flies to Miami, Genoa only to Nairobi: the route is forced)
        self.assertEqual(LOC["Agadir"][3], "Miami")
        self.assertEqual(LOC["Genoa"][3], "Nairobi")
        self.assertTrue(("Miami", "Nairobi") in LINKS or ("Nairobi", "Miami") in LINKS)
        r = oracle.cmd_route(self.data, "Agadir", "Genoa")
        direct = dd("Agadir", "Miami") + dd("Miami", "Nairobi") + dd("Nairobi", "Genoa")
        self.assertLessEqual(r["totalDistanceKm"], direct + 1e-6)
        # Forced end legs; middle can only be <= the direct hub link.
        self.assertEqual(r["path"][:2], ["Agadir", "Miami"])
        self.assertEqual(r["path"][-2:], ["Nairobi", "Genoa"])
        if r["path"] == ["Agadir", "Miami", "Nairobi", "Genoa"]:
            self.assertAlmostEqual(r["totalDistanceKm"], direct, places=9)
        self.assertEqual(r["priceCents"], math.floor(r["totalDistanceKm"] * 13 + 0.5))
        self.assertEqual(len(r["legs"]), len(r["path"]) - 1)
        self.assertAlmostEqual(sum(l["distanceKm"] for l in r["legs"]), r["totalDistanceKm"], places=9)

    def test_spoke_same_hub(self):
        # Two spokes sharing a single hub only: route is via that hub (2 legs) if both single-homed there
        singles = {}
        for c, row in LOC.items():
            if row[2] == 0 and row[3] and ";" not in row[3]:
                singles.setdefault(row[3], []).append(c)
        hub, cs = next((h, c) for h, c in sorted(singles.items()) if len(c) >= 2)
        r = oracle.cmd_route(self.data, cs[0], cs[1])
        self.assertEqual(r["path"], [cs[0], hub, cs[1]])

    def test_no_service_cities(self):
        found = sorted(c for c in self.data.cities if not self.data.serviced(c))
        self.assertEqual(found, NO_SERVICE)
        for c in NO_SERVICE:
            self.assertEqual(LOC[c][3], "")
            self.assertEqual(LOC[c][2], 0)
            r = oracle.cmd_route(self.data, c, "Dubai")
            self.assertEqual(r["error"], "NO_SERVICE")
            n = oracle.cmd_nearest(self.data, c)
            self.assertTrue(self.data.serviced(n["nearest"]))
            best = min(dd(c, o) for o in LOC if o != c and (LOC[o][2] == 1 or LOC[o][3]))
            self.assertAlmostEqual(n["distanceKm"], best, places=9)

    def test_errors(self):
        self.assertEqual(oracle.cmd_route(self.data, "Nowhere", "Dubai")["error"], "UNKNOWN_CITY")
        self.assertEqual(oracle.cmd_route(self.data, "Dubai", "Dubai")["error"], "SAME_CITY")

    def test_symmetry_and_transfers_are_hubs(self):
        rnd = random.Random(7)
        svc = [c for c in self.data.cities if self.data.serviced(c)]
        for _ in range(500):
            a, b = rnd.sample(svc, 2)
            r1 = oracle.cmd_route(self.data, a, b)
            r2 = oracle.cmd_route(self.data, b, a)
            self.assertAlmostEqual(r1["totalDistanceKm"], r2["totalDistanceKm"], delta=1e-6)
            self.assertEqual(r1["priceCents"], r2["priceCents"])
            for t in r1["transferCities"]:
                self.assertEqual(LOC[t][2], 1)
            self.assertEqual(len(set(r1["path"])), len(r1["path"]))

    def test_dump_matches_route(self):
        rnd = random.Random(11)
        svc = [c for c in self.data.cities if self.data.serviced(c)]
        for _ in range(30):
            o = rnd.choice(svc)
            res = self.data.all_from(o)
            self.assertEqual(len(res), len(svc) - 1)
            for d in rnd.sample([c for c in svc if c != o], 20):
                self.assertEqual(res[d], self.data.route(o, d))

    def test_bruteforce_sample(self):
        edges = {c: set() for c in LOC}
        for a, b in LINKS:
            edges[a].add(b)
            edges[b].add(a)
        for c, row in LOC.items():
            if row[2] == 0:
                for h in filter(None, row[3].split(";")):
                    edges[c].add(h)
                    edges[h].add(c)

        def brute(o, d, maxlegs=6):
            best = None
            stack = [(o, (o,), 0.0)]
            while stack:
                cur, path, dist = stack.pop()
                if cur == d:
                    cand = (dist, len(path) - 1, path)
                    if oracle.better(cand, best):
                        best = cand
                    continue
                if len(path) - 1 >= maxlegs:
                    continue
                for nx in edges[cur]:
                    if nx in path:
                        continue
                    # a non-hub may only be an endpoint
                    if LOC[nx][2] == 0 and nx != d:
                        continue
                    stack.append((nx, path + (nx,), dist + dd(cur, nx)))
            return best

        rnd = random.Random(2024)
        svc = [c for c in self.data.cities if self.data.serviced(c)]
        checked = 0
        for _ in range(200):
            a, b = rnd.sample(svc, 2)
            r = oracle.cmd_route(self.data, a, b)
            bf = brute(a, b)
            self.assertIsNotNone(bf, (a, b))
            if len(r["path"]) - 1 <= 6:
                self.assertEqual(tuple(r["path"]), bf[2], (a, b))
                self.assertAlmostEqual(r["totalDistanceKm"], bf[0], delta=1e-6)
                checked += 1
            else:  # oracle needs >6 legs: brute force must not find anything shorter
                self.assertGreaterEqual(bf[0], r["totalDistanceKm"] - 1e-6)
        self.assertGreater(checked, 150)


if __name__ == "__main__":
    unittest.main()
