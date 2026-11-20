// Runs inside the harness container. Reads the service token from the mount and prints
// internal event JSON only. The token is never written to stdout or stderr.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const id = process.env.EVAL_SID;
if (!id) {
  process.stderr.write('missing EVAL_SID\n');
  process.exit(2);
}
const token = readFileSync('/run/secrets/harness_service_token', 'utf8').trim();
const base = process.env.SESSION_API_URL || 'http://172.30.2.20:8081';
const all = [];
let after = 0;
for (;;) {
  const url = `${base}/internal/v1/sessions/${id}/events?afterSeq=${after}&limit=500`;
  const res = await globalThis.fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    process.stderr.write(`events http ${res.status}\n`);
    process.exit(1);
  }
  const body = await res.json();
  const events = Array.isArray(body.events) ? body.events : [];
  all.push(...events);
  if (!body.hasMore || events.length === 0) break;
  after = events[events.length - 1].seq;
}
process.stdout.write(JSON.stringify(all));
