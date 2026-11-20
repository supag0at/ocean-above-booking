"""Static checks for eval/cases (no LLM, no services).

    PYTHONIOENCODING=utf-8 python eval/cases/validate_cases.py

Checks: YAML parses; ids unique; required fields; category counts (>=4 each, 60..100 agent
cases); every assertion key is in the README vocabulary; all 10 unserved cities covered;
every (from,to) in quote_matches_oracle has a deterministic route case; >=30 deterministic cases.
"""
import glob
import os
import sys
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
CATEGORIES = ["route", "no_service", "resolve", "confirm_flow", "numbers", "redteam", "tickets",
              "history", "memory", "bilingual", "failure"]
ASSERTIONS = {
    "tool_called", "tool_order", "tool_result", "tool_result_excludes", "resolve_candidates_valid",
    "event_present", "event_absent", "event_count", "event_order", "no_run_between",
    "quote_matches_oracle", "quote_data", "quote_from_set", "quote_offered_not", "distinct_quote_ids_per_tool_call",
    "unserved_handled", "guard_violation", "no_guard_violation", "final_reply", "run_lang",
    "run_started_profile", "saved_values_canonical", "user_message_escaped", "no_prompt_leak",
    "tickets_unchanged", "template_message", "no_dangling_tool_calls", "no_duplicate_message_keys",
    "hands_attempts_per_call", "report", "e2e",
}
SCOPES = {"turn", "session"}
TURN_KINDS = {"user", "new_session", "simulate_click", "ui_delete_memory"}
UNSERVED = {"Abu Dhabi", "Stuttgart", "Austin", "Srinagar", "Pokhara", "Columbus", "Savannah",
            "Fort Lauderdale", "Los Cabos", "Iquitos"}

errors = []
ids = set()
counts = {}
oracle_pairs = set()
unserved_seen = set()

for path in sorted(glob.glob(os.path.join(HERE, "agent", "*.yaml"))):
    doc = yaml.safe_load(open(path, encoding="utf-8"))
    cat = doc["category"]
    if cat not in CATEGORIES:
        errors.append(f"{path}: unknown category {cat}")
    for c in doc["cases"]:
        cid = c.get("id")
        if cid in ids:
            errors.append(f"duplicate id {cid}")
        ids.add(cid)
        for f in ("id", "lang", "setup", "turns", "expect"):
            if f not in c:
                errors.append(f"{cid}: missing {f}")
        if c.get("lang") not in ("zh", "en", "mixed"):
            errors.append(f"{cid}: bad lang")
        for t in c.get("turns", []):
            if len(t) != 1 or next(iter(t)) not in TURN_KINDS:
                errors.append(f"{cid}: bad turn {t}")
        for a in c.get("expect", []):
            keys = set(a) - SCOPES
            if len(keys) != 1 or not keys <= ASSERTIONS:
                errors.append(f"{cid}: bad assertion {a}")
                continue
            k = next(iter(keys))
            if k == "quote_matches_oracle":
                oracle_pairs.add((a[k]["from"], a[k]["to"]))
            if k == "unserved_handled":
                unserved_seen.add(a[k]["city"])
        counts[cat] = counts.get(cat, 0) + 1

det_ids, det_pairs, det_total = set(), set(), 0
for path in sorted(glob.glob(os.path.join(HERE, "deterministic", "*.yaml"))):
    doc = yaml.safe_load(open(path, encoding="utf-8"))
    for c in doc["cases"]:
        det_total += 1
        if c["id"] in det_ids:
            errors.append(f"duplicate det id {c['id']}")
        det_ids.add(c["id"])
        if c.get("fn") == "quote":
            det_pairs.add((c["input"]["from"], c["input"]["to"]))

for cat in CATEGORIES:
    if counts.get(cat, 0) < 4:
        errors.append(f"category {cat} has {counts.get(cat, 0)} < 4 cases")
agent_total = sum(counts.values())
if not 60 <= agent_total <= 100:
    errors.append(f"agent total {agent_total} not in 60..100")
if unserved_seen & UNSERVED != UNSERVED:
    errors.append(f"no_service missing {sorted(UNSERVED - unserved_seen)}")
missing = sorted(oracle_pairs - det_pairs)
if missing:
    errors.append(f"oracle pairs without deterministic route case: {missing}")
if det_total < 30:
    errors.append(f"deterministic total {det_total} < 30")

print("agent cases per category:", {k: counts.get(k, 0) for k in CATEGORIES}, "total", agent_total)
print("deterministic cases:", det_total)
if errors:
    print("ERRORS:\n  " + "\n  ".join(errors))
    sys.exit(1)
print("OK")
