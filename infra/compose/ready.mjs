// Container health probe. GET /readyz.
// 200: the service's own ready check passed.
// 403 FORBIDDEN_PEER: the HTTP server is up, but this container's own address is not an allowed
// peer (A-01 §2.2). The peer hook runs before the ready handler, so a self-check cannot observe
// the database probe without widening PUBLIC/HANDS/BOOKING_ALLOWED_PEERS or editing service code.
/* global AbortController, clearTimeout, fetch, process, setTimeout */
const url = process.argv[2];
if (url === undefined || url === '') process.exit(1);
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 4000);
try {
  const res = await fetch(url, { signal: ac.signal });
  const body = await res.text();
  if (res.status === 200) process.exit(0);
  if (res.status === 403 && body.includes('FORBIDDEN_PEER')) process.exit(0);
  process.exit(1);
} catch {
  process.exit(1);
} finally {
  clearTimeout(timer);
}
