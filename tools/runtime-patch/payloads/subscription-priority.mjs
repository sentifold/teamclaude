// Shared by the two managed router backports. Billing dates are preferences,
// never evidence of entitlement or a reason to reject an otherwise usable pool.
import { openSync, fstatSync, readFileSync, closeSync, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DAY = 86_400_000;
export function readSmallJson(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readSubscriptionPriority() {
  const file = process.env.AGENT_ROUTER_SUBSCRIPTIONS_FILE ||
    join(homedir(), 'Library/Application Support/Router Limits/subscriptions.json');
  const value = readSmallJson(file);
  return value?.schemaVersion === 1 && value?.routingPolicy?.mode === 'final-week' ? value : null;
}

function localDay(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function subscriptionRank(store, key, weeklyReset, now = Date.now()) {
  const record = store?.accounts?.[key]?.manual;
  if (store?.routingPolicy?.mode !== 'final-week' || record?.kind !== 'ends' ||
      record?.source !== 'manual' || !Number.isFinite(record?.checkedAt) ||
      record.checkedAt > now + 300_000 || !/^20\d{2}-\d{2}-\d{2}$/.test(record.date)) return Infinity;
  const endDay = Date.parse(record.date);
  if (!Number.isFinite(endDay) || new Date(endDay).toISOString().slice(0, 10) !== record.date) return Infinity;
  const today = localDay(now);
  // Date-only UI evidence: keep the entire displayed day, never hard-expire it.
  if (endDay < today || endDay - today > 7 * DAY) return Infinity;
  // A known weekly reset before the end means another quota window remains.
  // Unknown/expired reset: conservatively use the last seven calendar days.
  if (Number.isFinite(weeklyReset) && weeklyReset > now &&
      localDay(weeklyReset) < endDay) return Infinity;
  return endDay;
}

export function codexSubscriptionKey(account) {
  // Match Router Limits' workspace-aware identity. No email fallback for an
  // enrolled account ID, and never copy credentials into the billing store.
  const identity = account.accountId ? `account:${account.accountId}` :
    `fallback:${account.email || ''}:${account.index}`;
  return `codex:${createHash('sha256').update(identity).digest('hex')}`;
}

export function codexWeeklyReset(cache, account, model, now) {
  const entry = account.accountId ? cache?.byAccountId?.[account.accountId] :
    cache?.byEmail?.[account.email?.trim().toLowerCase()];
  if (entry?.model !== model || entry.status !== 200 || !Number.isFinite(entry.updatedAt) ||
      entry.updatedAt > now + 300_000 || now - entry.updatedAt > 900_000) return null;
  return [entry.primary, entry.secondary].find(window =>
    window?.windowMinutes === 10080 && Number.isFinite(window.resetAtMs))?.resetAtMs ?? null;
}

export function chooseSubscriptionAccount(params, quotaPath) {
  const store = readSubscriptionPriority();
  if (!store) return null;
  const { accountManager, attemptedIndexes, policy, family, model, now } = params;
  const cache = readSmallJson(quotaPath);
  let bestRank = Infinity;
  let candidates = [];
  for (const account of accountManager.getAccountsSnapshot()) {
    if (account.enabled === false || attemptedIndexes.has(account.index) ||
        policy?.blockedAccountIndexes.has(account.index) ||
        accountManager.getAccountRuntimeSkipReason(account.index, family, model)) continue;
    const rank = subscriptionRank(store, codexSubscriptionKey(account), codexWeeklyReset(cache, account, model, now), now);
    if (rank < bestRank) { bestRank = rank; candidates = [account]; }
    else if (Number.isFinite(rank) && rank === bestRank) candidates.push(account);
  }
  if (!candidates.length) return null;
  const preferred = params.schedulingStrategy === 'sequential' ? null :
    params.sessionAffinityStore?.getPreferredAccountIndex(params.sessionKey, now);
  const current = accountManager.getCurrentAccountForFamily(family)?.index;
  const winner = candidates.find(a => a.index === preferred) ||
    candidates.find(a => a.index === current) || candidates[0];
  return accountManager.getAccountByIndex(winner.index);
}
