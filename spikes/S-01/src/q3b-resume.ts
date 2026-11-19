// Q3 process B (new process): restore from JSON and continue.
//   mode=initial  -> initialState.messages = saved
//   mode=prepare  -> empty Agent; prepareRequest installs canonical log (saved + new events appended via subscribe)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { setup, getWeather, OUT, log, summarize, checkPairing } from "./lib.ts";

const mode = process.argv[2] ?? "initial";
const think = (process.argv[3] ?? "off") as any;
const tag = think === "off" ? "" : `-${think}`;
const saved = JSON.parse(readFileSync(resolve(OUT, `q3${tag}-messages.json`), "utf8"));
const { model, streamFn, payloads } = setup(`q3b-${mode}${tag}`);
const question = "Without calling any tool: what is my name, my favourite colour, which city did I ask about, and what weather code did the tool return?";

let agent: Agent;
if (mode === "initial") {
  agent = new Agent({ initialState: { model, tools: [getWeather], messages: saved, thinkingLevel: think }, streamFn, sessionId: "spike-q3" });
} else {
  const canonical: any[] = [...saved]; // stands in for the Postgres event log
  agent = new Agent({ initialState: { model, tools: [getWeather] }, streamFn, sessionId: "spike-q3" });
  agent.subscribe((e: any) => { if (e.type === "message_end") canonical.push(e.message); });
  agent.prepareRequest = async ({ context }: any) => {
    log("q3b.prepareRequest.incoming", summarize(context.messages));
    return { context: { ...context, messages: [...canonical] } };
  };
  (globalThis as any).canonical = canonical;
}
await agent.prompt(question);
const msgs = mode === "initial" ? agent.state.messages : (globalThis as any).canonical;
log(`q3b-${mode}.answer`, summarize(msgs).slice(-1));
log(`q3b-${mode}.pairing`, checkPairing(msgs));
log(`q3b-${mode}.agentStateLen`, agent.state.messages.length);
const sent: any = payloads[0];
log(`q3b-${mode}.sentRoles`, sent.messages.map((m: any) => m.role + (m.tool_calls ? `[tool_calls:${m.tool_calls.map((t: any) => t.id)}]` : "") + (m.tool_call_id ? `[${m.tool_call_id}]` : "")));
