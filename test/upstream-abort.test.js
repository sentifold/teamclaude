import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

// These tests target the global-fetch escape hatch (directFetch), which drives
// fetch with its own AbortController to arm the headers-only deadline. Building
// that controller must COMPOSE with a caller-provided signal, not replace it:
// spreading `{ ...opts, signal: ctrl.signal }` silently discarded `opts.signal`,
// so a caller's cancellation (client disconnect, retry deadline) could not stop
// an in-flight upstream request until the full headers timeout elapsed.
process.env.TEAMCLAUDE_UPSTREAM_GLOBAL_FETCH = '1';
const { upstreamFetch } = await import('../src/upstream-fetch.js');

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0);
  await once(server, 'listening');
  return { server, port: server.address().port };
}

test('caller abort cancels a direct fetch before the headers timeout', async () => {
  const { server } = await listen(() => { /* never respond */ });
  const port = server.address().port;

  const ctrl = new AbortController();
  const reason = new Error('client went away');
  reason.code = 'TEST_CLIENT_CLOSED';
  setTimeout(() => ctrl.abort(reason), 50);

  const start = Date.now();
  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', body: '{}', signal: ctrl.signal, headersTimeoutMs: 30_000 }),
    (err) => (err.cause ?? err).code === 'TEST_CLIENT_CLOSED',
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 2000, `caller abort must not wait out the headers timeout, took ${elapsed}ms`);

  server.close();
});

test('an already-aborted caller signal rejects without opening a request', async () => {
  let hits = 0;
  const { server } = await listen((_req, res) => { hits++; res.end(); });
  const port = server.address().port;

  const ctrl = new AbortController();
  const reason = new Error('aborted before send');
  reason.code = 'TEST_PRE_ABORTED';
  ctrl.abort(reason);

  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', body: '{}', signal: ctrl.signal, headersTimeoutMs: 30_000 }),
    (err) => (err.cause ?? err).code === 'TEST_PRE_ABORTED',
  );
  // Give a would-be request one tick to land before counting.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(hits, 0, 'no upstream request may be sent for a pre-aborted signal');

  server.close();
});

test('the headers timeout still fires with a caller signal attached', async () => {
  const { server } = await listen(() => { /* never respond */ });
  const port = server.address().port;

  const ctrl = new AbortController(); // never aborted
  await assert.rejects(
    () => upstreamFetch(`http://127.0.0.1:${port}/v1/messages`,
      { method: 'POST', body: '{}', signal: ctrl.signal, headersTimeoutMs: 200 }),
    (err) => (err.cause ?? err).code === 'TEAMCLAUDE_HEADERS_TIMEOUT',
  );

  server.close();
});
