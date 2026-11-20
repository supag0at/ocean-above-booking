// Source-level guards for A-01 §9.4: no dangerouslySetInnerHTML anywhere, no raw-HTML markdown plugin.
import { describe, expect, it } from 'vitest';

const sources = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', eager: true, import: 'default' }) as Record<
  string,
  string
>;

describe('XSS guards', () => {
  const files = Object.entries(sources).filter(([p]) => !p.endsWith('.test.ts') && !p.endsWith('.test.tsx'));
  it('scans the app sources', () => expect(files.length).toBeGreaterThan(10));
  it('never uses the React raw-HTML escape hatch', () => {
    const banned = ['dangerously' + 'SetInnerHTML', 'inner' + 'HTML ='];
    for (const [path, src] of files) for (const b of banned) expect(src.includes(b), `${path} uses ${b}`).toBe(false);
  });
  it('never enables raw HTML in markdown', () => {
    for (const [path, src] of files) expect(/rehype-raw|allowDangerousHtml/.test(src), path).toBe(false);
  });
  it('the web app imports only the @fb/contracts/web entry', () => {
    for (const [path, src] of files) expect(/@fb\/contracts\/(?!web\b)/.test(src), path).toBe(false);
  });
});
