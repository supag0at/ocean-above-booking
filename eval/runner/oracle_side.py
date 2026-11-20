"""Independent oracle views for T13b. Does not modify eval/oracle.

Subcommands:
  dump <tsv>          one line per ordered served pair
  nearest <json-out>  nearest and second-nearest for every city
  route               stdin {"from","to"} -> describe JSON on stdout
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ORACLE_PATH = os.path.normpath(os.path.join(HERE, "..", "oracle", "oracle.py"))


def load_oracle():
    spec = importlib.util.spec_from_file_location("fb_oracle", ORACLE_PATH)
    if spec is None or spec.loader is None:
        sys.stderr.write("cannot load oracle\n")
        sys.exit(2)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1]
    ora = load_oracle()
    data = ora.load()
    if cmd == "dump":
        out = sys.argv[2]
        n = 0
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            for origin in data.cities:
                if not data.serviced(origin):
                    continue
                routes = data.all_from(origin)
                for dest, seq in routes.items():
                    total = data._total(seq)
                    f.write(
                        f"{origin}\t{dest}\t{total:.17g}\t{ora.price_cents(total)}\t{'|'.join(seq)}\n"
                    )
                    n += 1
        sys.stderr.write(f"dump {n}\n")
        return
    if cmd == "nearest":
        out = sys.argv[2]
        rows = {}
        for city in data.cities:
            ranked = []
            for other in data.cities:
                if other == city or not data.serviced(other):
                    continue
                ranked.append((data.dist(city, other), other))
            ranked.sort()
            first = ranked[0]
            second = ranked[1]
            rows[city] = {
                "serviced": data.serviced(city),
                "nearest": first[1],
                "rawDistanceKm": first[0],
                "second": second[1],
                "secondRawDistanceKm": second[0],
            }
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            json.dump(rows, f, ensure_ascii=False)
        return
    if cmd == "route":
        req = json.load(sys.stdin)
        print(json.dumps(ora.cmd_route(data, req["from"], req["to"]), ensure_ascii=False))
        return
    sys.stderr.write("unknown command\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
