// Q6 probe: does DeepSeek parse `strict` server-side? Send a schema that is invalid for strict mode
// (additionalProperties:true, property not in required) with strict:true vs strict:false.
import { loadKey, countCall, log, redact } from "./lib.ts";
loadKey();
const schema = { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"], additionalProperties: true };
const base = process.argv[2] ?? "https://api.deepseek.com";
for (const strict of (process.argv[3] === "only-true" ? [true] : [true, false])) {
  countCall("q6-probe", `strict=${strict}`);
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", max_tokens: 50, thinking: { type: "disabled" }, messages: [{ role: "user", content: "call t with a='x'" }],
      tools: [{ type: "function", function: { name: "t", description: "t", parameters: schema, strict } }] }),
  });
  const text = await r.text();
  log(`q6-probe[${base}].strict=${strict}`, { status: r.status, body: redact(text).slice(0, 400) });
}
