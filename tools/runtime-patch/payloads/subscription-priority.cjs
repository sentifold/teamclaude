#!/usr/bin/env node
"use strict";
// Identical staged-package patch published in both router forks and dotfiles.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [root, provider] = process.argv.slice(2);
const check = process.argv.includes('--check');
if (!root || !path.isAbsolute(root) || !['codex', 'claude'].includes(provider)) throw Error('absolute package root and provider required');
const marker = '// Managed routers r25: subscription final-week preference';
const codex = provider === 'codex';
const file = path.join(root, codex ? 'dist/lib/runtime/rotation-account-selection.js' : 'src/account-manager.js');
const helperFile = path.join(path.dirname(file), 'subscription-priority.mjs');
const helper = fs.readFileSync(path.join(__dirname, 'subscription-priority.mjs'), 'utf8');
const original = fs.readFileSync(file, 'utf8');
let next = original;
function replace(before, after) {
  if (next.split(before).length !== 2) throw Error(`unsupported ${provider} layout: ${before.slice(0, 70)}`);
  next = next.replace(before, after);
}
if (!original.includes(marker)) {
  if (check) throw Error('subscription priority missing');
  if (codex) {
    next = `${marker}\nimport { chooseSubscriptionAccount } from './subscription-priority.mjs';\nimport { getQuotaCachePath } from '../quota-cache.js';\n` + next;
    replace('    // Sequential / drain-first mode', `    const subscriptionAccount = chooseSubscriptionAccount(params, getQuotaCachePath());
    if (subscriptionAccount) {
        accountManager.markSwitched(subscriptionAccount, "rotation", family);
        return subscriptionAccount;
    }
    // Sequential / drain-first mode`);
  } else {
    next = `${marker}\nimport { readSubscriptionPriority, subscriptionRank } from './subscription-priority.mjs';\n` + next;
    replace(`        const betterExists = this.accounts.some(a =>
          this._isAvailable(a, model, advisorModel) && !exclude?.has(a.index) && (a.priority || 0) < (pinned.priority || 0));`,
      '        const betterExists = this._preemptedBy(pinned, model, advisorModel, exclude);');
    replace('  _preemptedBy(account, model = null, advisorModel = null, exclude = null) {', `  _subscriptionRanks(model) {
    const store = readSubscriptionPriority();
    const now = Date.now();
    return new Map(this.accounts.map(a => [a.index,
      subscriptionRank(store, 'claude:' + a.name, this._governingWeeklyReset(a, model), now)]));
  }

  _subscriptionExclusions(exclude, model, advisorModel) {
    const available = this.accounts.filter(a => !exclude?.has(a.index) && this._isAvailable(a, model, advisorModel));
    const priority = Math.min(...available.map(a => a.priority || 0));
    const ranks = this._subscriptionRanks(model);
    const peers = available.filter(a => (a.priority || 0) === priority);
    const best = Math.min(...peers.map(a => ranks.get(a.index)));
    if (!Number.isFinite(best)) return exclude;
    return new Set([...(exclude || []), ...peers.filter(a => ranks.get(a.index) > best).map(a => a.index)]);
  }

  _preemptedBy(account, model = null, advisorModel = null, exclude = null) {
    const ranks = this._subscriptionRanks(model);`);
    replace('      && (a.priority || 0) < (account.priority || 0)) || null;', `      && ((a.priority || 0) < (account.priority || 0) ||
          ((a.priority || 0) === (account.priority || 0) && ranks.get(a.index) < ranks.get(account.index)))) || null;`);
    for (const method of ['_pickBestAvailable', '_pickLeastLoaded']) {
      const anchor = `  ${method}(exclude = null, model = null, advisorModel = null) {`;
      replace(anchor, anchor + '\n    exclude = this._subscriptionExclusions(exclude, model, advisorModel);');
    }
  }
} else {
  const required = codex ? ['chooseSubscriptionAccount(params, getQuotaCachePath())', 'return subscriptionAccount;'] :
    ['_subscriptionRanks(model)', 'this._subscriptionExclusions(exclude, model, advisorModel)', 'ranks.get(a.index) < ranks.get(account.index)'];
  if (required.some(value => !next.includes(value))) throw Error('incomplete subscription priority');
}
if (check) {
  if (fs.readFileSync(helperFile, 'utf8') !== helper) throw Error('subscription helper drift');
} else {
  const temporary = `${file}.${process.pid}.tmp.js`;
  fs.writeFileSync(temporary, next, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, ['--check', temporary], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr);
    fs.writeFileSync(helperFile, helper, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}
process.stdout.write(`${provider}: subscription final-week preference verified\n`);
