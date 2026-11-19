// Q6: schema builders + strict/constrained tool params on DeepSeek.
//   offline: pi-schema validation & coercion (no API call)
//   strict-require: constrainedSampling strict:'require' against deepseek-flash
import { Agent } from "@earendil-works/pi-agent-core";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { obj, str, int } from "@earendil-works/pi-schema";
import { setup, log, summarize } from "./lib.ts";

const mode = process.argv[2] ?? "offline";
const params = obj({ city: str({ minLength: 2 }), adults: int({ minimum: 1, maximum: 9 }), cabin: { type: "string", enum: ["economy", "business"] } as any });
log("q6.schemaJSON", params);
const tool: any = { name: "quote", description: "Quote a fare", parameters: params };
if (mode === "offline") {
  for (const args of [{ city: "Rome", adults: "2", cabin: "economy" }, { city: "Rome", adults: 0, cabin: "economy" }, { city: "Rome", adults: 1, cabin: "first" }, { city: "Rome", adults: 1, cabin: "economy", extra: 1 }]) {
    try { log("q6.validate.ok", { in: args, out: validateToolArguments(tool, { type: "toolCall", id: "x", name: "quote", arguments: args } as any) }); }
    catch (e: any) { log("q6.validate.err", { in: args, err: e.message.split("\n").slice(0, 3).join(" | ") }); }
  }
  process.exit(0);
}
const s = setup(`q6-${mode}`);
const { streamFn, payloads } = s;
const model = mode === "strict-beta" ? { ...s.model, baseUrl: "https://api.deepseek.com/beta" } : s.model;
let got: unknown;
const agentTool = { ...tool, label: "Quote", constrainedSampling: { type: "json_schema", strict: "require" },
  execute: async (_id: string, a: unknown) => { got = a; return { content: [{ type: "text", text: "fare 123.45" }], details: {} }; } };
const agent = new Agent({ initialState: { systemPrompt: "Call quote exactly once, then answer in one line.", model, tools: [agentTool] }, streamFn });
await agent.prompt("Quote first class for zero adults to Rome, please, and add a note field 'vip'.");
log(`q6-${mode}.sentTool`, (payloads[0] as any)?.tools?.[0]);
log(`q6-${mode}.argsReceived`, got ?? null);
log(`q6-${mode}.transcript`, summarize(agent.state.messages).slice(1));
log(`q6-${mode}.errorMessage`, agent.state.errorMessage ?? null);
