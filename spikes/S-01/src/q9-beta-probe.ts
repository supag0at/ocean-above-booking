// Q9: is the TypeBox JSON (incl. extra:{not:{}} and optional props) accepted by DeepSeek /beta strict mode? 1 call.
import { Type } from "typebox";
import { loadKey, countCall, log, redact } from "./lib.ts";
loadKey();
const RouteParams = Type.Object(
  { from: Type.String({ minLength: 1 }), to: Type.String({ minLength: 1 }), adults: Type.Optional(Type.Integer({ minimum: 1, maximum: 9 })), extra: Type.Optional(Type.Never()) },
  { additionalProperties: false },
);
countCall("q9-beta-probe", "strict=true /beta");
const r = await fetch("https://api.deepseek.com/beta/chat/completions", {
  method: "POST", headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "deepseek-flash", max_tokens: 60, thinking: { type: "disabled" }, messages: [{ role: "user", content: "route Rome to Oslo" }],
    tools: [{ type: "function", function: { name: "find_route", description: "route", parameters: JSON.parse(JSON.stringify(RouteParams)), strict: true } }] }),
});
log("q9-beta-probe", { status: r.status, body: redact(await r.text()).slice(0, 300) });
