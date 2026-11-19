// Q4 recovery in a new process from the crashed event log.
//   prompt      -> restore as-is (orphan toolCall), send a new user message
//   continue    -> restore as-is, call agent.continue() (assistant tail with orphan toolCall)
//   interrupted -> harness appends a synthetic `interrupted` toolResult, then continue()
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { setup, slowTool, OUT, log, summarize, checkPairing } from "./lib.ts";

const mode = process.argv[2];
const events = readFileSync(resolve(OUT, "q4-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const messages: any[] = events.filter((e) => e.kind === "message").map((e) => e.message);
const started = events.filter((e) => e.kind === "tool_execution_start").map((e) => e.toolCallId);
const ended = new Set(events.filter((e) => e.kind === "tool_execution_end").map((e) => e.toolCallId));
const system = { role: "system", content: "You are terse. When asked to run the job, call slow_tool with seconds=30.", timestamp: 0 };
const restored = [system, ...messages];
log(`q4b-${mode}.restoredPairing`, checkPairing(restored));

if (mode === "interrupted") {
  const asst = messages.findLast((m) => m.role === "assistant");
  for (const c of asst.content.filter((c: any) => c.type === "toolCall")) {
    if (ended.has(c.id)) continue;
    restored.push({
      role: "toolResult", toolCallId: c.id, toolName: c.name, isError: true, timestamp: Date.now(),
      content: [{ type: "text", text: `interrupted: the worker crashed while ${c.name} was running (started=${started.includes(c.id)}). Outcome unknown; it was NOT confirmed. Ask the user before retrying.` }],
    });
  }
}
const { model, streamFn, payloads } = setup(`q4b-${mode}`);
let ranTool = false;
const tool = { ...slowTool, execute: async () => { ranTool = true; return { content: [{ type: "text" as const, text: "receipt R-9002" }], details: {} }; } };
const agent = new Agent({ initialState: { model, tools: [tool], messages: restored }, streamFn });
try {
  if (mode === "prompt") await agent.prompt("Hello again. What happened with my job, and what was my order reference? Do not call tools.");
  else await agent.continue();
  log(`q4b-${mode}.result`, summarize(agent.state.messages).slice(restored.length));
  log(`q4b-${mode}.errorMessage`, agent.state.errorMessage ?? null);
} catch (err: any) {
  log(`q4b-${mode}.threw`, String(err?.message ?? err));
}
log(`q4b-${mode}.toolReExecuted`, ranTool);
log(`q4b-${mode}.requests`, payloads.length);
if (payloads[0]) log(`q4b-${mode}.sentToolMsgs`, (payloads[0] as any).messages.filter((m: any) => m.role === "tool"));
