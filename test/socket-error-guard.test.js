import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The runtime patch edits an installed package, so stage one the way the
// installer does: the shipped src/ plus package.json. This checkout's src/ is
// the published 1.1.13 layout, so an unpatched copy reproduces the crash.
const repo = fileURLToPath(new URL('..', import.meta.url));
const payload = join(repo, 'tools/runtime-patch/payloads/socket-error-guard.cjs');
const verifier = join(repo, 'tools/runtime-patch/verify-socket-error-guard.mjs');
const node = (...args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180_000 });
let dir, pristine, patched;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc-socket-guard-test-'));
  pristine = join(dir, 'pristine');
  patched = join(dir, 'patched');
  for (const root of [pristine, patched]) {
    cpSync(join(repo, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(repo, 'package.json'), join(root, 'package.json'));
  }
  const applied = node(payload, patched);
  assert.equal(applied.status, 0, applied.stderr);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('the socket error guard payload is idempotent and refuses to verify an unpatched package', () => {
  const again = node(payload, patched);
  assert.equal(again.status, 0, again.stderr);
  const check = node(payload, patched, '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /socket error guard: verified/);
  assert.notEqual(node(payload, pristine, '--check').status, 0);
});

// Reproduces the production crash log: a Remote Control relay whose CONNECT
// the smart proxy refused (502), followed by that proxy resetting the socket
// Node had abandoned without an 'error' listener.
test('unpatched: a reset after a refused relay CONNECT kills the process', (t) => {
  const run = node(verifier, pristine, '--only', 'relay-refused-connect');
  if (run.status !== 0 && /must use the proxy/.test(run.stderr)) {
    t.skip('this Node has no built-in NODE_USE_ENV_PROXY support, so the relay never reaches the proxy');
    return;
  }
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Error: read ECONNRESET\n\s+at TCP\.onStreamRead \(node:internal\/stream_base_commons/);
});

test('unpatched: a reset on a tunnel after its handoff kills the process', () => {
  const run = node(verifier, pristine, '--only', 'raw-tunnel-reset-after-handoff');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Error: read ECONNRESET\n\s+at TCP\.onStreamRead \(node:internal\/stream_base_commons/);
});

test('patched: every reset scenario leaves the process alive and relays still use the proxy', () => {
  const run = node(verifier, patched);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^PASS: \d+ socket error guard scenarios/m);
});
