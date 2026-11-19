// Q4 driver: start child, SIGKILL it while slow_tool is executing.
import { spawn } from "node:child_process";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OUT } from "./lib.ts";
const marker = resolve(OUT, "slow_tool.started");
rmSync(marker, { force: true });
const child = spawn(process.execPath, [resolve(import.meta.dirname, "q4a-crash-child.ts")], { stdio: "inherit" });
const t0 = Date.now();
while (!existsSync(marker)) { if (Date.now() - t0 > 60000) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 100)); }
await new Promise((r) => setTimeout(r, 500));
child.kill("SIGKILL");
child.on("exit", (code, sig) => {
  console.log(`[q4-driver] child killed during slow_tool: code=${code} signal=${sig}`);
  console.log("[q4-driver] event log at crash:");
  for (const l of readFileSync(resolve(OUT, "q4-events.jsonl"), "utf8").trim().split("\n")) {
    const e = JSON.parse(l);
    console.log("  ", e.kind, e.message ? `${e.message.role}${e.message.role === "assistant" ? " stop=" + e.message.stopReason + " " + JSON.stringify(e.message.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.id)) : ""}` : e.toolCallId);
  }
});
