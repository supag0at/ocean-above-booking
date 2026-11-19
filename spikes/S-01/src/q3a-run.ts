// Q2/Q3/Q7 process A: one conversation with a tool call, streamed; persist messages as JSON.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { setup, getWeather, OUT, log, summarize, checkPairing } from "./lib.ts";

const think = (process.argv[2] ?? "off") as any;
const tag = think === "off" ? "" : `-${think}`;
const { model, streamFn } = setup(`q3a${tag}`);
const agent = new Agent({
  initialState: { systemPrompt: "You are a terse assistant. Use tools when asked about weather.", model, tools: [getWeather], thinkingLevel: think },
  streamFn,
  sessionId: "spike-q3",
});
let deltas = 0; const order: string[] = [];
agent.subscribe((e: any) => {
  order.push(e.type === "message_update" ? "" : e.type);
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") deltas++;
});
await agent.prompt("My name is Lin and my favourite colour is teal. What's the weather in Paris right now?");
log("q3a.events", order.filter(Boolean).join(" > "));
log("q3a.textDeltas", deltas);
const msgs = agent.state.messages;
writeFileSync(resolve(OUT, `q3${tag}-messages.json`), JSON.stringify(msgs, null, 2));
log("q3a.messages", summarize(msgs));
log("q3a.pairing", checkPairing(msgs));
for (const m of msgs as any[]) if (m.role === "assistant") log("q3a.usage", { usage: m.usage, api: m.api, provider: m.provider, model: m.model });
