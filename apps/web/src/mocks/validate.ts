// Minimal JSON-Schema checker for the TypeBox schemas exported by @fb/contracts/web (they are plain JSON Schema).
// apps/web has no direct `typebox` dependency (dependencies are frozen), so mock data is validated with this
// small checker instead of `typebox/value`. It covers exactly the keywords the web contract uses:
// type, properties, required, additionalProperties:false, anyOf, const, items, pattern, minimum, minLength, maxLength.
type Schema = Record<string, unknown>;

export function schemaErrors(schema: unknown, value: unknown, path = '$'): string[] {
  const s = schema as Schema;
  if (s === null || typeof s !== 'object') return [];
  if (Array.isArray(s['anyOf'])) {
    const branches = s['anyOf'] as unknown[];
    const attempts = branches.map((b) => schemaErrors(b, value, path));
    return attempts.some((a) => a.length === 0)
      ? []
      : [`${path}: matches none of ${branches.length} union branches (${attempts[0]?.[0] ?? ''})`];
  }
  if ('const' in s)
    return value === s['const']
      ? []
      : [`${path}: expected const ${JSON.stringify(s['const'])}, got ${JSON.stringify(value)}`];
  const errs: string[] = [];
  const type = s['type'];
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${path}: expected object`];
    const obj = value as Record<string, unknown>;
    const props = (s['properties'] ?? {}) as Record<string, unknown>;
    for (const req of (s['required'] ?? []) as string[]) if (!(req in obj)) errs.push(`${path}.${req}: missing`);
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) errs.push(...schemaErrors(props[k], v, `${path}.${k}`));
      else if (s['additionalProperties'] === false) errs.push(`${path}.${k}: additional property not allowed`);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    value.forEach((v, i) => errs.push(...schemaErrors(s['items'], v, `${path}[${i}]`)));
  } else if (type === 'string') {
    if (typeof value !== 'string') return [`${path}: expected string`];
    if (typeof s['minLength'] === 'number' && value.length < s['minLength']) errs.push(`${path}: too short`);
    if (typeof s['maxLength'] === 'number' && value.length > s['maxLength']) errs.push(`${path}: too long`);
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern']).test(value))
      errs.push(`${path}: pattern mismatch`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path}: expected number`];
    if (type === 'integer' && !Number.isInteger(value)) errs.push(`${path}: expected integer`);
    if (typeof s['minimum'] === 'number' && value < s['minimum']) errs.push(`${path}: below minimum`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return [`${path}: expected boolean`];
  } else if (type === 'null') {
    if (value !== null) return [`${path}: expected null`];
  }
  return errs;
}

/** Throws when `value` does not satisfy `schema`. */
export function assertSchema<T>(schema: unknown, value: T, label = 'value'): T {
  const errs = schemaErrors(schema, value);
  if (errs.length) throw new Error(`mock ${label} violates the contract schema:\n  ${errs.slice(0, 5).join('\n  ')}`);
  return value;
}

export function matchesSchema(schema: unknown, value: unknown): boolean {
  return schemaErrors(schema, value).length === 0;
}
