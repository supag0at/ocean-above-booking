// Strict, NON-coercing check of the model's raw tool arguments (A-02 §6.3, CT-08, D-24).
// CONTRACT M-24 ①: the single implementation is the contract's `checkToolArgs` (TypeBox `Value.Check`, no conversion,
// no stripping); harness has no typebox dependency of its own.
import { checkToolArgs } from '@fb/contracts/tools';

/** Human-readable errors for the LLM (empty = valid). Unknown tool names are an error. */
export function rawArgsErrors(toolName: string, raw: unknown): string[] {
  const r = checkToolArgs(toolName, raw);
  return r.ok ? [] : r.errors.map((e) => `${e.path === '' ? '/' : e.path}: ${e.message}`);
}
