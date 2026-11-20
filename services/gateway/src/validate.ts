// Minimal JSON-Schema checker for the TypeBox schemas exported by @fb/contracts.
// Why not typebox/value or ajv: gateway may only depend on contracts, platform and bullmq (A-01 §1.2, depcruise
// `gateway-allowed`). TypeBox schemas are plain JSON Schema objects, so the subset they use is interpreted here.
// Used where a schema failure must map to a specific error code (emitEvent -> 400 EVENT_INVALID, A-01 §5.1) or
// where there is no HTTP request at all (ephemeral events from Redis, A-01 §4.4; booking responses).
// Unknown keywords make the check FAIL (fail closed), so a contract change that needs a new keyword is noticed.

type Schema = Record<string, unknown>;

const KNOWN = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'anyOf',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'items',
  // annotations
  'description',
  'title',
  '$id',
]);

const patternCache = new Map<string, RegExp>();
function re(p: string): RegExp {
  let r = patternCache.get(p);
  if (!r) {
    // JSON Schema `pattern` is ECMA-262 with the `u` flag
    r = new RegExp(p, 'u');
    patternCache.set(p, r);
  }
  return r;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function typeOk(type: unknown, v: unknown): boolean {
  switch (type) {
    case undefined:
      return true;
    case 'object':
      return isPlainObject(v);
    case 'array':
      return Array.isArray(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'null':
      return v === null;
    default:
      return false; // unsupported type keyword: fail closed
  }
}

/** True when `value` satisfies `schema`. */
export function check(schema: unknown, value: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  const s = schema as Schema;
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) return false;

  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || !s.anyOf.some((sub) => check(sub, value))) return false;
  }
  if (!typeOk(s.type, value)) return false;
  if (s.const !== undefined && value !== s.const) return false;

  if (typeof value === 'string') {
    // lengths in code points, as JSON Schema defines them
    const len = s.minLength !== undefined || s.maxLength !== undefined ? [...value].length : 0;
    if (typeof s.minLength === 'number' && len < s.minLength) return false;
    if (typeof s.maxLength === 'number' && len > s.maxLength) return false;
    if (typeof s.pattern === 'string' && !re(s.pattern).test(value)) return false;
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return false;
    if (typeof s.maximum === 'number' && value > s.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return false;
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return false;
    if (s.items !== undefined && !value.every((item) => check(s.items, item))) return false;
  }
  if (isPlainObject(value)) {
    const props = isPlainObject(s.properties) ? s.properties : {};
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const r of required) if (!Object.hasOwn(value, r)) return false;
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) {
        if (!check(props[k], v)) return false;
      } else if (s.additionalProperties === false) {
        return false;
      } else if (isPlainObject(s.additionalProperties) && !check(s.additionalProperties, v)) {
        return false;
      }
    }
  }
  return true;
}
