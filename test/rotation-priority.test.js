import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Make an account "exhausted" so _selectNext skips it, isolating the priority sort.
function exhaust(am, idx) {
  am.accounts[idx].status = 'exhausted';
}

test('default priority (all 0) preserves the existing selection (first available)', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  // No quota known anywhere → weeklyReset is -Infinity for all, ties on priority 0,
  // so the first available account is chosen, matching pre-priority behavior.
  const next = am._selectNext();
  assert.equal(next.name, 'a');
});

test('lower priority value is preferred over config order', () => {
  const am = new AccountManager([
    oauth('a', { priority: 5 }),
    oauth('b', { priority: 1 }),
    oauth('c', { priority: 3 }),
  ], 0.98);
  assert.equal(am._selectNext().name, 'b');
});

test('within the same priority, the existing heuristic breaks the tie', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 0 }),
  ], 0.98);
  // Give both a known weekly reset; the sooner-expiring one should win the tie.
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 1000;
  assert.equal(am._selectNext().name, 'b');
});

test('an exact weekly tie goes to the account whose 5-hour window resets sooner', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  const [a, b, c] = am.accounts;
  // a and b reset their weekly window at the same moment; b's 5-hour window
  // resets first, so its session quota is the one about to lapse.
  a.quota.unified7dReset = now + 3 * 86400_000;
  a.quota.unified5h = 0.3; a.quota.unified5hReset = now + 4 * 3600_000;
  b.quota.unified7dReset = now + 3 * 86400_000;
  b.quota.unified5h = 0.3; b.quota.unified5hReset = now + 3600_000;
  // c's 5-hour window resets soonest of all, but its weekly one resets later:
  // the 5-hour reset only breaks a weekly tie, it never outranks the weekly.
  c.quota.unified7dReset = now + 5 * 86400_000;
  c.quota.unified5h = 0.3; c.quota.unified5hReset = now + 600_000;
  // Config order alone picks a. Comparing 5-hour resets without the weekly tie
  // (or ranking them ahead of the weekly) picks c.
  assert.equal(am._selectNext().name, 'b');
});

test('on an exact weekly tie, an account with no 5-hour window open goes after one that has', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('c'), oauth('d'), oauth('b')], 0.98);
  const [a, , d, b] = am.accounts;
  for (const acc of am.accounts) acc.quota.unified7dReset = now + 3 * 86400_000;
  // None of a, c, d has session quota about to lapse. c never opened a window;
  // a's has already reset; d holds a reset that has passed with no reading
  // beside it, which nothing clears, so the ranking must not take it as soonest.
  a.quota.unified5h = 0.9; a.quota.unified5hReset = now - 60_000;
  d.quota.unified5hReset = now - 60_000;
  // b's window is open and ends in two hours.
  b.quota.unified5h = 0.5; b.quota.unified5hReset = now + 2 * 3600_000;
  assert.equal(am._selectNext().name, 'b');
});

test('with no weekly reset known, the 5-hour reset breaks no tie and config order decides', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  // Neither weekly reset is known, so both sort first to be probed. b has a
  // 5-hour window open and a does not; the probe-first order stays as it was.
  am.accounts[1].quota.unified5h = 0.3;
  am.accounts[1].quota.unified5hReset = now + 3600_000;
  assert.equal(am._selectNext().name, 'a');
});

test('the 5-hour reset never outranks priority', () => {
  const now = Date.now();
  // a comes first, so a 5-hour key compared without the priority guard would
  // replace it with b on b's sooner window.
  const am = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })], 0.98);
  const [a, b] = am.accounts;
  for (const acc of am.accounts) acc.quota.unified7dReset = now + 3 * 86400_000;
  a.quota.unified5h = 0.3; a.quota.unified5hReset = now + 4 * 3600_000;
  b.quota.unified5h = 0.3; b.quota.unified5hReset = now + 600_000;
  assert.equal(am._selectNext().name, 'a');
});

test('the 5-hour reset never outranks expiry pressure', () => {
  const fleet = (usedA, usedB) => {
    const now = Date.now();
    const am = new AccountManager([oauth('a'), oauth('b')], 0.98, { expiryRouting: { enabled: true } });
    const [a, b] = am.accounts;
    // The same weekly reset, so pressure differs only by weekly headroom; both
    // stay inside the default band, so b is a candidate either way.
    a.quota.unified7d = usedA; a.quota.unified7dReset = now + 3 * 86400_000;
    b.quota.unified7d = usedB; b.quota.unified7dReset = now + 3 * 86400_000;
    a.quota.unified5h = 0.3; a.quota.unified5hReset = now + 4 * 3600_000;
    b.quota.unified5h = 0.3; b.quota.unified5hReset = now + 600_000;
    return am;
  };
  // Equal pressure: the tie reaches the 5-hour reset, and b's is sooner.
  assert.equal(fleet(0.2, 0.2)._selectNext().name, 'b');
  // a holds more weekly headroom against the same clock, so it has the higher
  // pressure and wins before the 5-hour reset is read.
  assert.equal(fleet(0.2, 0.3)._selectNext().name, 'a');
});

test('priority is respected even when a higher-priority account is also available', () => {
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: -1 }), // most preferred
    oauth('c', { priority: 10 }),
  ], 0.98);
  assert.equal(am._selectNext().name, 'b');
});

test('exhausted highest-priority account is skipped, next priority wins', () => {
  const am = new AccountManager([
    oauth('a', { priority: 1 }),
    oauth('b', { priority: 2 }),
  ], 0.98);
  exhaust(am, 0);
  assert.equal(am._selectNext().name, 'b');
});

test('getActiveAccount preempts a healthy current account for a higher-priority one', () => {
  const am = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 1 })], 0.98);
  am.currentIndex = 1; // currently on the lower-priority account
  assert.equal(am.getActiveAccount().name, 'a');
  assert.equal(am.currentIndex, 0);
});

test('getActiveAccount stays sticky within the same priority tier (no thrash)', () => {
  const am = new AccountManager([oauth('a', { priority: 0 }), oauth('b', { priority: 0 })], 0.98);
  am.currentIndex = 0;
  // b has a sooner weekly reset, but same priority → must NOT switch away from a.
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 1000;
  assert.equal(am.getActiveAccount().name, 'a');
  assert.equal(am.currentIndex, 0);
});

test('common case: all-equal priority leaves getActiveAccount on the healthy current account', () => {
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  am.currentIndex = 2;
  assert.equal(am.getActiveAccount().name, 'c'); // unchanged — no preemption when priorities tie
});

// ── selectActiveAccount (daemon-launch up-front selection) ───────────────────

test('selectActiveAccount picks the soonest-resetting weekly window, not index 0', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b'), oauth('c')], 0.98);
  // All same priority and available; b's weekly resets soonest → spend it first.
  am.accounts[0].quota.unified7d = 0.5; am.accounts[0].quota.unified7dReset = now + 5 * 86400_000;
  am.accounts[1].quota.unified7d = 0.5; am.accounts[1].quota.unified7dReset = now + 1 * 86400_000;
  am.accounts[2].quota.unified7d = 0.5; am.accounts[2].quota.unified7dReset = now + 3 * 86400_000;
  const chosen = am.selectActiveAccount();
  assert.equal(chosen.name, 'b');
  assert.equal(am.currentIndex, 1); // currentIndex actually moved off 0
});

test('selectActiveAccount honors priority over the weekly heuristic', () => {
  const now = Date.now();
  const am = new AccountManager([
    oauth('a', { priority: 0 }),
    oauth('b', { priority: 1 }), // higher-priority value = less preferred
  ], 0.98);
  // b resets sooner, but a has the better (lower) priority value → a wins.
  am.accounts[0].quota.unified7d = 0.5; am.accounts[0].quota.unified7dReset = now + 5 * 86400_000;
  am.accounts[1].quota.unified7d = 0.5; am.accounts[1].quota.unified7dReset = now + 1 * 86400_000;
  assert.equal(am.selectActiveAccount().name, 'a');
});

test('selectActiveAccount skips an account already over the weekly threshold', () => {
  const now = Date.now();
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].quota.unified7d = 0.99; am.accounts[0].quota.unified7dReset = now + 86400_000; // near-exhausted
  am.accounts[1].quota.unified7d = 0.10; am.accounts[1].quota.unified7dReset = now + 5 * 86400_000;
  assert.equal(am.selectActiveAccount().name, 'b');
});

test('selectActiveAccount restores onto the best account after an export → restore cycle', () => {
  const now = Date.now();
  const am1 = new AccountManager([
    oauth('a', { accountUuid: 'p1' }),
    oauth('b', { accountUuid: 'p2' }),
  ], 0.98);
  am1.accounts[0].quota.unified7d = 0.8; am1.accounts[0].quota.unified7dReset = now + 6 * 86400_000;
  am1.accounts[1].quota.unified7d = 0.2; am1.accounts[1].quota.unified7dReset = now + 2 * 86400_000;

  const am2 = new AccountManager([
    oauth('a', { accountUuid: 'p1' }),
    oauth('b', { accountUuid: 'p2' }),
  ], 0.98);
  am2.restoreQuotaState(am1.exportQuotaState());
  // b's weekly resets sooner → start there, mirroring a real daemon launch.
  assert.equal(am2.selectActiveAccount().name, 'b');
});

test('selectActiveAccount leaves current account when none are available', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].status = 'exhausted';
  am.accounts[1].disabled = true;
  am.currentIndex = 1;
  const chosen = am.selectActiveAccount();
  assert.equal(chosen.name, 'b');   // falls back to the existing current account
  assert.equal(am.currentIndex, 1); // unchanged
});
