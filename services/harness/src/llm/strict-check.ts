// Strict, NON-coercing check of the model's raw tool arguments (A-02 §6.3, CT-08, D-24).
//
// The spec asks for TypeBox `Value.Check`, but typebox is not a harness dependency and the depcruise rule
// `harness-allowed` forbids importing it (T09 report Q1). Until that is decided this validates the JSON-Schema
// subset the contract tool schemas use (object/required/additionalProperties:false, string min/maxLength,
// integer/number minimum/maximum, array items/minItems/maxItems, const, anyOf), with no type conversion at all.
// The contract test in test/strict-check.test.ts runs it against every tool schema.

type Schema = Record<string, unknown>;

export function rawArgsErrors(schema: unknown, value: unknown, path = ''): string[] {
  const s = schema as Schema;
  const errs: string[] = [];
  const at = path === '' ? '/' : path;

  if (Array.isArray(s.anyOf)) {
    const branches = (s.anyOf as unknown[]).map((b) => rawArgsErrors(b, value, path));
    if (branches.some((b) => b.length === 0)) return [];
    // report the branch with the fewest errors (most likely intended)
    const best = branches.sort((a, b) => a.length - b.length)[0] ?? [];
    return best.length > 0 ? best : [`${at}: does not match any allowed shape`];
  }
  if ('const' in s && value !== s.const) errs.push(`${at}: must be ${JSON.stringify(s.const)}`);

  switch (s.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${at}: must be an object`];
      const v = value as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, unknown>;
      for (const k of (s.required ?? []) as string[]) if (!(k in v)) errs.push(`${path}/${k}: is required`);
      for (const [k, x] of Object.entries(v)) {
        if (k in props) errs.push(...rawArgsErrors(props[k], x, `${path}/${k}`));
        else if (s.additionalProperties === false) errs.push(`${path}/${k}: unknown field`);
      }
      break;
    }
    case 'string': {
      if (typeof value !== 'string') return [`${at}: must be a string`];
      const len = [...value].length;
      if (typeof s.minLength === 'number' && len < s.minLength) errs.push(`${at}: shorter than ${s.minLength}`);
      if (typeof s.maxLength === 'number' && len > s.maxLength) errs.push(`${at}: longer than ${s.maxLength}`);
      if (Array.isArray(s.enum) && !s.enum.includes(value)) errs.push(`${at}: not an allowed value`);
      break;
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${at}: must be a ${String(s.type)}`];
      if (s.type === 'integer' && !Number.isInteger(value)) return [`${at}: must be an integer`];
      if (typeof s.minimum === 'number' && value < s.minimum) errs.push(`${at}: must be >= ${s.minimum}`);
      if (typeof s.maximum === 'number' && value > s.maximum) errs.push(`${at}: must be <= ${s.maximum}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') return [`${at}: must be a boolean`];
      break;
    case 'array': {
      if (!Array.isArray(value)) return [`${at}: must be an array`];
      if (typeof s.minItems === 'number' && value.length < s.minItems) errs.push(`${at}: fewer than ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && value.length > s.maxItems) errs.push(`${at}: more than ${s.maxItems} items`);
      if (s.items !== undefined) value.forEach((x, i) => errs.push(...rawArgsErrors(s.items, x, `${path}/${i}`)));
      break;
    }
    case 'null':
      if (value !== null) return [`${at}: must be null`];
      break;
    case undefined:
      break;
    default:
      errs.push(`${at}: unsupported schema type ${String(s.type)}`);
  }
  return errs;
}
