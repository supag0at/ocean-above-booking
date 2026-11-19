// Q9 live: TypeBox schema as AgentTool.parameters against DeepSeek; compare sent tool definition with JSON.stringify(TypeBox).
// Also demonstrates a strict re-check of RAW model args in beforeToolCall (pi coercion cannot be disabled).
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { setup, log, summarize } from "./lib.ts";

const RouteParams = Type.Object(
  { from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }), adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })), extra: Type.Optional(Type.Never()) },
  { additionalProperties: false },
);
const { model, streamFn, payloads } = setup("q9-live");
let executedWith: unknown = null;
const tool: any = {
  name: "find_route", label: "Route", description: "Find a flight route between two cities (fake).", parameters: RouteParams,
  execute: async (_id: string, args: unknown) => { executedWith = args; return { content: [{ type: "text", text: "route: direct, 2h" }], details: {} }; },
};
const agent = new Agent({
  initialState: { systemPrompt: "Use find_route once, then answer in one line.", model, tools: [tool] },
  streamFn,
  beforeToolCall: async ({ toolCall, args }: any) => {
    const rawOk = Value.Check(RouteParams, toolCall.arguments);
    log("q9-live.beforeToolCall", { raw: toolCall.arguments, coerced: args, rawStrictCheck: rawOk });
    if (!rawOk) return { block: true, reason: "ERROR: arguments do not match schema exactly: " + [...Value.Errors(RouteParams, toolCall.arguments)].map((e: any) => `${e.instancePath} ${e.message}`).join("; ") };
  },
});
await agent.prompt("Route from Rome to Oslo for 2 adults?");
const sent = (payloads[0] as any).tools[0].function;
log("q9-live.sentParameters", sent.parameters);
log("q9-live.sentEqualsTypeBoxJSON", JSON.stringify(sent.parameters) === JSON.stringify(RouteParams));
log("q9-live.sentStrictFlag", sent.strict);
log("q9-live.executedWith", executedWith);
log("q9-live.transcript", summarize(agent.state.messages).slice(2));
log("q9-live.requests", payloads.length);
