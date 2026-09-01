import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function oauth(name, extra = {}) {
  return { name, type: 'oauth', accessToken: 't-' + name, refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra };
}

// Selection order 3.5: with equal priority AND an equal governing weekly reset,
// the shared 5-hour reset breaks the tie — the account whose session window
// refreshes soonest is closest to a clean slate, so spend it first.
test('equal weekly resets are tie-broken by the sooner 5-hour reset', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 5000;
  am.accounts[0].quota.unified5hReset = 4000;
  am.accounts[1].quota.unified5hReset = 2000;
  assert.equal(am._selectNext().name, 'b');
});

// An unknown 5-hour reset sorts first (like the weekly heuristic): using the
// account is what discovers its window, so probing must not lose the tie.
test('unknown 5-hour reset wins the tie so it can be probed', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.accounts[0].quota.unified7dReset = 5000;
  am.accounts[1].quota.unified7dReset = 5000;
  am.accounts[0].quota.unified5hReset = 2000;
  // b's 5-hour reset is unknown.
  assert.equal(am._selectNext().name, 'b');
});

// A session-window reset on a benched account must NOT preempt the current one:
// proactive switching discards the active conversation's provider-side prompt
// cache. The refreshed account becomes eligible and wins the next real
// selection instead.
test('a session quota reset does not switch away from a healthy current account', () => {
  const am = new AccountManager([oauth('a'), oauth('b')], 0.98);
  am.currentIndex = 0;

  // Current account: healthy, weekly window known and further out.
  am.accounts[0].quota.unified7d = 0.5;
  am.accounts[0].quota.unified7dReset = Date.now() + 3600_000;

  // Benched account: its 5-hour bucket just expired, and its weekly window
  // resets sooner — exactly the shape that used to trigger a proactive switch.
  am.accounts[1].quota.unified5h = 0.99;
  am.accounts[1].quota.unified5hReset = Date.now() - 10;
  am.accounts[1].quota.unified7d = 0.1;
  am.accounts[1].quota.unified7dReset = Date.now() + 1800_000;

  const changed = am.refreshExpiredQuotas();
  assert.equal(changed, true, 'the expired session window must still be cleared');
  assert.equal(am.currentIndex, 0, 'the healthy current account keeps the conversation');

  // Once selection is genuinely required, the refreshed account is eligible
  // again and wins on its sooner weekly reset.
  am.accounts[0].status = 'exhausted';
  assert.equal(am.getActiveAccount().name, 'b');
});
