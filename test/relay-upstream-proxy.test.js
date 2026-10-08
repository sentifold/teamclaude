import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCertChain } from '../src/x509.js';
import { spawnServer } from '../test-helpers/spawn-server.js';

// Remote Control and the other client-credential paths are relayed with the
// client's own credential (relayStream, relayUpgrade), not through
// upstream-fetch.js, and the relays did not consult `upstreamProxy`: on a host
// that reaches Anthropic only through that proxy they failed while inference
// worked. This drives the real server as a subprocess with an upstream proxy
// the test controls, over plain HTTP and over TLS end to end through the
// tunnel (the production shape: the origin's CA reaches the child through
// NODE_EXTRA_CA_CERTS, as a corporate CA would).

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A CONNECT proxy that records every tunnel's target. refuseNext() makes it
// answer the next CONNECT with a 502 and leave that connection open, the way
// a proxy whose own egress failed does: closing it is the client's job, and
// `refused` holds one promise per such connection, settled when it closes.
// drop() resets every live tunnel at the client side, as a proxy dropping its
// connections does, and closes the far side. close() destroys everything.
function egressProxy() {
  const targets = [];
  const refused = [];
  const tunnels = [];
  const sockets = new Set();
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); };
  let refuse = false;
  const server = net.createServer((client) => {
    track(client);
    client.on('error', () => {});
    client.once('data', (chunk) => {
      const target = /^CONNECT (\S+) /.exec(chunk.toString('latin1'))?.[1];
      targets.push(target);
      if (refuse || !target) {
        refuse = false;
        refused.push(new Promise(resolve => client.once('close', resolve)));
        client.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      // Every origin here listens on 127.0.0.1; the TLS one is named localhost.
      const up = net.connect(Number(target.split(':').pop()), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(client);
        client.pipe(up);
      });
      track(up);
      up.on('error', () => client.destroy());
      tunnels.push({ client, up });
    });
  });
  return {
    server, targets, refused,
    refuseNext() { refuse = true; },
    drop() { for (const { client, up } of tunnels.splice(0)) { up.destroy(); client.resetAndDestroy(); } },
    close() { for (const s of sockets) s.destroy(); server.close(); },
  };
}

// The origin the relays reach: a held-open event stream that echoes the
// bearer it was sent, and a WebSocket endpoint that echoes frames. Over https
// it serves a certificate for `localhost` from a throwaway CA, written to
// `dir` for the child's NODE_EXTRA_CA_CERTS. `upgraded` holds the sockets the
// server let go of at the 101, which closeAllConnections() does not reach.
async function relayOrigin(scheme, dir) {
  const upgraded = new Set();
  const onRequest = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Held open, like the worker event stream it stands in for.
    res.write(`event: ping\ndata: ${req.headers.authorization}\n\n`);
  };
  let server;
  let caPath = null;
  if (scheme === 'https') {
    const { caCertPem, leafCertPem, leafKeyPem } = generateCertChain('localhost');
    caPath = join(dir, 'ca.pem');
    await writeFile(caPath, caCertPem);
    server = https.createServer({ key: leafKeyPem, cert: leafCertPem }, onRequest);
  } else {
    server = http.createServer(onRequest);
  }
  server.on('upgrade', (_req, socket) => {
    upgraded.add(socket);
    socket.on('error', () => {});
    socket.on('end', () => socket.end());
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
  });
  return {
    server, caPath,
    host: scheme === 'https' ? 'localhost' : '127.0.0.1',
    close() {
      for (const s of upgraded) s.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}

for (const scheme of ['http', 'https']) {
  test(`Remote Control relays tunnel through upstreamProxy over ${scheme}, and a dropped or refused tunnel ends only its own relay`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'teamclaude-relay-proxy-'));
    const origin = await relayOrigin(scheme, dir);
    const egress = egressProxy();
    let server;
    let ws;
    try {
      const originPort = await listen(origin.server);
      const egressPort = await listen(egress.server);
      const tunnel = `${origin.host}:${originPort}`;
      server = await spawnServer({
        dir,
        env: origin.caPath ? { NODE_EXTRA_CA_CERTS: origin.caPath } : {},
        config: () => ({
          upstream: `${scheme}://${tunnel}`,
          upstreamProxy: `127.0.0.1:${egressPort}`,
          accounts: [{ name: 'a@example.com', type: 'apikey', apiKey: 'k1' }],
        }),
      });
      const base = `http://127.0.0.1:${server.port}`;
      const stream = () => fetch(`${base}/v1/code/sessions/s1/worker/events/stream`, {
        headers: { authorization: 'Bearer client-own-token' },
      });

      // The long-poll reaches the origin through the proxy, credential intact.
      const res = await stream();
      assert.equal(res.status, 200);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      assert.match(Buffer.from(value).toString(), /data: Bearer client-own-token/);
      assert.deepEqual(egress.targets, [tunnel], 'the relay went through the upstream proxy');

      // The proxy drops that tunnel mid-stream: the client's stream ends (an
      // abrupt close reads as an error) instead of waiting on a dead channel.
      egress.drop();
      for (;;) {
        const next = await reader.read().catch(() => ({ done: true }));
        if (next.done) break;
      }

      // The WebSocket channel takes the same route.
      ws = net.connect(server.port, '127.0.0.1');
      ws.on('error', () => {});
      ws.write(`GET /v1/session_ingress/ws/s1 HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`);
      let received = '';
      await new Promise((resolve, reject) => {
        ws.on('close', () => reject(new Error(`WebSocket closed early: ${JSON.stringify(received)}`)));
        ws.on('data', (chunk) => {
          received += chunk;
          if (/^HTTP\/1\.1 101 [^]*\r\n\r\n$/.test(received)) ws.write('echo-me');
          if (received.endsWith('echo-me')) resolve();
        });
      });
      assert.deepEqual(egress.targets, [tunnel, tunnel]);

      // A refused CONNECT is a 502 to the client, and the relay closes the
      // refused connection itself rather than leaving it for the proxy to reset.
      egress.refuseNext();
      const refusedRes = await stream();
      assert.equal(refusedRes.status, 502);
      await refusedRes.text();
      assert.deepEqual(egress.targets, [tunnel, tunnel, tunnel]);
      await egress.refused[0];

      // The same server is still answering.
      const status = await (await fetch(`${base}/teamclaude/status`)).json();
      assert.equal(status.server.pid, server.pid);
    } finally {
      ws?.destroy();
      await server?.stop();
      egress.close();
      origin.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
