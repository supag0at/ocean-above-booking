# Converts the T13a YAML cases the harness tests use into JSON (the harness has no YAML dependency).
# Run from the repo root: python services/harness/test/fixtures/convert.py
import hashlib, json, yaml
for n in ['guards', 'escape_lang', 'render']:
    src = f'eval/cases/deterministic/{n}.yaml'
    raw = open(src, 'rb').read()
    d = yaml.safe_load(raw.decode('utf8'))
    d['_source'] = {'path': src, 'sha256': hashlib.sha256(raw).hexdigest()}
    with open(f'services/harness/test/fixtures/{n}.json', 'w', encoding='utf8', newline='\n') as f:
        f.write(json.dumps(d, ensure_ascii=False, indent=1) + '\n')
