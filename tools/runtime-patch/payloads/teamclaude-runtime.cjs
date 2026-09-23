const fs = require("node:fs");

// Runtime policy patch for @karpeleslab/teamclaude 1.1.21. Every change is
// anchored on an exact, unique source layout and refuses to guess otherwise.

const accountManagerPath = process.env.ROUTER_TEAMCLAUDE_ACCOUNT_MANAGER_FILE;
const marker = "TeamClaude local policy: break weekly-reset ties by the 5-hour reset";
const stickinessMarker = "TeamClaude local policy: keep the current account across quota-window resets";
let source = fs.readFileSync(accountManagerPath, "utf8");

function replaceUnique(needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error("unsupported TeamClaude account selection layout; refusing an unsafe patch");
  }
  source = source.slice(0, first) + replacement + source.slice(first + needle.length);
}

if (!source.includes(marker)) {
  // Selection order stays upstream's (priority, expiry pressure, governing
  // weekly reset); only an exact tie on all three is broken by the account
  // whose shared 5-hour window resets first.
  replaceUnique(
    "    let bestPriority = Infinity;\n    let bestPressure = Infinity;\n    let bestReset = Infinity;\n",
    [
      "    let bestPriority = Infinity;",
      "    let bestPressure = Infinity;",
      "    let bestReset = Infinity;",
      `    // ${marker}.`,
      "    let bestSessionReset = Infinity;",
      "",
    ].join("\n"),
  );
  replaceUnique(
    "      const weeklyReset = this._rankedReset(account, model);\n",
    [
      "      const weeklyReset = this._rankedReset(account, model);",
      "      const sessionReset = account.quota.unified5hReset || -Infinity;",
      "",
    ].join("\n"),
  );
  replaceUnique(
    "          || (priority === bestPriority && pressure === bestPressure && weeklyReset < bestReset)) {\n",
    [
      "          || (priority === bestPriority && pressure === bestPressure && weeklyReset < bestReset)",
      "          || (priority === bestPriority && pressure === bestPressure &&",
      "            weeklyReset === bestReset && sessionReset < bestSessionReset)) {",
      "",
    ].join("\n"),
  );
  replaceUnique(
    "        bestReset = weeklyReset;\n        best = account;\n",
    "        bestReset = weeklyReset;\n        bestSessionReset = sessionReset;\n        best = account;\n",
  );
  fs.writeFileSync(accountManagerPath, source);
}

if (!source.includes(stickinessMarker)) {
  // The reset events are still consumed exactly as upstream consumes them; only
  // the proactive cursor move they used to trigger is gone.
  replaceUnique(
    [
      "    if (sessionReset.length) {",
      "      this._switchOnSessionReset(sessionReset, this.expiryRouting.enabled ? model : null, scope, adv);",
      "    }",
      "",
    ].join("\n"),
    [
      `    // ${stickinessMarker}.`,
      "    // Re-rank by reset windows only when selection is actually required;",
      "    // proactive switching discards the active conversation's prompt cache.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(accountManagerPath, source);
}

if (!source.includes(marker) ||
    !source.includes(stickinessMarker) ||
    !source.includes("weeklyReset === bestReset && sessionReset < bestSessionReset") ||
    !source.includes("bestSessionReset = sessionReset;") ||
    source.includes("this._switchOnSessionReset(sessionReset,")) {
  throw new Error("TeamClaude weekly-then-session reset policy patch is incomplete");
}

const serverPath = process.env.ROUTER_TEAMCLAUDE_SERVER_FILE;
const retryMarker = "TeamClaude local policy: hide bounded transient retries across the usable pool";
const legacyTransportMarker = "TeamClaude local policy: transport failures never rotate accounts";
let serverSource = fs.readFileSync(serverPath, "utf8");

function replaceServerUnique(needle, replacement) {
  const first = serverSource.indexOf(needle);
  if (first < 0 || serverSource.indexOf(needle, first + needle.length) >= 0) {
    throw new Error("unsupported TeamClaude transport-error layout; refusing an unsafe patch");
  }
  serverSource = serverSource.slice(0, first) + replacement + serverSource.slice(first + needle.length);
}

function replaceServerRangeUnique(startNeedle, endNeedle, replacement) {
  const first = serverSource.indexOf(startNeedle);
  const second = first < 0 ? -1 : serverSource.indexOf(startNeedle, first + startNeedle.length);
  const end = first < 0 ? -1 : serverSource.indexOf(endNeedle, first + startNeedle.length);
  if (first < 0 || second >= 0 || end < 0 ||
      serverSource.indexOf(endNeedle, end + endNeedle.length) >= 0) {
    throw new Error("unsupported TeamClaude retry-policy layout; refusing an unsafe patch");
  }
  serverSource = serverSource.slice(0, first) + replacement + serverSource.slice(end);
}

if (serverSource.includes(legacyTransportMarker)) {
  throw new Error("legacy TeamClaude transport policy on a 1.1.21 package; reinstall the pristine package");
}

if (!serverSource.includes(retryMarker)) {
  replaceServerUnique(
    "const CONNECTION_SPECIFIC_HEADERS = new Set([\n" +
      "  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',\n" +
      "  'proxy-connection', 'te', 'trailer',\n" +
      "]);\n",
    [
      "const CONNECTION_SPECIFIC_HEADERS = new Set([",
      "  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',",
      "  'proxy-connection', 'te', 'trailer',",
      "]);",
      "",
      `// ${retryMarker}.`,
      "// Replaces upstream's 429/5xx one-hop failovers, its 2 s headerless-429",
      "// retry and its inline 429 absorb, so the two policies never stack.",
      "const MANAGED_SAME_ACCOUNT_RETRIES = 2;",
      "const MANAGED_POOL_RETRY_ROUNDS = 2;",
      "const MANAGED_SHORT_429_MAX_MS = 15_000;",
      "const MANAGED_BACKOFF_BASE_MS = 250;",
      "const MANAGED_BACKOFF_MAX_MS = 2_000;",
      "const MANAGED_POOL_WAIT_MAX_MS = 15_000;",
      "const MANAGED_RETRY_DEADLINE_MS = 120_000;",
      "// A quota window's reset can be days away. Clients treat retry-after as a",
      "// back-off, so the surfaced header is capped; the real horizon is only named",
      "// in the message.",
      "const MANAGED_SURFACED_RETRY_AFTER_MAX_S = 60;",
      "const MANAGED_RETRYABLE_STATUSES = new Set([408, 425, 500, 502, 503, 504, 529]);",
      "",
      "function managedRetryAfterMs(response) {",
      "  const value = response.headers.get('retry-after');",
      "  if (!value) return null;",
      "  const seconds = Number(value);",
      "  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);",
      "  const at = Date.parse(value);",
      "  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;",
      "}",
      "",
      "function managedBackoffMs(retryOrdinal) {",
      "  const base = Math.min(MANAGED_BACKOFF_BASE_MS * (2 ** Math.max(0, retryOrdinal - 1)), MANAGED_BACKOFF_MAX_MS);",
      "  const jitterMax = Math.min(100, Math.floor(base / 5));",
      "  return base + Math.floor(Math.random() * (jitterMax + 1));",
      "}",
      "",
      "function managedMonotonicMs(ctx) {",
      "  return typeof ctx?.managedNow === 'function'",
      "    ? ctx.managedNow() : Number(process.hrtime.bigint() / 1_000_000n);",
      "}",
      "",
      "function managedRemainingMs(ctx) {",
      "  return Math.max(0, ctx.managedRetryDeadlineAt - managedMonotonicMs(ctx));",
      "}",
      "",
      "function managedDeadlineExpired(ctx) {",
      "  return managedRemainingMs(ctx) <= 0;",
      "}",
      "",
      "function managedCancellationError(message, code) {",
      "  const error = new Error(message);",
      "  error.code = code;",
      "  return error;",
      "}",
      "",
      "function managedClientLeft(res, ctx) {",
      "  return clientGone(res) ||",
      "    ctx.managedLifecycle?.signal.reason?.code === 'TEAMCLAUDE_CLIENT_GONE';",
      "}",
      "",
      "// One AbortSignal per request: the client leaving (the listener's own",
      "// ctx.signal, or the response closing before it ended) or the shared retry",
      "// deadline. It replaces ctx.signal on the upstream call, so a departure still",
      "// cancels the upstream request mid-body exactly as upstream intends.",
      "function managedEnsureLifecycle(res, ctx) {",
      "  if (ctx.managedLifecycle) return ctx.managedLifecycle;",
      "  const controller = new AbortController();",
      "  let timer = null;",
      "  const stopDeadline = () => {",
      "    if (timer) clearTimeout(timer);",
      "    timer = null;",
      "  };",
      "  const detach = () => {",
      "    stopDeadline();",
      "    res.off('close', onClose);",
      "    res.off('finish', detach);",
      "    ctx.signal?.removeEventListener?.('abort', onClientAbort);",
      "  };",
      "  const abort = reason => {",
      "    if (!controller.signal.aborted) controller.abort(reason);",
      "    detach();",
      "  };",
      "  const onClientAbort = () => abort(ctx.signal?.reason || clientGoneError());",
      "  // A close after a normal end, or one the proxy caused itself, is no departure.",
      "  const onClose = () => {",
      "    if (!res.writableEnded && !ctx.proxyClosed) abort(clientGoneError());",
      "  };",
      "  res.once('close', onClose);",
      "  res.once('finish', detach);",
      "  ctx.signal?.addEventListener?.('abort', onClientAbort, { once: true });",
      "  const remaining = managedRemainingMs(ctx);",
      "  if (ctx.signal?.aborted) onClientAbort();",
      "  else if (clientGone(res)) abort(clientGoneError());",
      "  else if (!(remaining > 0)) abort(managedCancellationError(",
      "    'managed retry deadline exhausted', 'TEAMCLAUDE_MANAGED_DEADLINE'));",
      "  else {",
      "    timer = setTimeout(() => abort(managedCancellationError(",
      "      'managed retry deadline exhausted', 'TEAMCLAUDE_MANAGED_DEADLINE')), remaining);",
      "    timer.unref?.();",
      "  }",
      "  ctx.managedLifecycle = { controller, signal: controller.signal, cleanup: stopDeadline, detach };",
      "  return ctx.managedLifecycle;",
      "}",
      "",
      "function managedAwaitLifecycle(promise, ctx, onAbort = () => undefined) {",
      "  const signal = ctx.managedLifecycle?.signal;",
      "  if (!signal) return promise;",
      "  promise.catch?.(() => {});",
      "  return new Promise((resolve, reject) => {",
      "    let settled = false;",
      "    const finish = (fn, value) => {",
      "      if (settled) return;",
      "      settled = true;",
      "      signal.removeEventListener('abort', abort);",
      "      fn(value);",
      "    };",
      "    const abort = () => {",
      "      try { Promise.resolve(onAbort()).catch(() => {}); } catch { /* best effort */ }",
      "      finish(reject, signal.reason || managedCancellationError(",
      "        'managed request cancelled', 'TEAMCLAUDE_MANAGED_CANCELLED'));",
      "    };",
      "    if (signal.aborted) { abort(); return; }",
      "    signal.addEventListener('abort', abort, { once: true });",
      "    promise.then(value => finish(resolve, value), error => finish(reject, error));",
      "  });",
      "}",
      "",
      "async function managedAwaitAccountOperation(operation, res, ctx) {",
      "  try {",
      "    await managedAwaitLifecycle(Promise.resolve(operation), ctx);",
      "    return true;",
      "  } catch (error) {",
      "    if (!ctx.managedLifecycle?.signal.aborted) throw error;",
      "    if (managedClientLeft(res, ctx)) { ctx.abandoned = true; return false; }",
      "    const failure = managedDeadlineFailure();",
      "    ctx.managedLastFailure = failure;",
      "    ctx.status = failure.status;",
      "    managedWriteFailure(res, failure);",
      "    return false;",
      "  }",
      "}",
      "",
      "function managedSleep(ms, res, ctx) {",
      "  const remaining = managedRemainingMs(ctx);",
      "  const signal = ctx.managedLifecycle?.signal;",
      "  if (!(ms > 0)) return Promise.resolve(!clientGone(res) && !signal?.aborted && remaining > 0);",
      "  if (clientGone(res) || signal?.aborted) return Promise.resolve(false);",
      "  const boundedMs = Math.min(ms, remaining);",
      "  if (!(boundedMs > 0)) return Promise.resolve(false);",
      "  return new Promise(resolve => {",
      "    let timer = null;",
      "    let settled = false;",
      "    const finish = ok => {",
      "      if (settled) return;",
      "      settled = true;",
      "      if (timer) clearTimeout(timer);",
      "      signal?.removeEventListener('abort', onAbort);",
      "      resolve(ok);",
      "    };",
      "    const onAbort = () => finish(false);",
      "    signal?.addEventListener('abort', onAbort, { once: true });",
      "    if (clientGone(res) || signal?.aborted) { finish(false); return; }",
      "    timer = setTimeout(() => finish(!clientGone(res) && !signal?.aborted && !managedDeadlineExpired(ctx)), boundedMs);",
      "    timer.unref?.();",
      "  });",
      "}",
      "",
      "// Write the deadline answer after a wait was cut short, unless the client left.",
      "function managedEndInterruptedWait(res, ctx) {",
      "  if (managedClientLeft(res, ctx)) { ctx.abandoned = true; return; }",
      "  ctx.managedLastFailure = managedDeadlineFailure();",
      "  ctx.status = ctx.managedLastFailure.status;",
      "  managedWriteFailure(res, ctx.managedLastFailure);",
      "}",
      "",
      "function managedPoolWaitMs(ctx, accountManager) {",
      "  const now = Date.now();",
      "  const monotonicNow = managedMonotonicMs(ctx);",
      "  const waits = [];",
      "  for (const notBefore of ctx.managedRetryNotBefore.values()) {",
      "    if (notBefore > monotonicNow) waits.push(notBefore - monotonicNow);",
      "  }",
      "  for (const account of accountManager.accounts) {",
      "    const quota = account.quota || {};",
      "    const threshold = bucket => typeof accountManager.thresholdFor === 'function'",
      "      ? accountManager.thresholdFor(bucket, account) : (accountManager.switchThreshold ?? 0.98);",
      "    const quotaResets = [",
      "      quota.unified5h >= threshold('unified5h') ? quota.unified5hReset : null,",
      "      quota.unified7d >= threshold('unified7d') ? quota.unified7dReset : null,",
      "      quota.unified7dSonnet >= threshold('unified7dSonnet') ? quota.unified7dSonnetReset : null,",
      "      quota.unified7dFable >= threshold('unified7dFable') ? quota.unified7dFableReset : null,",
      "      (quota.tokensLimit > 0 && quota.tokensRemaining / quota.tokensLimit <= 1 - threshold('tokens')) ? quota.resetsAt : null,",
      "      (quota.requestsLimit > 0 && quota.requestsRemaining / quota.requestsLimit <= 1 - threshold('requests')) ? quota.resetsAt : null,",
      "    ];",
      "    for (const reset of [account.pausedUntil, account.rateLimitedUntil, ...quotaResets]) {",
      "      const at = typeof reset === 'number' ? reset : Date.parse(reset);",
      "      if (Number.isFinite(at) && at > now) waits.push(at - now);",
      "    }",
      "  }",
      "  const floor = managedBackoffMs(MANAGED_SAME_ACCOUNT_RETRIES + (ctx.managedPoolRetryRounds || 0) + 1);",
      "  const target = waits.length ? Math.max(floor, Math.min(...waits)) : floor;",
      "  const remaining = managedRemainingMs(ctx);",
      "  return target <= MANAGED_POOL_WAIT_MAX_MS && target < remaining ? target : null;",
      "}",
      "",
      "function managedHasRetryableCandidate(ctx, accountManager) {",
      "  return accountManager.accounts.some(account =>",
      "    !ctx.managedPermanentTried.has(account.index) && !account.disabled &&",
      "    account.status !== 'error' && account.status !== 'exhausted' &&",
      "    canServeProvider(account, ctx.provider || DEFAULT_PROVIDER));",
      "}",
      "",
      "function managedResetPoolPass(ctx) {",
      "  ctx.tried.clear();",
      "  for (const index of ctx.managedPermanentTried) ctx.tried.add(index);",
      "  const now = managedMonotonicMs(ctx);",
      "  for (const [index, notBefore] of ctx.managedRetryNotBefore) {",
      "    if (notBefore > now) ctx.tried.add(index);",
      "  }",
      "}",
      "",
      "// The account a hidden same-account retry asked for, while it can still serve.",
      "function managedRetryAccount(ctx, accountManager) {",
      "  const index = ctx.managedRetryAccountIndex;",
      "  ctx.managedRetryAccountIndex = null;",
      "  if (index == null || ctx.pinnedIndex != null) return null;",
      "  const account = accountManager.accounts[index];",
      "  if (!account || ctx.tried.has(index)) return null;",
      "  if (account.disabled || account.status === 'error' || account.status === 'exhausted' ||",
      "      account.status === 'throttled' || accountManager.capExceeded(account, ctx.model) ||",
      "      (ctx.managedRetryNotBefore.get(index) || 0) > managedMonotonicMs(ctx)) {",
      "    ctx.tried.add(index);",
      "    return null;",
      "  }",
      "  return account;",
      "}",
      "",
      "function managedErrorSignal(body) {",
      "  try {",
      "    const value = JSON.parse(body.toString('utf8'));",
      "    const error = value?.error || value;",
      "    return [value?.type, value?.code, error?.type, error?.code, error?.message]",
      "      .filter(v => typeof v === 'string').join(' ').toLowerCase();",
      "  } catch {",
      "    return '';",
      "  }",
      "}",
      "",
      "function managedQuotaOrBillingKind(status, rateLimitHeaders, body) {",
      "  if (status === 429) {",
      "    const spentCodexWindows = codexSpentWindows(rateLimitHeaders);",
      "    if (rateLimitHeaders['anthropic-ratelimit-unified-5h-status'] === 'rejected' ||",
      "        rateLimitHeaders['anthropic-ratelimit-unified-7d-status'] === 'rejected' ||",
      "        spentCodexWindows.some(isAccountWideCodexWindow)) return 'general-quota';",
      "    if (rateLimitHeaders['anthropic-ratelimit-unified-7d_oi-status'] === 'rejected') return 'model-quota';",
      "    // A spent Codex family window is model-scoped: this request moves, the account stays.",
      "    if (spentCodexWindows.length) return 'unknown-quota';",
      "  }",
      "  if (![400, 402, 403, 429].includes(status)) return false;",
      "  const signal = managedErrorSignal(body);",
      "  if (/(?:billing[_ -]?error|credit balance|spend(?:ing)? limit|subscription expired)/.test(signal)) return 'billing';",
      "  return /(?:insufficient[_ -]?quota|quota[_ -]?(?:exceeded|exhausted)|usage limit (?:has been )?(?:reached|exceeded)|subscription limit)/.test(signal)",
      "    ? 'unknown-quota' : null;",
      "}",
      "",
      "function managedPersistModelQuota(account, rateLimitHeaders, retryAfterMs) {",
      "  const quota = account.quota || (account.quota = {});",
      "  const now = Date.now();",
      "  const exactSeconds = Number(rateLimitHeaders['anthropic-ratelimit-unified-7d_oi-reset']);",
      "  const exactReset = Number.isFinite(exactSeconds) && exactSeconds * 1000 > now",
      "    ? Math.trunc(exactSeconds * 1000) : null;",
      "  const existingReset = Number.isFinite(quota.unified7dFableReset) && quota.unified7dFableReset > now",
      "    ? quota.unified7dFableReset : null;",
      "  const sharedReset = Number.isFinite(quota.unified7dReset) && quota.unified7dReset > now",
      "    ? quota.unified7dReset : null;",
      "  const fallbackReset = now + Math.max(Number.isFinite(retryAfterMs) && retryAfterMs > 0",
      "    ? retryAfterMs : 60_000, 1_000);",
      "  quota.unified7dFable = Math.max(Number(quota.unified7dFable) || 0, 1);",
      "  quota.unified7dFableReset = exactReset || existingReset || sharedReset || fallbackReset;",
      "  quota.unified7dFableSeenAt = now;",
      "}",
      "",
      "function managedResponseHeaders(response) {",
      "  const headers = {};",
      "  for (const [key, value] of response.headers.entries()) {",
      "    if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;",
      "    if (key === 'content-encoding' || key === 'content-length') continue;",
      "    headers[key] = value;",
      "  }",
      "  return headers;",
      "}",
      "",
      "// Bounded like upstream's readErrorBody: a hostile or broken upstream must not",
      "// make the proxy buffer an arbitrary error body, and an oversized body is",
      "// never classified. Its status alone decides; the client gets a stand-in.",
      "async function managedCaptureFailure(response, retryAfterMs = null, ctx) {",
      "  const chunks = [];",
      "  let length = 0;",
      "  let oversized = false;",
      "  if (response.body) {",
      "    const reader = response.body.getReader();",
      "    try {",
      "      for (;;) {",
      "        const { done, value } = await managedAwaitLifecycle(",
      "          reader.read(), ctx, () => reader.cancel());",
      "        if (done) break;",
      "        length += value.byteLength;",
      "        if (length > ERROR_BODY_INSPECTION_LIMIT) {",
      "          oversized = true;",
      "          await reader.cancel().catch(() => {});",
      "          break;",
      "        }",
      "        chunks.push(Buffer.from(value));",
      "      }",
      "    } finally {",
      "      try { reader.releaseLock(); } catch { /* already released/cancelled */ }",
      "    }",
      "  }",
      "  if (oversized) {",
      "    return {",
      "      status: response.status,",
      "      headers: { 'Content-Type': 'application/json' },",
      "      body: Buffer.from(JSON.stringify({ type: 'error', error: { type: 'api_error',",
      "        message: `Upstream ${response.status} error body exceeded ${ERROR_BODY_INSPECTION_LIMIT} bytes and was not relayed.` } })),",
      "      retryAfterMs,",
      "    };",
      "  }",
      "  const body = Buffer.concat(chunks);",
      "  return { status: response.status, headers: managedResponseHeaders(response), body, retryAfterMs };",
      "}",
      "",
      "function managedTransportFailure() {",
      "  return {",
      "    status: 502,",
      "    headers: { 'Content-Type': 'application/json' },",
      "    body: Buffer.from(JSON.stringify({",
      "      type: 'error',",
      "      error: { type: 'proxy_error', message: 'Managed upstream transport failed after exhausting the usable account pool.' },",
      "    })),",
      "  };",
      "}",
      "",
      "function managedDeadlineFailure() {",
      "  return {",
      "    status: 504,",
      "    headers: { 'Content-Type': 'application/json' },",
      "    body: Buffer.from(JSON.stringify({",
      "      type: 'error',",
      "      error: { type: 'timeout_error', message: 'Managed upstream retry deadline exhausted.' },",
      "    })),",
      "  };",
      "}",
      "",
      "function managedCredentialFailure() {",
      "  return {",
      "    status: 502,",
      "    headers: { 'Content-Type': 'application/json' },",
      "    body: Buffer.from(JSON.stringify({",
      "      type: 'error',",
      "      error: { type: 'proxy_error', message: 'Managed upstream credentials were unavailable across the usable account pool.' },",
      "    })),",
      "  };",
      "}",
      "",
      "// `detail` is upstream's own exhaustion sentence (#168, #407): which model,",
      "// how many accounts, who needs a re-login, when the window resets.",
      "function managedCapacityFailure(source = null, detail = null) {",
      "  const headers = { 'Content-Type': 'application/json' };",
      "  let message = 'Managed upstream capacity remained unavailable after exhausting the usable account pool.';",
      "  const seconds = Number.isFinite(source?.retryAfterMs) && source.retryAfterMs > 0",
      "    ? Math.max(1, Math.ceil(source.retryAfterMs / 1000)) : 0;",
      "  if (seconds) headers['retry-after'] = String(Math.min(seconds, MANAGED_SURFACED_RETRY_AFTER_MAX_S));",
      "  if (detail) message += ` ${detail}`;",
      "  else if (seconds > MANAGED_SURFACED_RETRY_AFTER_MAX_S) message += ` Earliest known recovery in ${formatWait(seconds)}.`;",
      "  return {",
      "    status: 503,",
      "    headers,",
      "    body: Buffer.from(JSON.stringify({",
      "      type: 'error',",
      "      error: { type: 'overloaded_error', message },",
      "    })),",
      "  };",
      "}",
      "",
      "function managedTerminalFailure(failure, detail = null) {",
      "  if (failure?.status === 401 || failure?.status === 403) return managedCredentialFailure();",
      "  if (!failure || failure.status === 429) return managedCapacityFailure(failure, detail);",
      "  return failure;",
      "}",
      "",
      "function managedWriteFailure(res, failure) {",
      "  if (clientGone(res)) return;",
      "  if (res.headersSent) {",
      "    if (!res.writableEnded) res.destroy();",
      "    return;",
      "  }",
      "  const headers = { ...failure.headers };",
      "  const retryAfter = Number(headers['retry-after']);",
      "  if (Number.isFinite(retryAfter) && retryAfter > MANAGED_SURFACED_RETRY_AFTER_MAX_S) {",
      "    headers['retry-after'] = String(MANAGED_SURFACED_RETRY_AFTER_MAX_S);",
      "  }",
      "  res.writeHead(failure.status, headers);",
      "  res.end(failure.body);",
      "}",
      "",
    ].join("\n") + "\n",
  );

  replaceServerUnique(
    "  const maxRetries = accountManager.accounts.length;\n",
    [
      "  ctx.managedSameAccountRetries ??= new Map();",
      "  ctx.managedFrozenRequests ??= new Map();",
      "  ctx.managedPermanentTried ??= new Set();",
      "  ctx.managedRetryNotBefore ??= new Map();",
      "  ctx.managedRetryAccountIndex ??= null;",
      "  ctx.managedLastFailure ??= null;",
      "  ctx.managedRetryDeadlineAt ??= managedMonotonicMs(ctx) + MANAGED_RETRY_DEADLINE_MS;",
      "  const managedLifecycle = managedEnsureLifecycle(res, ctx);",
      "  if (managedDeadlineExpired(ctx) || managedLifecycle.signal.aborted) {",
      "    if (managedClientLeft(res, ctx)) { ctx.abandoned = true; return; }",
      "    const failure = managedDeadlineFailure();",
      "    ctx.managedLastFailure = failure;",
      "    ctx.status = failure.status;",
      "    managedWriteFailure(res, failure);",
      "    return;",
      "  }",
      "",
    ].join("\n"),
  );

  // A hidden same-account retry is an explicit one-shot preference, consumed
  // here. It rides upstream's own hop slot, so it bypasses selection exactly as
  // a detour must: no cursor move, no resting observation (#286).
  replaceServerUnique(
    "  const hopTo = ctx.hopTo ?? null;\n  ctx.hopTo = null;\n",
    [
      "  const managedRetry = managedRetryAccount(ctx, accountManager);",
      "  const hopTo = ctx.hopTo ?? managedRetry?.index ?? null;",
      "  ctx.hopTo = null;",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "      return;\n    }\n    // A pinned request concerns exactly one account: don't compute a fleet-wide\n",
    [
      "      return;",
      "    }",
      "    // A retryable failure is surfaced only after selection proves there is no",
      "    // other usable account left. Pinned calls may retry their one account,",
      "    // but must never enter a pool round or leak to another account. The",
      "    // fleet-exhausted 429 below (whose retry-after is now the real quota",
      "    // reset, possibly days) is never sent: the answer is a capped 503.",
      "    const managedCandidates = candidateAccounts(accountManager, ctx.model, ctx.provider);",
      "    // No failure yet means the fleet was exhausted before any attempt: carry",
      "    // upstream's own wait, still capped on the way out.",
      "    ctx.managedLastFailure ||= {",
      "      status: 429,",
      "      retryAfterMs: computeRetryAfter(accountManager, managedCandidates, ctx.model) * 1000,",
      "    };",
      "    if (ctx.managedLastFailure) {",
      "      const poolRound = ctx.managedPoolRetryRounds || 0;",
      "      const waitMs = managedPoolWaitMs(ctx, accountManager);",
      "      if (ctx.pinnedIndex == null &&",
      "          managedHasRetryableCandidate(ctx, accountManager) &&",
      "          poolRound < MANAGED_POOL_RETRY_ROUNDS && waitMs != null) {",
      "        ctx.managedPoolRetryRounds = poolRound + 1;",
      "        console.log(`[TeamClaude] Usable pool exhausted — hidden pool retry ${poolRound + 1}/${MANAGED_POOL_RETRY_ROUNDS} in ${waitMs}ms`);",
      "        if (!await managedSleep(waitMs, res, ctx)) {",
      "          managedEndInterruptedWait(res, ctx);",
      "          return;",
      "        }",
      "        managedResetPoolPass(ctx);",
      "        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "      }",
      "      const managedWaitSeconds = Math.max(0, Math.ceil((ctx.managedLastFailure.retryAfterMs || 0) / 1000));",
      "      const terminalFailure = managedTerminalFailure(ctx.managedLastFailure,",
      "        exhaustedMessage(managedCandidates, ctx.model, managedWaitSeconds));",
      "      ctx.status = terminalFailure.status;",
      "      ctx.account = '(managed retry pool exhausted)';",
      "      managedWriteFailure(res, terminalFailure);",
      "      return;",
      "    }",
      "    // A pinned request concerns exactly one account: don't compute a fleet-wide",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "  await accountManager.ensureTokenFresh(account.index);\n" +
      "  if (account.status === 'error' && retryCount < maxRetries) {\n" +
      "    ctx.tried.add(account.index);\n",
    [
      "  if (!await managedAwaitAccountOperation(accountManager.ensureTokenFresh(account.index), res, ctx)) return;",
      "  if (account.status === 'error') {",
      "    (ctx.credentialRejected ??= new Set()).add(account.name);",
      "    ctx.managedPermanentTried.add(account.index);",
      "    ctx.tried.add(account.index);",
      "",
    ].join("\n"),
  );

  // Freeze the rewritten body per account before its first upstream attempt, so
  // every retry and pool round on that account replays the exact bytes. Header
  // values are rebuilt from the same client request; only authentication can
  // change. Cross-account failover is a cold-cache boundary by definition.
  replaceServerUnique(
    "  let sendBody = rewriteRequestBody(body, account, req.url, req.headers['content-type']);\n",
    [
      "  if (!ctx.managedFrozenRequests.has(account.index)) {",
      "    ctx.managedFrozenRequests.set(account.index, Object.freeze({",
      "      body: rewriteRequestBody(body, account, req.url, req.headers['content-type']),",
      "    }));",
      "  }",
      "  let sendBody = ctx.managedFrozenRequests.get(account.index).body;",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "  // Streaming request log, opened lazily on the first terminal outcome (a\n",
    [
      "  const retryManagedFailure = async (failure, retryAfterMs = null, minWaitMs = 0) => {",
      "    failure.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;",
      "    ctx.managedLastFailure = failure;",
      "    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {",
      "      ctx.managedRetryNotBefore.set(account.index, managedMonotonicMs(ctx) + retryAfterMs);",
      "    }",
      "    const completed = ctx.managedSameAccountRetries.get(account.index) || 0;",
      "    const remaining = managedRemainingMs(ctx);",
      "    const retryAfterIsShort = retryAfterMs == null ||",
      "      (retryAfterMs <= MANAGED_SHORT_429_MAX_MS && retryAfterMs < remaining);",
      "    if (completed < MANAGED_SAME_ACCOUNT_RETRIES && retryAfterIsShort &&",
      "        !res.headersSent && !clientGone(res) && remaining > 0) {",
      "      const next = completed + 1;",
      "      ctx.managedSameAccountRetries.set(account.index, next);",
      "      ctx.managedRetryAccountIndex = account.index;",
      "      const waitMs = Math.max(retryAfterMs == null ? managedBackoffMs(next) : retryAfterMs, minWaitMs);",
      "      console.log(`[TeamClaude] Retryable upstream failure on \"${account.name}\" — hidden retry ${next}/${MANAGED_SAME_ACCOUNT_RETRIES} in ${waitMs}ms`);",
      "      if (!await managedSleep(waitMs, res, ctx)) {",
      "        managedEndInterruptedWait(res, ctx);",
      "        return;",
      "      }",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "    ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);",
      "    ctx.managedRetryAccountIndex = null;",
      "    ctx.tried.add(account.index);",
      "    if (clientGone(res)) { ctx.abandoned = true; return; }",
      "    if (res.headersSent) {",
      "      if (!res.writableEnded) { ctx.proxyClosed = true; res.destroy(); }",
      "      return;",
      "    }",
      "    // A transient failure detours this request; it is not a fleet decision,",
      "    // so the alternate is picked without moving the cursor (#286).",
      "    if (ctx.pinnedIndex == null) {",
      "      const alternate = accountManager.pickAlternate(",
      "        new Set([...ctx.tried, ...(ctx.rolledOff || [])]), ctx.model, ctx.advisorModel, ctx.provider);",
      "      if (alternate && !ctx.tried.has(alternate.index)) ctx.hopTo = alternate.index;",
      "    }",
      "    console.log(`[TeamClaude] Retry budget exhausted on \"${account.name}\" — trying another usable account`);",
      "    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "  };",
      "",
      "  // Streaming request log, opened lazily on the first terminal outcome (a",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "    if (!await accountManager.admit(account.index, () => clientGone(res))) { ctx.abandoned = true; return; }\n",
    [
      "    if (!await accountManager.admit(account.index,",
      "        () => clientGone(res) || managedLifecycle.signal.aborted || managedDeadlineExpired(ctx))) {",
      "      managedEndInterruptedWait(res, ctx);",
      "      return;",
      "    }",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "    if (ctx.pinnedIndex == null && retryCount < maxRetries && accountManager.isEntitlementDenied(account.index)) {\n" +
      "      accountManager.release(account.index, { successful: false });\n" +
      "      ctx.tried.add(account.index);\n",
    [
      "    if (ctx.pinnedIndex == null && accountManager.isEntitlementDenied(account.index)) {",
      "      accountManager.release(account.index, { successful: false });",
      "      ctx.managedPermanentTried.add(account.index);",
      "      ctx.tried.add(account.index);",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "        signal: ctx.signal,\n",
    "        signal: managedLifecycle.signal,\n",
  );

  // Upstream's 429 block (quota rotation, rate-limit pause, one idle-sibling
  // hop, the 2 s headerless retry, the inline absorb), its one-hop 5xx failover
  // and its 403 handler are replaced as one unit by the managed classification.
  replaceServerRangeUnique(
    "    // Two kinds of 429 are handled differently below: a quota rejection rotates\n",
    "    if (upstreamRes.status === 401 && account.type === 'oauth' && account.refreshToken\n",
    [
      "    // Buffer only statuses whose structured body can identify account-specific",
      "    // quota/billing. TeamClaude's fetch shim has a single-consumer body (no",
      "    // Response.clone), so permanent errors are relayed from this exact capture.",
      "    const managedRetryAfter = managedRetryAfterMs(upstreamRes);",
      "    const managedErrorFailure = [400, 402, 403, 429].includes(upstreamRes.status)",
      "      ? await managedCaptureFailure(upstreamRes, managedRetryAfter, ctx) : null;",
      "    const quotaOrBillingKind = managedQuotaOrBillingKind(",
      "      upstreamRes.status, rateLimitHeaders, managedErrorFailure?.body || Buffer.alloc(0));",
      "",
      "    if (quotaOrBillingKind && !res.headersSent) {",
      "      ctx.managedLastFailure = managedErrorFailure;",
      "      if (quotaOrBillingKind === 'model-quota') {",
      "        managedPersistModelQuota(account, rateLimitHeaders, managedRetryAfter);",
      "      } else if (quotaOrBillingKind === 'general-quota' || quotaOrBillingKind === 'billing') {",
      "        const holdSeconds = Math.min(Math.max(Math.ceil((managedRetryAfter ?? 3_600_000) / 1000), 1), 3600);",
      "        accountManager.markRateLimited(account.index, holdSeconds);",
      "      }",
      "      ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);",
      "      ctx.managedPermanentTried.add(account.index);",
      "      ctx.tried.add(account.index);",
      "      console.log(`[TeamClaude] Confirmed quota/billing rejection on \"${account.name}\" — switching account`);",
      "      if (clientGone(res)) { ctx.abandoned = true; return; }",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    // A 403 is upstream refusing THIS account; the client cannot act on it and",
      "    // would drop its own login over it. Fail over; entitlement denials also",
      "    // start upstream's rotation cooldown.",
      "    if (upstreamRes.status === 403 && !res.headersSent) {",
      "      ctx.managedLastFailure = managedErrorFailure;",
      "      const entitlementDenied = account.type === 'oauth' && isOAuthEntitlementDenied(managedErrorFailure.body);",
      "      const deniedUntil = entitlementDenied ? accountManager.markEntitlementDenied(account.index) : null;",
      "      (ctx.credentialRejected ??= new Set()).add(account.name);",
      "      if (entitlementDenied) (ctx.entitlementDenied ??= new Set()).add(account.name);",
      "      ctx.managedPermanentTried.add(account.index);",
      "      ctx.tried.add(account.index);",
      "      const cooldown = deniedUntil ? `; OAuth entitlement cooldown until ${new Date(deniedUntil).toISOString()}` : '';",
      "      console.error(`[TeamClaude] 403 on \"${account.name}\"; upstream refused the account credential${cooldown}`);",
      "      if (clientGone(res)) { ctx.abandoned = true; return; }",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    if ([400, 402].includes(upstreamRes.status)) {",
      "      ctx.status = upstreamRes.status;",
      "      ctx.delivered = true;   // a 4xx IS an answer — see answeredStatus",
      "      managedWriteFailure(res, managedErrorFailure);",
      "      return;",
      "    }",
      "",
      "    if (upstreamRes.status === 429) {",
      "      const retryAfterMs = managedRetryAfter;",
      "      const failure = managedErrorFailure;",
      "      // No retry-after and no rate-limit headers: the refusal is about the",
      "      // request, not the account (#288). Never pause the account for it, and",
      "      // re-ask no sooner than upstream's measured headerless-429 delay.",
      "      const requestScoped = upstreamRes.headers.get('retry-after') == null &&",
      "        Object.keys(rateLimitHeaders).length === 0;",
      "      const nextUseSx = !!(sx?.useOn429());",
      "      const switchingToSx = nextUseSx && !route && !ctx.managedSxRetryUsed;",
      "      if (!requestScoped) sx?.noteRateLimited(Math.max(1, Math.ceil((retryAfterMs ?? 1_000) / 1000)));",
      "      if (switchingToSx) {",
      "        ctx.managedSxRetryUsed = true;",
      "        ctx.managedSameAccountRetries.set(account.index,",
      "          (ctx.managedSameAccountRetries.get(account.index) || 0) + 1);",
      "        ctx.managedRetryAccountIndex = account.index;",
      "        console.log(`[TeamClaude] 429 on \"${account.name}\" — one immediate same-account retry via sx.org`);",
      "        if (clientGone(res) || managedLifecycle.signal.aborted) { managedEndInterruptedWait(res, ctx); return; }",
      "        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, true);",
      "      }",
      "      const shortThrottle = retryAfterMs == null || retryAfterMs <= MANAGED_SHORT_429_MAX_MS;",
      "      if (shortThrottle) {",
      "        if (!requestScoped) {",
      "          const pauseMs = retryAfterMs ?? managedBackoffMs((ctx.managedSameAccountRetries.get(account.index) || 0) + 1);",
      "          // The retry helper waits once; pauseAccount applies the same boundary",
      "          // to concurrent requests and releases them through the normal ramp.",
      "          accountManager.pauseAccount(account.index, pauseMs / 1000, admittedLoad);",
      "        }",
      "        return retryManagedFailure(failure, retryAfterMs,",
      "          requestScoped ? resolveHeaderless429RetryDelayMs() : 0);",
      "      }",
      "      accountManager.markRateLimited(account.index, Math.min(Math.max(Math.ceil(retryAfterMs / 1000), 1), 3600));",
      "      ctx.managedLastFailure = failure;",
      "      ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);",
      "      ctx.tried.add(account.index);",
      "      console.log(`[TeamClaude] Long 429 on \"${account.name}\" — switching account without exposing it to Claude`);",
      "      if (clientGone(res)) { ctx.abandoned = true; return; }",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    if (MANAGED_RETRYABLE_STATUSES.has(upstreamRes.status)) {",
      "      const retryAfterMs = managedRetryAfterMs(upstreamRes);",
      "      const failure = await managedCaptureFailure(upstreamRes, retryAfterMs, ctx);",
      "      return retryManagedFailure(failure, retryAfterMs);",
      "    }",
      "",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "        && retryCount < maxRetries && !ctx.reauthed.has(account.index)) {\n",
    "        && !ctx.reauthed.has(account.index)) {\n",
  );

  replaceServerUnique(
    "      await accountManager.ensureTokenFresh(account.index, true);\n",
    "      if (!await managedAwaitAccountOperation(accountManager.ensureTokenFresh(account.index, true), res, ctx)) return;\n",
  );

  replaceServerUnique(
    "      (ctx.credentialRejected ??= new Set()).add(account.name);\n" +
      "      ctx.tried.add(account.index);\n" +
      "      console.error(`[TeamClaude] 401 on \"${safeLine(account.name, 64)}\"; failing over to another account`);\n",
    [
      "      (ctx.credentialRejected ??= new Set()).add(account.name);",
      "      ctx.managedLastFailure = managedCredentialFailure();",
      "      ctx.managedPermanentTried.add(account.index);",
      "      ctx.tried.add(account.index);",
      "      console.error(`[TeamClaude] 401 on \"${safeLine(account.name, 64)}\"; failing over to another account`);",
      "",
    ].join("\n"),
  );

  replaceServerUnique(
    "    // Log the request head (once) followed by the response headers, streaming\n",
    [
      "    // The retry deadline ends when a terminal response is accepted. Long",
      "    // successful SSE streams keep their existing body-idle watchdog and",
      "    // must not be aborted merely because they outlive the retry window.",
      "    managedLifecycle.cleanup();",
      "",
      "    // Log the request head (once) followed by the response headers, streaming",
      "",
    ].join("\n"),
  );

  replaceServerRangeUnique(
    "    // Would failing over dial anywhere else? Only an untried account pointing at\n",
    "  }\n}\n\n// Idle deadline for the RESPONSE BODY",
    [
      "    if (managedLifecycle.signal.aborted) {",
      "      if (managedClientLeft(res, ctx)) { ctx.abandoned = true; return; }",
      "      const failure = managedDeadlineFailure();",
      "      ctx.managedLastFailure = failure;",
      "      ctx.status = failure.status;",
      "      managedWriteFailure(res, failure);",
      "      return;",
      "    }",
      "",
      "    // A thrown fetch/socket/TLS/timeout error is transport state, never proof",
      "    // that the request or account is bad. Hide bounded retries on the sticky",
      "    // account, then try every other usable account before surfacing failure.",
      "    if (!res.headersSent && !clientGone(res)) {",
      "      return retryManagedFailure(managedTransportFailure());",
      "    }",
      "    ctx.status = 502;",
      "    if (!res.writableEnded) {",
      "      ctx.proxyClosed = true;",
      "      res.destroy();",
      "    }",
      "",
    ].join("\n"),
  );

  fs.writeFileSync(serverPath, serverSource);
}

if (!serverSource.includes(retryMarker) ||
    !serverSource.includes("const MANAGED_BACKOFF_BASE_MS = 250;") ||
    !serverSource.includes("const MANAGED_RETRY_DEADLINE_MS = 120_000;") ||
    !serverSource.includes("signal: managedLifecycle.signal") ||
    !serverSource.includes("managedCaptureFailure(upstreamRes, managedRetryAfter, ctx)") ||
    !serverSource.includes("const terminalFailure = managedTerminalFailure(ctx.managedLastFailure,") ||
    !serverSource.includes("ctx.managedFrozenRequests.set(account.index, Object.freeze") ||
    !serverSource.includes("return retryManagedFailure(managedTransportFailure());") ||
    !serverSource.includes("Confirmed quota/billing rejection") ||
    !serverSource.includes("managedSameAccountRetries") ||
    serverSource.includes("const maxRetries = accountManager.accounts.length;") ||
    serverSource.includes("ctx.rateLimitHopped = true;") ||
    serverSource.includes("ctx.serverErrorHopped = true;") ||
    serverSource.includes("ctx.requestScopedRetried = true;") ||
    serverSource.includes("TEAMCLAUDE_MANAGED_RETRY_BASE_MS") ||
    serverSource.includes("TEAMCLAUDE_MANAGED_RETRY_DEADLINE_MS") ||
    serverSource.includes(legacyTransportMarker)) {
  throw new Error("TeamClaude hidden-retry policy patch is incomplete");
}

// Dropped in 1.1.21: upstream's directFetch composes the caller's signal with
// its headers timeout itself (#321). Refuse a layout that stops doing so.
const upstreamFetchPath = process.env.ROUTER_TEAMCLAUDE_UPSTREAM_FETCH_FILE;
const upstreamFetchSource = fs.readFileSync(upstreamFetchPath, "utf8");
if (!upstreamFetchSource.includes("const relay = () => ctrl.abort(caller.reason);") ||
    !upstreamFetchSource.includes("caller?.removeEventListener?.('abort', relay);")) {
  throw new Error("TeamClaude direct-fetch no longer relays the caller's abort signal");
}
