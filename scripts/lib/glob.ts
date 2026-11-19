// Minimal, dependency-free glob matcher for repo-relative POSIX paths.
//   **  any number of path segments (including none)
//   *   any characters except '/'
//   ?   one character except '/'
// A pattern ending in '/' matches everything below that directory.

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === '*') {
      if (p[i + 1] === '*') {
        // '**/' → zero or more segments; trailing '**' → anything
        if (p[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const out = new RegExp(`^${re}$`);
  cache.set(pattern, out);
  return out;
}

export function matches(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matches(path, p));
}

/** Literal leading part of a pattern, up to (not including) the first wildcard character. */
export function literalPrefix(pattern: string): string {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const idx = p.search(/[*?]/);
  return idx === -1 ? p : p.slice(0, idx);
}

/**
 * Conservative test: can `pattern` match some path inside directory `dir` (e.g. 'apps/web/')?
 * Segment-wise walk: '**' may consume zero or more dir segments; other segments must glob-match the dir
 * segment. Once every dir segment is consumed the pattern can still match something below it.
 */
export function canMatchUnder(pattern: string, dir: string): boolean {
  const p = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '/**');
  const ps = p.split('/').filter((x) => x.length > 0);
  const ds = dir.split('/').filter((x) => x.length > 0);
  const walk = (i: number, j: number): boolean => {
    if (j === ds.length) return i < ps.length;
    if (i === ps.length) return false;
    const seg = ps[i] as string;
    if (seg === '**') return walk(i + 1, j) || walk(i, j + 1);
    return globToRegExp(seg).test(ds[j] as string) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}
