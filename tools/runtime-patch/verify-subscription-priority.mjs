import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [codexRoot, claudeRoot] = process.argv.slice(2);
if (!codexRoot || !claudeRoot) throw Error('two staged package roots required');
const load = file => import(pathToFileURL(resolve(file)));
const { chooseAccount } = await load(join(codexRoot, 'dist/lib/runtime/rotation-account-selection.js'));
const { subscriptionRank, codexSubscriptionKey, codexWeeklyReset } = await load(join(codexRoot, 'dist/lib/runtime/subscription-priority.mjs'));
const { AccountManager } = await load(join(claudeRoot, 'src/account-manager.js'));
const directory = mkdtempSync(join(tmpdir(), 'subscription-policy-'));
const file = join(directory, 'dates.json');
const previousFile = process.env.AGENT_ROUTER_SUBSCRIPTIONS_FILE;
process.env.AGENT_ROUTER_SUBSCRIPTIONS_FILE = file;
const realNow = Date.now;
const now = new Date(2026, 8, 12, 12).getTime();
Date.now = () => now;
after(() => {
  Date.now = realNow;
  if (previousFile === undefined) delete process.env.AGENT_ROUTER_SUBSCRIPTIONS_FILE;
  else process.env.AGENT_ROUTER_SUBSCRIPTIONS_FILE = previousFile;
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});
const days = n => now + n * 86_400_000;
const record = (date = '2026-09-14', kind = 'ends') => ({ manual: { date, kind, source: 'manual', checkedAt: now } });
let store;
const save = () => writeFileSync(file, JSON.stringify(store));
beforeEach(() => { store = { schemaVersion: 1, routingPolicy: { mode: 'final-week' }, accounts: {} }; save(); });

test('last weekly window, missing reset, whole end day, and invalid/stale metadata', () => {
  store.accounts.a = record();
  assert.equal(subscriptionRank(store, 'a', days(3), now), Date.parse('2026-09-14'));
  assert.equal(subscriptionRank(store, 'a', days(1), now), Infinity);
  assert.equal(subscriptionRank(store, 'a', null, now), Date.parse('2026-09-14'));
  assert.equal(subscriptionRank(store, 'a', null, new Date(2026, 8, 14, 23, 59).getTime()), Date.parse('2026-09-14'));
  for (const [date, kind] of [['2026-09-11', 'ends'], ['2026-09-20', 'ends'], ['2026-02-30', 'ends'], ['junk', 'ends'], ['2026-09-14', 'renews'], ['2026-09-14', 'period-end']]) {
    store.accounts.a = record(date, kind);
    assert.equal(subscriptionRank(store, 'a', days(3), now), Infinity);
  }
  store.accounts.a = record(); store.accounts.a.manual.checkedAt = days(1);
  assert.equal(subscriptionRank(store, 'a', days(3), now), Infinity);
});

test('Codex quota evidence is fresh, exact model and workspace identity; billing never aliases by email', () => {
  const a = { accountId: 'workspace-a', email: 'same@example.test' };
  const b = { ...a, accountId: 'workspace-b' };
  assert.notEqual(codexSubscriptionKey(a), codexSubscriptionKey(b));
  const entry = { model: 'gpt-6-astra', status: 200, updatedAt: now, secondary: { windowMinutes: 10080, resetAtMs: days(1) } };
  const cache = { byAccountId: { 'workspace-a': entry }, byEmail: { 'same@example.test': entry } };
  assert.equal(codexWeeklyReset(cache, a, 'gpt-6-astra', now), days(1));
  assert.equal(codexWeeklyReset(cache, a, 'gpt-5.6-sol', now), null);
  assert.equal(codexWeeklyReset(cache, b, 'gpt-6-astra', now), null);
  assert.equal(codexWeeklyReset(cache, a, 'gpt-6-astra', now + 900_001), null);
});

function codex() {
  const accounts = [0, 1, 2].map(index => ({ index, accountId: `fixture-${index}`, enabled: true }));
  const blocked = new Set();
  let active = 0;
  const manager = {
    getAccountCount: () => accounts.length,
    getAccountsSnapshot: () => accounts,
    getAccountByIndex: index => accounts[index],
    getAccountRuntimeSkipReason: index => blocked.has(index) || accounts[index].enabled === false ? 'blocked' : null,
    getCurrentAccountForFamily: () => accounts[active],
    markSwitched: account => { active = account.index; },
    getCurrentOrNextForFamilyHybrid: () => accounts[0],
    getCurrentOrNextForFamilySequential: () => accounts[0]
  };
  const params = { accountManager: manager, sessionAffinityStore: { getPreferredAccountIndex: () => 0 }, sessionKey: 'same-task',
    family: 'gpt-5.2', model: 'gpt-6-astra', attemptedIndexes: new Set(), now, policy: null, pinnedIndex: null };
  store.accounts[codexSubscriptionKey(accounts[1])] = record(); save();
  return { accounts, blocked, params, pick: () => chooseAccount(params)?.index };
}
test('Codex existing affinity moves on the next selection; equal dates stay sticky; metadata reloads', () => {
  const c = codex();
  assert.equal(c.pick(), 1);
  store.accounts[codexSubscriptionKey(c.accounts[0])] = record(); save();
  assert.equal(c.pick(), 0);
  store.accounts[codexSubscriptionKey(c.accounts[0])] = record('2026-09-13'); save();
  assert.equal(c.pick(), 0);
  delete store.accounts[codexSubscriptionKey(c.accounts[0])];
  store.accounts[codexSubscriptionKey(c.accounts[1])] = record('2026-09-14', 'renews'); save();
  assert.equal(c.pick(), 0);
  writeFileSync(file, '{corrupt'); assert.equal(c.pick(), 0);
  rmSync(file); assert.equal(c.pick(), 0);
});
test('Codex pins, disablement, policy, cooldown/quota eligibility, and per-request exclusions win', () => {
  const c = codex();
  c.params.pinnedIndex = 0; assert.equal(c.pick(), 0);
  c.params.pinnedIndex = null;
  c.accounts[1].enabled = false; assert.equal(c.pick(), 0);
  c.accounts[1].enabled = true;
  c.blocked.add(1); assert.equal(c.pick(), 0); c.blocked.clear();
  c.params.attemptedIndexes.add(1); assert.equal(c.pick(), 0); c.params.attemptedIndexes.clear();
  c.params.policy = { blockedAccountIndexes: new Set([1]) }; assert.equal(c.pick(), 0);
  c.params.policy = null; assert.equal(c.pick(), 1);
  c.accounts.forEach(a => { a.enabled = false; }); assert.equal(c.pick(), undefined);
});

function claude(distributeSessions = false) {
  const am = new AccountManager(['a', 'b', 'c'].map(name => ({ name, type: 'oauth', accessToken: 'fixture', expiresAt: days(1) })), 1, { distributeSessions, ramp: { enabled: false } });
  for (const a of am.accounts) {
    a.probing = false;
    a.quota = { ...a.quota, unified5h: 0.1, unified7d: 0.2, unified7dFable: 0.2,
      unified5hReset: days(0.1), unified7dReset: days(5), unified7dFableReset: days(5) };
  }
  store.accounts['claude:b'] = record(); save();
  return am;
}
test('Claude preempts an existing account next request and preserves same-date stickiness', () => {
  const am = claude();
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'b');
  store.accounts['claude:a'] = record(); save();
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'b');
  store.accounts['claude:a'] = record('2026-09-13'); save();
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'a');
});
test('Claude exhausted Fable, disabled, excluded, cooldown and operator priority keep their semantics', () => {
  const am = claude(); const b = am.accounts[1];
  b.quota.unified7dFable = 1;
  assert.notEqual(am.getActiveAccount(null, 'claude-fable-5').name, 'b');
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'b');
  b.disabled = true; assert.notEqual(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'b');
  b.disabled = false;
  assert.notEqual(am.getActiveAccount(new Set([1]), 'claude-sonnet-4-6').name, 'b');
  b.status = 'throttled'; b.rateLimitedUntil = days(1); assert.notEqual(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'b');
  b.status = 'active'; b.rateLimitedUntil = null;
  am.accounts[0].priority = -1;
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6').name, 'a');
});
test('Claude distributed session affinity moves only for a strictly earlier final-window date', () => {
  const am = claude(true);
  am.recordSession('existing', 0);
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6', null, 'existing').name, 'b');
  am.recordSession('existing', 1);
  store.accounts['claude:a'] = record(); save();
  assert.equal(am.getActiveAccount(null, 'claude-sonnet-4-6', null, 'existing').name, 'b');
});
test('Claude future weekly reset before end, malformed metadata and all disabled retain ordinary fallback', () => {
  const am = claude(); am.accounts[1].quota.unified7dReset = days(1);
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-6').name, 'a');
  writeFileSync(file, '{broken');
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-6').name, 'a');
  am.accounts.forEach(a => { a.disabled = true; });
  assert.equal(am.getActiveAccount(null, 'claude-opus-4-6'), null);
});
