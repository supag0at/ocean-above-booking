// user.message escape (A-02 §11.1, S-2, M-18). Applied by gateway when writing user.message and again by the
// projector (belt and braces). Assistant text is NOT escaped: the tag guard (A-02 §8.6) blocks it instead.
import { ZERO_WIDTH_CHARS_PATTERN } from '../flight/index.ts';

const ZERO_WIDTH = new RegExp(ZERO_WIDTH_CHARS_PATTERN, 'g');
// `<`, optional whitespace, optional `/`, optional whitespace, then the tag name as a whole word, case-insensitive.
const TAG_OPEN = /<(\s*\/?\s*(?:system_event|run_context)\b)/gi;

/**
 * 1. NFKC (folds full-width `＜` and look-alikes to `<`) and strip zero-width characters
 *    (U+200B-U+200F, U+2060, U+FEFF), so `<sys[ZWSP]tem_event` cannot slip through;
 * 2. every `<` that starts `<system_event` or `<run_context` (also closing and spaced forms, any case) becomes `&lt;`.
 * Idempotent. The returned text is the NFKC form of the input, which is what gets stored.
 */
export function escapeUserText(text: string): string {
  const stripped = text.replace(ZERO_WIDTH, '').normalize('NFKC').replace(ZERO_WIDTH, '');
  return stripped.replace(TAG_OPEN, '&lt;$1');
}
