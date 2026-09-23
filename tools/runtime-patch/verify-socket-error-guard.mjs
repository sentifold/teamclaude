// Behavioral check of the socket error guard on a staged TeamClaude package.
//
//   node verify-socket-error-guard.mjs <package-root>                run every scenario
//   node verify-socket-error-guard.mjs <package-root> --only <name>  one scenario, raw result
//
// A socket 'error' nobody listens to is only observable as a dying process, so
// each scenario runs in its own child with a private HOME and the managed
// service's proxy environment: NODE_USE_ENV_PROXY=1 and HTTPS_PROXY pointing
// at a loopback fake of the smart proxy. Nothing leaves loopback.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [rootArg, mode, only] = process.argv.slice(2);
const root = resolve(rootArg);
const load = (name) => import(pathToFileURL(`${root}/src/${name}.js`));
const listen = (server, port = 0) => new Promise((done) => server.listen(port, '127.0.0.1', () => done(server.address().port)));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Never events.once(): it adds an 'error' listener and would hide the crash under test.
const closed = (socket) => new Promise((done) => socket.on('close', done));
const certs = () => ({
  key: readFileSync(join(process.env.GUARD_CERTS, 'leaf.key'), 'utf8'),
  cert: readFileSync(join(process.env.GUARD_CERTS, 'leaf.pem'), 'utf8'),
  ca: readFileSync(join(process.env.GUARD_CERTS, 'ca.pem'), 'utf8'),
});

// Loopback CONNECT proxy. `refuse` answers like the smart proxy during an egress
// outage and resets the refused connection shortly after. Otherwise it tunnels;
// resetTunnels() then resets both sides of every tunnel, like a dropped link.
function smartProxy({ refuse = false } = {}) {
  const connects = [];
  const tunnels = [];
  const resetTunnels = () => {
    for (const [client, upstream] of tunnels) { upstream.destroy(); client.resetAndDestroy(); }
  };
  const server = net.createServer((client) => {
    client.on('error', () => {});
    client.once('data', (chunk) => {
      const target = /^CONNECT (\S+) /.exec(String(chunk))?.[1];
      connects.push(target);
      if (refuse || !target) {
        client.write('HTTP/1.1 502 Protected Egress Failed\r\nContent-Length: 0\r\n\r\n');
        setTimeout(() => client.resetAndDestroy(), 100);
        return;
      }
      const [host, port] = target.split(':');
      const upstream = net.connect({ port: Number(port), host, autoSelectFamily: true }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
        tunnels.push([client, upstream]);
      });
      upstream.on('error', () => client.destroy());
    });
  });
  return { server, connects, resetTunnels };
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((done) => server.close(done));
  return port;
}

async function refusedSmartProxy() {
  const proxy = smartProxy({ refuse: true });
  await listen(proxy.server, Number(process.env.GUARD_SMART_PORT));
  return { ...proxy, upstreamPort: await unusedPort() };
}

async function tlsTunnelFixture() {
  const origin = tls.createServer({ key: certs().key, cert: certs().cert }, (socket) => socket.on('error', () => {}));
  const originPort = await listen(origin);
  const { server, resetTunnels } = smartProxy();
  return { originPort, proxyPort: await listen(server), resetTunnels };
}

function crashLog(dir = process.env.GUARD_TMP) {
  return readFileSync(join(dir, 'crash.log'), 'utf8');
}

async function strayResets(count) {
  const peer = net.createServer((socket) => setTimeout(() => socket.resetAndDestroy(), 50));
  const port = await listen(peer);
  // Deliberately without an 'error' listener: the production crash signature.
  for (let i = 0; i < count; i++) net.connect(port, '127.0.0.1').resume();
  await sleep(500);
}

const scenarios = {
  // The production crash: Remote Control's relay behind a refused CONNECT.
  'relay-refused-connect': { exit: 0, async run() {
    const { connects, upstreamPort } = await refusedSmartProxy();
    const { createProxyRequestListener } = await load('server');
    const accountManager = { getActiveAccount() { throw new Error('Remote Control must never rotate accounts'); } };
    const proxy = http.createServer(createProxyRequestListener({ accountManager, upstream: `https://127.0.0.1:${upstreamPort}` }));
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/v1/code/sessions/fixture/events/stream`, { headers: { authorization: 'Bearer fixture' } });
    assert.equal(res.status, 502);
    await res.text();
    await sleep(400); // the refused tunnel is reset inside this window
    assert.deepEqual(connects, [`127.0.0.1:${upstreamPort}`], 'the relay must use the proxy, never a direct socket');
  } },
  'upgrade-refused-connect': { exit: 0, async run() {
    const { connects, upstreamPort } = await refusedSmartProxy();
    const { relayUpgrade } = await load('server');
    const proxy = http.createServer();
    proxy.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, `https://127.0.0.1:${upstreamPort}`, null));
    const client = net.connect(await listen(proxy), '127.0.0.1');
    client.on('error', () => {});
    client.write('GET /v1/session_ingress/ws/fixture HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await closed(client);
    await sleep(400);
    assert.deepEqual(connects, [`127.0.0.1:${upstreamPort}`], 'the relay must use the proxy, never a direct socket');
  } },
  'forward-refused-connect': { exit: 0, async run() {
    const { connects, upstreamPort } = await refusedSmartProxy();
    const { relayHttpForward } = await load('server');
    const port = await listen(http.createServer((req, res) => relayHttpForward(req, res)));
    // TeamClaude 1.1.21 refuses loopback forward targets (4051e50), so name a
    // host the proxy, not this machine, would resolve.
    const status = await new Promise((done, fail) => http.request(
      { host: '127.0.0.1', port, path: `https://relay-target.invalid:${upstreamPort}/fixture` },
      (res) => { res.resume(); done(res.statusCode); },
    ).on('error', fail).end());
    assert.equal(status, 502);
    await sleep(400);
    assert.deepEqual(connects, [`relay-target.invalid:${upstreamPort}`], 'the relay must use the proxy, never a direct socket');
  } },
  // The rerouted relays still work end to end through the proxy.
  'relays-through-proxy': { exit: 0, async run() {
    const { server, connects } = smartProxy();
    await listen(server, Number(process.env.GUARD_SMART_PORT));
    const origin = https.createServer({ key: certs().key, cert: certs().cert }, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: ping\ndata: ${req.headers.authorization}\n\n`);
    });
    origin.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.on('data', (chunk) => socket.write(chunk));
    });
    const upstream = `https://localhost:${await listen(origin)}`;
    const { createProxyRequestListener, relayUpgrade } = await load('server');
    const accountManager = { getActiveAccount() { throw new Error('Remote Control must never rotate accounts'); } };
    const proxy = http.createServer(createProxyRequestListener({ accountManager, upstream }));
    proxy.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, upstream, null));
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/v1/code/sessions/fixture/events/stream`, { headers: { authorization: 'Bearer fixture' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /data: Bearer fixture/);
    const client = net.connect(port, '127.0.0.1');
    client.write('GET /v1/session_ingress/ws/fixture HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    let received = '';
    await new Promise((done, fail) => {
      client.on('error', fail);
      client.on('data', (chunk) => {
        received += chunk;
        if (received.endsWith('\r\n\r\n') && /^HTTP\/1\.1 101 /.test(received)) client.write('echo-me');
        if (received.endsWith('echo-me')) done();
      });
    });
    client.destroy();
    // The upstream tunnel pool (r29) hands the stream's idle tunnel to the WebSocket.
    assert.equal(connects.length, 1, 'the WebSocket reuses the stream\'s pooled, guarded tunnel');
    assert.ok(connects.every((target) => target === new URL(upstream).host), connects.join());
  } },
  // A tunnel handed to its consumer before the consumer listens for errors.
  'raw-tunnel-reset-after-handoff': { exit: 0, async run() {
    const target = net.createServer((socket) => socket.on('error', () => {}));
    const targetPort = await listen(target);
    const { server, resetTunnels } = smartProxy();
    const proxyPort = await listen(server);
    const { connectThroughProxy } = await load('sx');
    const socket = await connectThroughProxy({ proxyHost: '127.0.0.1', proxyPort, targetHost: '127.0.0.1', targetPort, timeout: 5000 });
    socket.resume();
    resetTunnels();
    await closed(socket);
  } },
  'tls-tunnel-reset-after-handoff': { exit: 0, async run() {
    const { originPort, proxyPort, resetTunnels } = await tlsTunnelFixture();
    const { tunnelTls } = await load('sx');
    const socket = await tunnelTls({ proxy: { host: '127.0.0.1', port: proxyPort }, targetHost: 'localhost', targetPort: originPort, tlsOptions: { ca: certs().ca } });
    socket.resume();
    resetTunnels();
    await closed(socket);
  } },
  'agent-tunnel-reset-after-handoff': { exit: 0, async run() {
    const { originPort, proxyPort, resetTunnels } = await tlsTunnelFixture();
    const { proxyAgent } = await load('upstream-proxy');
    const agent = proxyAgent({ host: '127.0.0.1', port: proxyPort, username: null, password: null },
      { targetHost: 'localhost', targetPort: originPort, tlsOptions: { ca: certs().ca } });
    const socket = await new Promise((done, fail) => agent.createConnection({}, (err, sock) => (err ? fail(err) : done(sock))));
    socket.resume();
    resetTunnels();
    await closed(socket);
  } },
  // Defence in depth: a stray reset on a socket nobody listens to is recorded,
  // and the process keeps serving.
  'crash-log-tolerates-stray-reset': { exit: 0, async run() {
    const { installCrashHandlers } = await load('crash-log');
    installCrashHandlers(join(process.env.GUARD_TMP, 'crash.log'));
    await strayResets(1);
    const alive = await listen(http.createServer((_req, res) => res.end('alive')));
    assert.equal(await (await fetch(`http://127.0.0.1:${alive}/`)).text(), 'alive');
    const logged = crashLog();
    assert.match(logged, /=== \S+ tolerated stray stream error ===\nError: read ECONNRESET\n\s+at TCP\.onStreamRead \(node:internal\/stream_base_commons:\d+:\d+\)\n/);
    assert.doesNotMatch(logged, /uncaughtException/);
  } },
  // The same code thrown with application frames is still fatal.
  'crash-log-exits-on-application-error': { exit: 1, async run() {
    const { installCrashHandlers } = await load('crash-log');
    installCrashHandlers(join(process.env.GUARD_TMP, 'crash.log'));
    setTimeout(() => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', errno: -54, syscall: 'read' }); });
    await sleep(2000);
  }, after(dir) {
    assert.match(crashLog(dir), /=== \S+ uncaughtException ===\nError: read ECONNRESET\n/);
    assert.doesNotMatch(crashLog(dir), /tolerated/);
  } },
  // A burst beyond the per-minute budget means something systemic: exit.
  'crash-log-exits-after-stray-burst': { exit: 1, async run() {
    const { installCrashHandlers } = await load('crash-log');
    installCrashHandlers(join(process.env.GUARD_TMP, 'crash.log'));
    await strayResets(21);
    await sleep(2000);
  }, after(dir) {
    assert.equal(crashLog(dir).match(/ tolerated stray stream error ===/g)?.length, 20);
    assert.equal(crashLog(dir).match(/ uncaughtException ===/g)?.length, 1);
  } },
};

async function runScenario(name, shared, dir) {
  mkdirSync(join(dir, 'home'), { recursive: true });
  const smartPort = await unusedPort();
  return spawnSync(process.execPath, [fileURLToPath(import.meta.url), root, '--scenario', name], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH,
      HOME: join(dir, 'home'),
      TMPDIR: dir,
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: `http://127.0.0.1:${smartPort}`,
      NODE_EXTRA_CA_CERTS: join(shared, 'ca.pem'),
      GUARD_SMART_PORT: String(smartPort),
      GUARD_CERTS: shared,
      GUARD_TMP: dir,
    },
  });
}

if (mode === '--scenario') {
  await scenarios[only].run();
  process.stdout.write(`OK ${only}\n`);
  process.exit(0);
}

const shared = mkdtempSync(join(tmpdir(), 'tc-socket-guard-'));
try {
  const { generateCertChain } = await load('x509');
  const chain = generateCertChain('localhost');
  writeFileSync(join(shared, 'ca.pem'), chain.caCertPem);
  writeFileSync(join(shared, 'leaf.pem'), chain.leafCertPem);
  writeFileSync(join(shared, 'leaf.key'), chain.leafKeyPem, { mode: 0o600 });
  for (const [name, scenario] of Object.entries(scenarios)) {
    if (mode === '--only' && name !== only) continue;
    const dir = join(shared, name);
    const result = await runScenario(name, shared, dir);
    if (mode === '--only') {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exitCode = result.status ?? 1;
      break;
    }
    if (result.status !== scenario.exit || (scenario.exit === 0 && !result.stdout.includes(`OK ${name}`))) {
      process.stderr.write(`${result.stdout}${result.stderr}`);
      throw new Error(`${name}: expected exit ${scenario.exit}, got ${result.status ?? result.signal}`);
    }
    scenario.after?.(dir);
  }
} finally {
  rmSync(shared, { recursive: true, force: true });
}
if (mode !== '--only') {
  console.log(`PASS: ${Object.keys(scenarios).length} socket error guard scenarios; refused CONNECT relays and resets after tunnel handoff kept the process alive, relays still tunnel through the proxy, and only stray stream errors are tolerated.`);
}
