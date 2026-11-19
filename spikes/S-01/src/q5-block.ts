// Q5: beforeToolCall block — event order and what the model actually receives.
import { Agent } from "@earendil-works/pi-agent-core";
import { setup, getWeather, log, summarize } from "./lib.ts";
const { model, streamFn, payloads } = setup("q5");
const order: string[] = [];
let executed = false;
const tool = { ...getWeather, execute: async (...a: any[]) => { executed = true; return (getWeather.execute as any)(...a); } };
const agent = new Agent({
  initialState: { systemPrompt: "You are terse. Use tools for weather.", model, tools: [tool] },
  streamFn,
  beforeToolCall: async ({ toolCall, args }: any) => {
    order.push(`hook:beforeToolCall(${toolCall.id}, args=${JSON.stringify(args)})`);
    return { block: true, reason: "POLICY_BLOCK: weather lookups are disabled for this session." };
  },
  afterToolCall: async ({ toolCall, isError }: any) => { order.push(`hook:afterToolCall(${toolCall.id}, isError=${isError})`); return undefined; },
});
agent.subscribe((e: any) => {
  if (e.type.startsWith("tool_execution")) order.push(`event:${e.type}(${e.toolCallId}${e.type === "tool_execution_end" ? ", isError=" + e.isError : ""})`);
  if (e.type === "message_end" && e.message.role === "toolResult") order.push(`event:message_end(toolResult isError=${e.message.isError})`);
});
await agent.prompt("What's the weather in Oslo?");
log("q5.order", order);
log("q5.toolExecuteCalled", executed);
log("q5.transcriptTail", summarize(agent.state.messages).slice(-3));
log("q5.sentToModel(tool msg in request #2)", (payloads[1] as any)?.messages.filter((m: any) => m.role === "tool"));
