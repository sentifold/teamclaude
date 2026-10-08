import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function setup(blockedModels, config = {}) {
  let upstreamHits = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const upstreamPort = await listen(upstream);

  const am = new AccountManager(
    [{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.98,
  );
  // The activity rows the TUI and the headless log would print.
  const ended = [];
  const hooks = { onRequestEnd: (_id, info) => ended.push(info) };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: `http://127.0.0.1:${upstreamPort}`, blockedModels, ...config }, hooks);
  const proxyPort = await listen(proxy);

  return {
    get hits() { return upstreamHits; },
    ended,
    post: (model, extra = {}) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [], ...extra }),
    }),
    close() { proxy.close(); upstream.close(); },
  };
}

test('a blocked model (glob) is rejected with a non-retryable 400 and never forwarded', async () => {
  const t = await setup(['*fable*']);
  try {
    const res = await t.post('claude-fable-5');
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(t.hits, 0, 'must not reach upstream');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.match(body.error.message, /blocked/i);
  } finally { t.close(); }
});

test('a non-blocked model is forwarded normally', async () => {
  const t = await setup(['*fable*']);
  try {
    const res = await t.post('claude-opus-4-8');
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1, 'forwarded to upstream');
  } finally { t.close(); }
});

test('an empty blocklist blocks nothing', async () => {
  const t = await setup([]);
  try {
    const res = await t.post('claude-fable-5');
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
  } finally { t.close(); }
});

test('an exact (non-glob) pattern blocks only that model', async () => {
  const t = await setup(['claude-fable-5']);
  try {
    let res = await t.post('claude-fable-5');
    await res.text();
    assert.equal(res.status, 400);
    assert.equal(t.hits, 0);

    res = await t.post('claude-fable-5-mini'); // different name → not blocked
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);
  } finally { t.close(); }
});

// Claude Code's advisor tool: the executor stays in `model`, the advisor's model
// sits in tools[], and upstream runs the advisor's sub-inference on the account
// serving the request (issue #98).
const advisor = (model) => ({ tools: [{ type: 'advisor_20260301', name: 'advisor', model }] });

test('by default a blocked advisor model is left alone and the request is forwarded', async () => {
  // Unset, false, and anything that is not the boolean true: the advisor
  // degrades on its own (issue #98), so only an explicit opt-in refuses it.
  for (const flag of [undefined, false, 'true']) {
    const t = await setup(['*fable*'], { blockedModelsMatchAdvisor: flag });
    try {
      const res = await t.post('claude-opus-4-8', advisor('claude-fable-5'));
      await res.text();
      assert.equal(res.status, 200, `blockedModelsMatchAdvisor: ${flag}`);
      assert.equal(t.hits, 1, `blockedModelsMatchAdvisor: ${flag}`);
    } finally { t.close(); }
  }
});

test('blockedModelsMatchAdvisor refuses a request whose advisor model is blocked, naming the advisor', async () => {
  const t = await setup(['*fable*'], { blockedModelsMatchAdvisor: true });
  try {
    let res = await t.post('claude-opus-4-8', advisor('claude-fable-5'));
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(t.hits, 0, 'must not reach upstream');
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.message, 'Advisor model "claude-fable-5" is blocked by teamclaude (matched "*fable*"). Choose another advisor model, or turn the advisor off.');
    // The activity row points at the advisor's model, not the allowed executor.
    // A refusal writes its row before the answer goes out; a forwarded
    // request's row may land later, so only the blocked rows are read.
    const blockedRows = () => t.ended.filter((row) => row.account === '(blocked)');
    assert.deepEqual(blockedRows().map((row) => [row.status, row.model]), [[400, 'advisor claude-fable-5']]);

    // An allowed advisor model is still forwarded.
    res = await t.post('claude-sonnet-4-6', advisor('claude-opus-4-8'));
    await res.text();
    assert.equal(res.status, 200);
    assert.equal(t.hits, 1);

    // A blocked request model is reported as before, whatever its advisor.
    res = await t.post('claude-fable-5', advisor('claude-fable-5'));
    const both = await res.json();
    assert.equal(res.status, 400);
    assert.equal(both.error.message, 'Model "claude-fable-5" is blocked by teamclaude (matched "*fable*").');
    assert.deepEqual(blockedRows().map((row) => row.model), ['advisor claude-fable-5', 'claude-fable-5']);
    assert.equal(t.hits, 1);
  } finally { t.close(); }
});
