// Shared spike helpers. Loads ONLY DEEPSEEK_API_KEY from the project .env (never printed).
import { readFileSync, appendFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { obj, str, int } from "@earendil-works/pi-schema";

const here = dirname(fileURLToPath(import.meta.url));
export const OUT = resolve(here, "..", "out");
mkdirSync(OUT, { recursive: true });

export function loadKey(): void {
  if (process.env.DEEPSEEK_API_KEY) return;
  const envPath = resolve(here, "..", "..", "..", ".env");
  const line = readFileSync(envPath, "utf8").split(/\r?\n/).find((l) => l.startsWith("DEEPSEEK_API_KEY="));
  if (!line) throw new Error("DEEPSEEK_API_KEY missing in .env");
  process.env.DEEPSEEK_API_KEY = line.slice("DEEPSEEK_API_KEY=".length).trim().replace(/^"|"$/g, "");
}

/** Redact anything that looks like the key from a string before logging. */
export function redact(s: string): string {
  const k = process.env.DEEPSEEK_API_KEY;
  let out = k ? s.split(k).join("sk-***REDACTED***") : s;
  return out.replace(/sk-[A-Za-z0-9]{16,}/g, "sk-***REDACTED***");
}

export function log(tag: string, obj: unknown): void {
  const line = `[${tag}] ${typeof obj === "string" ? obj : JSON.stringify(obj)}`;
  console.log(redact(line));
}

/** Count every outgoing LLM request (budget: 50 for the whole spike). */
export function countCall(script: string, what: string): void {
  appendFileSync(resolve(OUT, "api-calls.log"), `${new Date().toISOString()} ${script} ${what}\n`);
}

export function setup(script: string) {
  loadKey();
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel("deepseek", "deepseek-flash");
  if (!model) throw new Error("deepseek-flash not in catalog");
  const payloads: unknown[] = [];
  // streamFn wrapper: captures the exact provider payload of every request.
  const streamFn = (m: any, ctx: any, opts: any) =>
    models.streamSimple(m, ctx, {
      ...opts,
      onPayload: (p: unknown) => {
        countCall(script, "chat.completions");
        payloads.push(p);
        writeFileSync(resolve(OUT, `${script}.payload-${payloads.length}.json`), redact(JSON.stringify(p, null, 2)));
        return undefined;
      },
    });
  return { models, model, streamFn, payloads };
}

const weatherParams = obj({ city: str({ description: "City name" }) });
export const getWeather: AgentTool<typeof weatherParams> = {
  name: "get_weather",
  label: "Weather",
  description: "Get the current weather for a city (fake data).",
  parameters: weatherParams,
  execute: async (_id, params) => ({
    content: [{ type: "text", text: JSON.stringify({ city: params.city, tempC: 17, sky: "cloudy", code: "WX-4417" }) }],
    details: { fake: true },
  }),
};

const slowParams = obj({ seconds: int({ description: "How long to work" }) });
export const slowTool: AgentTool<typeof slowParams> = {
  name: "slow_tool",
  label: "Slow",
  description: "Does slow work for N seconds and returns a receipt id.",
  parameters: slowParams,
  execute: async (_id, params, signal) => {
    writeFileSync(resolve(OUT, "slow_tool.started"), String(process.pid));
    await new Promise((r, j) => {
      const t = setTimeout(r, params.seconds * 1000);
      signal?.addEventListener("abort", () => { clearTimeout(t); j(new Error("aborted")); });
    });
    return { content: [{ type: "text", text: "receipt R-9001" }], details: {} };
  },
};

/** Check that every toolCall has exactly one toolResult after it (and no stray results). */
export function checkPairing(messages: any[]): { ok: boolean; calls: string[]; results: string[]; orphans: string[] } {
  const calls: string[] = [], results: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") for (const c of m.content) if (c.type === "toolCall") calls.push(c.id);
    if (m.role === "toolResult") results.push(m.toolCallId);
  }
  const orphans = calls.filter((c) => !results.includes(c));
  const stray = results.filter((r) => !calls.includes(r));
  return { ok: orphans.length === 0 && stray.length === 0 && new Set(results).size === results.length, calls, results, orphans };
}

export function summarize(messages: any[]) {
  return messages.map((m) => {
    if (m.role === "assistant")
      return { role: m.role, stop: m.stopReason, content: m.content.map((c: any) => c.type === "text" ? `text:${c.text.slice(0, 160)}` : c.type === "toolCall" ? `toolCall:${c.name}(${JSON.stringify(c.arguments)})#${c.id}` : c.type) };
    if (m.role === "toolResult") return { role: m.role, id: m.toolCallId, isError: m.isError, text: m.content?.[0]?.text };
    if (m.role === "user") return { role: m.role, text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) };
    return { role: m.role, text: (m.content ?? "").slice?.(0, 80) };
  });
}
