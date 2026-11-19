// canonicalJson (A-01 §1.2, §6.1; I-5): recursively sorted keys, no whitespace, arrays keep order.
// Used for every "hash / compare a JSON value" decision. Anything that cannot be represented
// in JSON throws instead of being silently dropped (JSON.stringify would drop undefined/functions).

export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>(), '$');
}

function encode(v: unknown, stack: Set<object>, path: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(v);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
  const obj = v as object;
  if (stack.has(obj)) throw new TypeError(`canonicalJson: circular reference at ${path}`);
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new TypeError(`canonicalJson: sparse array hole at ${path}[${i}]`);
        parts.push(encode(obj[i], stack, `${path}[${i}]`));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`canonicalJson: non-plain object at ${path}`);
    }
    const rec = obj as Record<string, unknown>;
    const keys = Object.keys(rec).sort(); // UTF-16 code unit order: deterministic, locale independent
    const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(rec[k], stack, `${path}.${k}`)}`);
    return `{${parts.join(',')}}`;
  } finally {
    stack.delete(obj);
  }
}
