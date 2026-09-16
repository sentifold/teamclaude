import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(process.argv[2]);
const load = name => import(pathToFileURL(`${root}/src/${name}.js`));
const { AccountManager } = await load('account-manager');
const { createProxyServer } = await load('server');
const { createConnectHandler } = await load('mitm');
const { generateCertChain } = await load('x509');
const { reloadModelBlocklist } = await import(pathToFileURL(`${root}/src/model-blocklist.mjs`));
const patterns = ['*opus-5*', '*opus5*', '*opus_5*', '*opus.5*', '*5-opus*', 'opus', 'claude-opus', '*opus-latest*'];
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
let hits = 0;
const upstream = http.createServer((_req, res) => { hits++; res.end('{"ok":true}'); });
const upstreamPort = await listen(upstream);
const config = { proxy: { apiKey: 'fixture' }, upstream: `http://127.0.0.1:${upstreamPort}`, blockedModels: patterns };
const am = new AccountManager([{ name: 'fixture', type: 'apikey', apiKey: 'not-a-real-key', modelMap: { private_alias: 'claude-opus-5' } }], 0.98);
let refreshes = 0;
am.ensureTokenFresh = async () => { refreshes++; };
let diskConfig = { blockedModels: patterns };
const proxy = createProxyServer(am, config, { reload: async () => { reloadModelBlocklist(config, diskConfig); return 0; } });
const port = await listen(proxy);
const post = (body, path = '/v1/messages') => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
let cases = 0;
async function denied(body, path) {
  const before = hits, refreshBefore = refreshes;
  const res = await post(body, path);
  const data = await res.json();
  assert.equal(res.status, 400, JSON.stringify(data));
  assert.equal(data.error.code, 'model_blocked');
  assert.equal(res.headers.get('retry-after'), null);
  assert.equal(hits, before, 'blocked request reached upstream');
  assert.equal(refreshes, refreshBefore, 'blocked request attempted auth refresh');
  cases++;
}
try {
  for (const model of ['claude-opus-5', 'claude-opus-5-20260917', 'claude-opus-5-1', 'OPUS5', 'opus_5', 'opus.5', 'anthropic.claude-opus-5-v1:0', 'claude-5-opus', 'opus', 'claude-opus', 'claude-opus-latest']) {
    await denied({ model, messages: [] });
  }
  await denied('{"model":"claude-opus-\\u0035","messages":[]}');
  await denied({ model: 'claude-opus-5' }, '/tc-acct/fixture/v1/messages');
  await denied({ model: 'claude-fable-5-1', tools: [{ type: 'advisor_20250901', model: 'claude-opus-5' }] });
  await denied({ model: 'claude-fable-5-1', tools: [{ type: 'advisor', model: 'claude-sonnet-4' }, { type: 'advisor', model: 'claude-opus-5' }] });
  await denied({ model: 'private_alias', messages: [] });
  for (const model of ['claude-opus-4-8', 'claude-fable-5-1', 'claude-sonnet-4']) {
    const before = hits;
    const response = await post({ model, messages: [{ role: 'user', content: 'claude-opus-5 is a string, not a model selection' }], tools: [{ name: 'example', input_schema: { model: 'claude-opus-5' } }] });
    assert.equal(response.status, 200); await response.text();
    assert.equal(hits, before + 1); cases++;
  }
  // The same resident listener sees a block added and removed by reload.
  diskConfig = { blockedModels: [...patterns, 'reload-test'] };
  assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' })).status, 200);
  await denied({ model: 'reload-test' });
  diskConfig = { blockedModels: 'invalid' };
  assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' })).status, 500);
  await denied({ model: 'reload-test' });
  diskConfig = { blockedModels: patterns };
  assert.equal((await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: 'POST' })).status, 200);
  const allowed = await post({ model: 'reload-test' });
  assert.equal(allowed.status, 200); await allowed.text();

  // Native Claude uses CONNECT + TLS. Exercise both h1 and h2 through that path.
  const certs = generateCertChain('localhost');
  const connect = http.createServer();
  connect.on('connect', createConnectHandler({ config, accountManager: am, ensureLeaf: async () => ({ key: certs.leafKeyPem, cert: certs.leafCertPem }), log: () => {} }));
  const connectPort = await listen(connect);
  try {
    for (const alpn of ['http/1.1', 'h2']) {
      const raw = net.connect(connectPort, '127.0.0.1');
      await new Promise((resolve, reject) => {
        raw.once('error', reject);
        raw.once('connect', () => raw.write(`CONNECT 127.0.0.1:${upstreamPort} HTTP/1.1\r\nHost: 127.0.0.1\r\nProxy-Authorization: Basic Zml4dHVyZTpmaXh0dXJl\r\n\r\n`));
        let response = '';
        const data = chunk => { response += chunk; if (response.includes('\r\n\r\n')) { raw.removeListener('data', data); assert.match(response, /200/); resolve(); } };
        raw.on('data', data);
      });
      const socket = tls.connect({ socket: raw, servername: 'localhost', ca: certs.caCertPem, ALPNProtocols: [alpn] });
      await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
      const before = hits;
      const body = JSON.stringify({ model: 'claude-fable-5-1', tools: [{ type: 'advisor', model: 'claude-opus-5' }] });
      if (alpn === 'h2') {
        const client = http2.connect('https://localhost', { createConnection: () => socket });
        const req = client.request({ ':method': 'POST', ':path': '/v1/messages', 'content-type': 'application/json' });
        let status, data = '';
        req.on('response', headers => { status = headers[':status']; });
        req.on('data', chunk => { data += chunk; });
        await new Promise((resolve, reject) => { req.on('end', resolve); req.on('error', reject); req.end(body); });
        assert.equal(status, 400); assert.equal(JSON.parse(data).error.code, 'model_blocked');
        client.destroy();
      } else {
        const response = await new Promise((resolve, reject) => {
          let data = ''; socket.on('data', chunk => { data += chunk; });
          socket.on('end', () => resolve(data)); socket.on('error', reject);
          socket.write(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
        assert.match(response, /^HTTP\/1.1 400/); assert.match(response, /model_blocked/);
      }
      socket.destroy(); raw.destroy();
      assert.equal(hits, before); cases++;
    }
  } finally { connect.closeAllConnections(); connect.close(); }
  console.log(`PASS: ${cases} model blocklist checks; blocked requests made zero upstream/auth calls, allowed models forwarded, reload and pinned TLS h1/h2 verified.`);
} finally {
  proxy.closeAllConnections(); proxy.close(); upstream.closeAllConnections(); upstream.close();
}
