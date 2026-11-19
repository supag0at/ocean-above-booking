// Q2a: list DeepSeek models via the API (GET /models). Key sent only in the header, never printed.
import { loadKey, countCall, log } from "./lib.ts";
loadKey();
countCall("q2-models", "GET /models");
const r = await fetch("https://api.deepseek.com/models", { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } });
log("q2-models", { status: r.status, body: await r.json() });
