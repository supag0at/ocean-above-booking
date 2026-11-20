// save_preference / forget_preference (A-02 §7.5, §9.2; M-23 ④). Append-only writes to user_memories.
// City values go through the SAME resolver as resolve_city (FlightCore.resolveCity with candidates=[value]);
// only a single exact hit is stored, as the canonical city_name.
import type { CityMatch } from '@fb/contracts/flight';
import type { ForgetPreferenceParamsT, SavePreferenceParamsT } from '@fb/contracts/tools';
import { insertMemory } from '../db.ts';
import type { FlightCore } from '../ports.ts';
import { fail, ok, type ToolHandler } from './types.ts';
import type { ExecuteResponse } from '@fb/contracts/tools';

/** M-23 ④: a value containing any letter outside the Latin script ("上海") is rejected without candidates. */
export function hasNonLatinLetter(s: string): boolean {
  for (const ch of s.normalize('NFKC')) {
    if (/\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch)) return true;
  }
  return false;
}

type CityOutcome = { ok: true; city: string } | { ok: false; response: ExecuteResponse };

export function canonicalCity(fc: FlightCore, value: string): CityOutcome {
  if (hasNonLatinLetter(value)) {
    return {
      ok: false,
      response: fail(
        'INVALID_INPUT',
        `'${value}' is not an English city name. Please pass the English city name (resolve it with resolve_city first).`,
        { candidates: [] },
      ),
    };
  }
  const r = fc.resolveCity({ original: value, candidates: [value] });
  const names = (ms: readonly CityMatch[]) => ms.slice(0, 5).map((m) => m.city);
  const only = r.matches[0];
  if (r.status === 'exact' && r.matches.length === 1 && only) return { ok: true, city: only.city };
  if (r.status === 'ambiguous' || (r.status === 'exact' && r.matches.length > 1)) {
    const c = names(r.matches);
    return {
      ok: false,
      response: fail(
        'CITY_AMBIGUOUS',
        `'${value}' matches ${c.length} cities: ${c.join(', ')}. Ask the user which one.`,
        { candidates: c },
      ),
    };
  }
  const c = names(r.matches);
  const tail = c.length > 0 ? ` Candidates: ${c.join(', ')}.` : '';
  return {
    ok: false,
    response: fail('INVALID_INPUT', `'${value}' is not an exact city name.${tail} Resolve it first or ask the user.`, {
      candidates: c,
    }),
  };
}

export const savePreference: ToolHandler = async (ctx, raw) => {
  const input = raw as SavePreferenceParamsT;
  let value: string;
  if (input.key === 'home_city') {
    const c = canonicalCity(ctx.deps.flightCore, input.value);
    if (!c.ok) return c.response;
    value = c.city;
  } else {
    value = input.value;
  }
  await insertMemory(ctx.db, {
    userId: ctx.userId,
    key: input.key,
    value,
    sourceSessionId: ctx.sessionId,
    sourceSeq: ctx.inputSeq,
  });
  return ok(`Saved: ${input.key} = ${value}.`, { key: input.key, value });
};

export const forgetPreference: ToolHandler = async (ctx, raw) => {
  const { key } = raw as ForgetPreferenceParamsT;
  await insertMemory(ctx.db, {
    userId: ctx.userId,
    key,
    value: null,
    sourceSessionId: ctx.sessionId,
    sourceSeq: ctx.inputSeq,
  });
  return ok(`Forgot: ${key}.`, { key });
};
