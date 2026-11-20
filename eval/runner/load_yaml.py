"""Load eval YAML (anchors included) and print JSON. Stdlib + PyYAML only."""
import json
import sys
from pathlib import Path

import yaml


def main() -> None:
    root = Path(sys.argv[1])
    files = sorted(p for p in root.glob("*.yaml"))
    out = []
    for path in files:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        out.append({"file": path.name, "doc": data})
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
