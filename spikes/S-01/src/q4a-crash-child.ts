// Q4 child: event-log every message_end to JSONL (stand-in for the append-only session log), then run slow_tool.
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { setup, slowTool, OUT } from "./lib.ts";

const LOG = resolve(OUT, "q4-events.jsonl");
writeFileSync(LOG, "");
const { model, streamFn } = setup("q4a");
const agent = new Agent({
  initialState: { systemPrompt: "You are terse. When asked to run the job, call slow_tool with seconds=30.", model, tools: [slowTool] },
  streamFn,
});
agent.subscribe((e: any) => {
  if (e.type === "message_end") appendFileSync(LOG, JSON.stringify({ kind: "message", message: e.message }) + "\n");
  if (e.type.startsWith("tool_execution")) appendFileSync(LOG, JSON.stringify({ kind: e.type, toolCallId: e.toolCallId }) + "\n");
});
await agent.prompt("Please run the job now. My order reference is ZX-12.");
console.log("child finished normally (should NOT happen)");
