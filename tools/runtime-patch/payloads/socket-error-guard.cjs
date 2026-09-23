'use strict';
// Identical staged-package patch published in the TeamClaude fork and dotfiles.
// Usage: node socket-error-guard.cjs <package-root> [--check]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.argv[2];
const check = process.argv.includes('--check');
if (!root || JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version !== '1.1.21') {
  throw new Error('Socket error guard patch requires TeamClaude 1.1.21');
}
const marker = 'Managed socket error guard r27.';
const poolMarker = 'Managed upstream tunnel pool r29.';
function replace(source, old, value, count = 1) {
  if (source.split(old).length !== count + 1) throw new Error(`Unexpected socket-error-guard layout: ${old.trim().slice(0, 70)}`);
  return source.split(old).join(value);
}

// 1.1.21 moved every tunnel TLS handshake (sx, the upstream proxy agent) into
// sx.js's handshakeOverTunnel, so one persistent listener there covers both.
const patches = {
  'sx.js': {
    apply(source) {
      source = replace(source, `      sock.removeListener('data', onData);
      sock.removeListener('error', fail);
    };`, `      sock.removeListener('data', onData);
    };`);
      source = replace(source, `    sock.once('error', fail);
  });`, `    // ${marker} Keep this listener for the socket's whole
    // life. After the handoff the TLS layer or HTTP client that owns the tunnel
    // also listens and fails its own request; a reset that lands while nobody
    // else listens must close this socket, not the process. fail() stays safe
    // here because reject() after resolve() is a no-op.
    sock.on('error', fail);
  });`);
      return replace(source, `    const onOk = () => { settle(); resolve(tlsSock); };`,
        `    // ${marker} The error listener outlives the handshake,
    // as in connectThroughProxy: a late reset runs onErr, which closes both
    // sockets and leaves its sink behind; reject() after resolve() is a no-op.
    const onOk = () => { clearTimeout(timer); tlsSock.removeListener('secureConnect', onOk); resolve(tlsSock); };`);
    },
    required: ["    sock.on('error', fail);", "tlsSock.removeListener('secureConnect', onOk); resolve(tlsSock); };",
      "    tlsSock.once('error', onErr);", "tlsSock.on('error', () => {}); tlsSock.destroy(); sock.destroy(); reject(err);"],
    forbidden: ["sock.removeListener('error', fail)", 'const onOk = () => { settle(); resolve(tlsSock); };'],
  },
  'upstream-proxy.js': {
    required: ['handshakeOverTunnel(sock, { servername: targetHost, tlsOptions })'],
    forbidden: ["tlsSock.once('error'"],
    pool(source) {
      return replace(source, `export function proxyAgent(proxy, { targetHost, targetPort, tls: useTls = true, tlsOptions = {} }) {
  const agent = new (useTls ? https : http).Agent({ keepAlive: false });`, `// ${poolMarker} Every forwarded request built a fresh agent with
// keep-alive off, so each one paid its own CONNECT and TLS handshake (0.3-0.6 s
// to api.anthropic.com) through the loopback smart proxy. One keep-alive agent
// per (proxy, target) reuses the tunnel exactly as the direct path's pooled
// agent does; a tunnel that dies while idle leaves the pool on 'close'. Custom
// TLS options (tests' CAs) keep a fresh, unpooled agent.
const managedPooledProxyAgents = new Map();
export function proxyAgent(proxy, options) {
  if (options.tlsOptions && Object.keys(options.tlsOptions).length) return managedProxyAgent(proxy, options, false);
  const key = [proxy.host, proxy.port, proxy.username || '', options.targetHost, options.targetPort, options.tls !== false].join('|');
  let agent = managedPooledProxyAgents.get(key);
  if (!agent) {
    agent = managedProxyAgent(proxy, options, true);
    managedPooledProxyAgents.set(key, agent);
  }
  return agent;
}

function managedProxyAgent(proxy, { targetHost, targetPort, tls: useTls = true, tlsOptions = {} }, keepAlive) {
  const agent = new (useTls ? https : http).Agent({ keepAlive });`);
    },
    poolRequired: ['const managedPooledProxyAgents = new Map();', 'new (useTls ? https : http).Agent({ keepAlive });'],
  },
  'server.js': {
    apply(source) {
      source = replace(source, "import { tunnelTls } from './sx.js';\n",
        `import { tunnelTls } from './sx.js';\n// ${marker}\nimport { proxyForHost, proxyAgent } from './upstream-proxy.js';\n`);
      source = replace(source, `      .catch((err) => cb(err, null));
    return undefined;
  };
  return agent;
}
`, `      .catch((err) => cb(err, null));
    return undefined;
  };
  return agent;
}

// ${marker} Under --use-env-proxy a relay without an explicit
// agent used Node's proxy-aware global agent. When the proxy refuses CONNECT
// (for example 502), Node 26 abandons that proxy socket without destroying it
// or leaving an 'error' listener, so the proxy's later reset crashed the whole
// router with "read ECONNRESET at TCP.onStreamRead". Tunnel relays through
// the same guarded CONNECT path that forwarded requests use.
function managedRelayAgent(target) {
  if (target.protocol !== 'https:') return undefined;
  const proxy = proxyForHost(target.hostname);
  return proxy ? proxyAgent(proxy, { targetHost: target.hostname, targetPort: Number(target.port) || 443 }) : undefined;
}
`);
      source = replace(source, '  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;',
        '  const agent = useProxy ? sxAgent(sx, target.hostname) : managedRelayAgent(target);', 2);
      return replace(source, '  const upstreamReq = transport.request(target, { method: req.method, headers, lookup: guardedLookup(req.socket) }, (upstreamRes) => {',
        '  const upstreamReq = transport.request(target, { method: req.method, headers, lookup: guardedLookup(req.socket), agent: managedRelayAgent(target) }, (upstreamRes) => {');
    },
    required: ['function managedRelayAgent(target) {', "import { proxyForHost, proxyAgent } from './upstream-proxy.js';",
      'guardedLookup(req.socket), agent: managedRelayAgent(target) }'],
    forbidden: ['sxAgent(sx, target.hostname) : undefined;'],
    count: ['sxAgent(sx, target.hostname) : managedRelayAgent(target);', 2],
  },
  'crash-log.js': {
    apply(source) {
      source = replace(source, `import { appendFileSync } from 'node:fs';
`, `import { appendFileSync } from 'node:fs';

// ${marker} An 'error' event nobody listens to is thrown from
// Node's tick queue after its stream was already destroyed. When the error is a
// socket read/write errno raised by the stream internals, with no application
// frame on its stack, no application state was mid-update: record it and keep
// serving instead of dropping every routed session. Any other error, any
// rejection, and more than 20 such errors in a minute still exit as Node would.
const STRAY_STREAM_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED']);
const STREAM_INTERNAL_FRAME = /^\\s*at .*\\(node:internal\\/stream_base_commons:\\d+:\\d+\\)$/;
const STRAY_STREAM_ERRORS_PER_MINUTE = 20;

/** @param {any} err */
export function isStrayStreamError(err) {
  if (!(err instanceof Error) || !STRAY_STREAM_CODES.has(err.code)) return false;
  if (err.syscall !== 'read' && err.syscall !== 'write') return false;
  const frames = String(err.stack).split('\\n').filter((line) => /^\\s*at /.test(line));
  return frames.length > 0 && frames.every((line) => STREAM_INTERNAL_FRAME.test(line));
}
`);
      source = replace(source, ` * would leave the proxy running on unknown state.
 * @param {string} path`, ` * would leave the proxy running on unknown state. The one exception is a stray
 * stream error (see isStrayStreamError), which is recorded and survived.
 * @param {string} path`);
      source = replace(source, `export function installCrashHandlers(path, { exit = process.exit, log = process.stderr } = {}) {
  const report = (/** @type {string} */ kind) => (/** @type {any} */ err) => {
    const stack = err?.stack || String(err);`, `export function installCrashHandlers(path, { exit = process.exit, log = process.stderr } = {}) {
  let strayWindowStart = 0;
  let strayInWindow = 0;
  const report = (/** @type {string} */ kind) => (/** @type {any} */ err) => {
    if (kind === 'uncaughtException' && isStrayStreamError(err)) {
      const now = Date.now();
      if (now - strayWindowStart >= 60_000) { strayWindowStart = now; strayInWindow = 0; }
      if (++strayInWindow <= STRAY_STREAM_ERRORS_PER_MINUTE) {
        record('tolerated stray stream error', err);
        return;
      }
    }
    record(kind, err);
    exit(1);
  };
  const record = (/** @type {string} */ kind, /** @type {any} */ err) => {
    const stack = err?.stack || String(err);`);
      return replace(source, `    log.write(entry);
    exit(1);
  };`, `    log.write(entry);
  };`);
    },
    required: ['export function isStrayStreamError(err) {', "record('tolerated stray stream error', err);",
      "if (kind === 'uncaughtException' && isStrayStreamError(err)) {", '    record(kind, err);\n    exit(1);'],
    forbidden: [],
  },
};

const sources = new Map();
for (const [filename, patch] of Object.entries(patches)) {
  const file = path.join(root, 'src', filename);
  let source = fs.readFileSync(file, 'utf8');
  if (patch.apply && !source.includes(marker)) {
    if (check) throw new Error(`${filename}: socket error guard patch missing`);
    source = patch.apply(source);
  }
  if (patch.pool && !source.includes(poolMarker)) {
    if (check) throw new Error(`${filename}: upstream tunnel pool patch missing`);
    source = patch.pool(source);
  }
  const incomplete = patch.required.concat(patch.poolRequired || []).filter((value) => !source.includes(value))
    .concat(patch.forbidden.filter((value) => source.includes(value)));
  if (patch.count && source.split(patch.count[0]).length !== patch.count[1] + 1) incomplete.push(patch.count[0]);
  if (incomplete.length) throw new Error(`${filename}: incomplete socket error guard: ${incomplete.join(' | ')}`);
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
  if (syntax.status !== 0) throw new Error(`${filename}: ${syntax.stderr}`);
  sources.set(file, source);
}
if (!check) for (const [file, source] of sources) fs.writeFileSync(file, source);
console.log(`TeamClaude socket error guard: ${check ? 'verified' : 'patched'}`);
