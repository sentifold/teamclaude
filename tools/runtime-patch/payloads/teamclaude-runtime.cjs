const fs = require("node:fs");

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
  replaceUnique(
    "    let bestPriority = Infinity;\n    let bestReset = Infinity;\n",
    [
      "    let bestPriority = Infinity;",
      "    let bestReset = Infinity;",
      `    // ${marker}.`,
      "    let bestSessionReset = Infinity;",
      "",
    ].join("\n"),
  );
  replaceUnique(
    "      const weeklyReset = this._governingWeeklyReset(account, model) || -Infinity;\n",
    [
      "      const weeklyReset = this._governingWeeklyReset(account, model) || -Infinity;",
      "      const sessionReset = account.quota.unified5hReset || -Infinity;",
      "",
    ].join("\n"),
  );
  replaceUnique(
    "      if (priority < bestPriority ||\n          (priority === bestPriority && weeklyReset < bestReset)) {\n",
    [
      "      if (priority < bestPriority ||",
      "          (priority === bestPriority &&",
      "           (weeklyReset < bestReset ||",
      "            (weeklyReset === bestReset && sessionReset < bestSessionReset)))) {",
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
  replaceUnique(
    "    if (sessionReset.length) this._switchOnSessionReset(sessionReset);\n",
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
    !source.includes("bestSessionReset = sessionReset;")) {
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
  const legacyTransportBlock = [
    `    // ${legacyTransportMarker}.`,
    "    // A thrown network/stream error says nothing about credentials or quota.",
    "    // Surface it on this request; the client's retry keeps account affinity",
    "    // and preserves the provider-side prompt cache.",
    "    ctx.status = 502;",
  ].join("\n");
  const legacyTlsLine = "        String(err.code || '').startsWith('ERR_SSL_'));";
  const markerFirst = serverSource.indexOf(legacyTransportBlock);
  const markerSecond = markerFirst < 0 ? -1 :
    serverSource.indexOf(legacyTransportBlock, markerFirst + legacyTransportBlock.length);
  const tlsFirst = serverSource.indexOf(legacyTlsLine);
  if (markerFirst < 0 || markerSecond >= 0 || tlsFirst < 0 ||
      serverSource.indexOf(legacyTlsLine, tlsFirst + legacyTlsLine.length) >= 0) {
    throw new Error("partial legacy TeamClaude transport policy; refusing an unsafe migration");
  }
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
      "const MANAGED_SAME_ACCOUNT_RETRIES = 2;",
      "const MANAGED_POOL_RETRY_ROUNDS = 2;",
      "const MANAGED_SHORT_429_MAX_MS = 15_000;",
      "const MANAGED_BACKOFF_BASE_MS = 250;",
      "const MANAGED_BACKOFF_MAX_MS = 2_000;",
      "const MANAGED_POOL_WAIT_MAX_MS = 15_000;",
      "const MANAGED_RETRY_DEADLINE_MS = 120_000;",
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
      "function managedEnsureLifecycle(res, ctx) {",
      "  if (ctx.managedLifecycle) return ctx.managedLifecycle;",
      "  const controller = new AbortController();",
      "  let timer = null;",
      "  let cleaned = false;",
      "  const cleanup = () => {",
      "    if (cleaned) return;",
      "    cleaned = true;",
      "    if (timer) clearTimeout(timer);",
      "    res.off('close', onClose);",
      "    res.off('finish', onFinish);",
      "  };",
      "  const abort = reason => {",
      "    if (!controller.signal.aborted) controller.abort(reason);",
      "    cleanup();",
      "  };",
      "  const onClose = () => abort(managedCancellationError(",
      "    'downstream client disconnected', 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED'));",
      "  const onFinish = () => cleanup();",
      "  const remaining = managedRemainingMs(ctx);",
      "  res.once('close', onClose);",
      "  res.once('finish', onFinish);",
      "  if (res.destroyed) onClose();",
      "  else if (!(remaining > 0)) abort(managedCancellationError(",
      "    'managed retry deadline exhausted', 'TEAMCLAUDE_MANAGED_DEADLINE'));",
      "  else {",
      "    timer = setTimeout(() => abort(managedCancellationError(",
      "      'managed retry deadline exhausted', 'TEAMCLAUDE_MANAGED_DEADLINE')), remaining);",
      "    timer.unref?.();",
      "  }",
      "  ctx.managedLifecycle = { controller, signal: controller.signal, cleanup };",
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
      "    const reason = ctx.managedLifecycle?.signal.reason;",
      "    if (!ctx.managedLifecycle?.signal.aborted) throw error;",
      "    if (res.destroyed || reason?.code === 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED') return false;",
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
      "  if (!(ms > 0)) return Promise.resolve(!res.destroyed && !signal?.aborted && remaining > 0);",
      "  if (res.destroyed || signal?.aborted) return Promise.resolve(false);",
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
      "    if (res.destroyed || signal?.aborted) { finish(false); return; }",
      "    timer = setTimeout(() => finish(!res.destroyed && !signal?.aborted && !managedDeadlineExpired(ctx)), boundedMs);",
      "    timer.unref?.();",
      "  });",
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
      "    const threshold = accountManager.switchThreshold ?? 0.98;",
      "    const quotaResets = [",
      "      quota.unified5h >= threshold ? quota.unified5hReset : null,",
      "      quota.unified7d >= threshold ? quota.unified7dReset : null,",
      "      quota.unified7dSonnet >= threshold ? quota.unified7dSonnetReset : null,",
      "      quota.unified7dFable >= threshold ? quota.unified7dFableReset : null,",
      "      (quota.tokensLimit > 0 && quota.tokensRemaining / quota.tokensLimit <= 1 - threshold) ? quota.resetsAt : null,",
      "      (quota.requestsLimit > 0 && quota.requestsRemaining / quota.requestsLimit <= 1 - threshold) ? quota.resetsAt : null,",
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
      "    account.status !== 'error' && account.status !== 'exhausted');",
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
      "  if (status === 429 && (",
      "      rateLimitHeaders['anthropic-ratelimit-unified-5h-status'] === 'rejected' ||",
      "      rateLimitHeaders['anthropic-ratelimit-unified-7d-status'] === 'rejected')) return 'general-quota';",
      "  if (status === 429 &&",
      "      rateLimitHeaders['anthropic-ratelimit-unified-7d_oi-status'] === 'rejected') return 'model-quota';",
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
      "async function managedCaptureFailure(response, retryAfterMs = null, ctx) {",
      "  const chunks = [];",
      "  if (response.body) {",
      "    const reader = response.body.getReader();",
      "    try {",
      "      for (;;) {",
      "        const { done, value } = await managedAwaitLifecycle(",
      "          reader.read(), ctx, () => reader.cancel());",
      "        if (done) break;",
      "        chunks.push(Buffer.from(value));",
      "      }",
      "    } finally {",
      "      try { reader.releaseLock(); } catch { /* already released/cancelled */ }",
      "    }",
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
      "function managedCapacityFailure(source = null) {",
      "  const headers = { 'Content-Type': 'application/json' };",
      "  if (Number.isFinite(source?.retryAfterMs) && source.retryAfterMs > 0) {",
      "    headers['retry-after'] = String(Math.max(1, Math.ceil(source.retryAfterMs / 1000)));",
      "  }",
      "  return {",
      "    status: 503,",
      "    headers,",
      "    body: Buffer.from(JSON.stringify({",
      "      type: 'error',",
      "      error: { type: 'overloaded_error', message: 'Managed upstream capacity remained unavailable after exhausting the usable account pool.' },",
      "    })),",
      "  };",
      "}",
      "",
      "function managedTerminalFailure(failure) {",
      "  if (failure?.status === 401 || failure?.status === 403) return managedCredentialFailure();",
      "  if (failure?.status === 429) return managedCapacityFailure(failure);",
      "  return failure || managedCapacityFailure();",
      "}",
      "",
      "function managedWriteFailure(res, failure) {",
      "  if (res.headersSent || res.destroyed) return;",
      "  res.writeHead(failure.status, failure.headers);",
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
      "    if (res.destroyed || managedLifecycle.signal.reason?.code === 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED') return;",
      "    const failure = managedDeadlineFailure();",
      "    ctx.managedLastFailure = failure;",
      "    ctx.status = failure.status;",
      "    managedWriteFailure(res, failure);",
      "    return;",
      "  }",
      "",
    ].join("\n"),
  );

  replaceServerRangeUnique(
    "  // Select account, skipping any already tried (and failed) this request.\n",
    "  if (!account) {\n    // Every candidate was refused by upstream (403). Waiting will not help — the\n",
    [
      "  // Select account, skipping any already tried (and failed) this request.",
      "  // A hidden same-account retry is an explicit one-shot preference. It is",
      "  // consumed here so any later recursion must deliberately request it again.",
      "  const managedRetryIndex = ctx.managedRetryAccountIndex;",
      "  ctx.managedRetryAccountIndex = null;",
      "  let account = managedRetryIndex == null ? null : accountManager.accounts[managedRetryIndex];",
      "  if (account && (ctx.tried.has(account.index) || account.disabled ||",
      "      account.status === 'error' || account.status === 'exhausted' || account.status === 'throttled' ||",
      "      (ctx.managedRetryNotBefore.get(account.index) || 0) > managedMonotonicMs(ctx))) {",
      "    ctx.tried.add(account.index);",
      "    account = null;",
      "  }",
      "  if (!account) {",
      "    // The model scopes availability so a spent model-family bucket does not",
      "    // unnecessarily remove an otherwise healthy account from the pool.",
      "    account = ctx.pinnedIndex != null",
      "      ? (ctx.tried.has(ctx.pinnedIndex) ? null : accountManager.accounts[ctx.pinnedIndex])",
      "      : accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId);",
      "  }",
    ].join("\n") + "\n",
  );

  replaceServerUnique(
    "  if (!account) {\n    // Every candidate was refused by upstream (403). Waiting will not help — the\n",
    [
      "  if (!account) {",
      "    // Every candidate was refused by upstream (403). Waiting will not help — the",
    ].join("\n"),
  );

  replaceServerUnique(
    "      return;\n    }\n    // A pinned request concerns exactly one account: don't compute a fleet-wide\n",
    [
      "      return;",
      "    }",
      "    // A retryable failure is surfaced only after selection proves there is no",
      "    // other usable account left. Pinned calls may retry their one account,",
      "    // but must never enter a pool round or leak to another account.",
      "    ctx.managedLastFailure ||= managedCapacityFailure();",
      "    if (ctx.managedLastFailure) {",
      "      const poolRound = ctx.managedPoolRetryRounds || 0;",
      "      const waitMs = managedPoolWaitMs(ctx, accountManager);",
      "      if (ctx.pinnedIndex == null &&",
      "          managedHasRetryableCandidate(ctx, accountManager) &&",
      "          poolRound < MANAGED_POOL_RETRY_ROUNDS && waitMs != null) {",
      "        ctx.managedPoolRetryRounds = poolRound + 1;",
      "        console.log(`[TeamClaude] Usable pool exhausted — hidden pool retry ${poolRound + 1}/${MANAGED_POOL_RETRY_ROUNDS} in ${waitMs}ms`);",
      "        if (!await managedSleep(waitMs, res, ctx)) {",
      "          if (!res.destroyed) {",
      "            ctx.managedLastFailure = managedDeadlineFailure();",
      "            managedWriteFailure(res, ctx.managedLastFailure);",
      "          }",
      "          return;",
      "        }",
      "        managedResetPoolPass(ctx);",
      "        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "      }",
      "      const terminalFailure = managedTerminalFailure(ctx.managedLastFailure);",
      "      ctx.status = terminalFailure.status;",
      "      ctx.account = '(managed retry pool exhausted)';",
      "      managedWriteFailure(res, terminalFailure);",
      "      return;",
      "    }",
      "    // A pinned request concerns exactly one account: don't compute a fleet-wide",
    ].join("\n"),
  );

  replaceServerUnique(
    "  await accountManager.ensureTokenFresh(account.index);\n",
    "  if (!await managedAwaitAccountOperation(accountManager.ensureTokenFresh(account.index), res, ctx)) return;\n",
  );

  replaceServerUnique(
    "  if (account.status === 'error' && retryCount < maxRetries) {\n    ctx.tried.add(account.index);\n",
    [
      "  if (account.status === 'error') {",
      "    (ctx.credentialRejected ??= new Set()).add(account.name);",
      "    ctx.managedPermanentTried.add(account.index);",
      "    ctx.tried.add(account.index);",
    ].join("\n") + "\n",
  );

  replaceServerUnique(
    "    if (!await accountManager.admit(account.index, () => res.destroyed)) return;\n",
    [
    "    if (!await accountManager.admit(account.index, () => res.destroyed || managedLifecycle.signal.aborted || managedDeadlineExpired(ctx))) {",
      "      if (!res.destroyed) {",
      "        ctx.managedLastFailure = managedDeadlineFailure();",
      "        ctx.status = ctx.managedLastFailure.status;",
      "        managedWriteFailure(res, ctx.managedLastFailure);",
      "      }",
      "      return;",
      "    }",
    ].join("\n") + "\n",
  );

  replaceServerRangeUnique(
    "  // Build upstream request headers\n",
    "  // Streaming request log, opened lazily on the first terminal outcome (a\n",
    [
      "  // Freeze one normalized request per account before its first upstream attempt.",
      "  // Every later retry/pool round on that account reuses the exact bytes and",
      "  // header values; only router-owned authentication changes. Cross-account",
      "  // failover may need that account's UUID/model map, while the prompt-cache",
      "  // content, history and tool ordering remain byte-for-byte stable per account.",
      "  if (!ctx.managedFrozenRequests.has(account.index)) {",
      "    const frozenHeaders = {};",
      "    for (const [key, value] of Object.entries(req.headers)) {",
      "      const lk = key.toLowerCase();",
      "      if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk)) continue;",
      "      if (lk === 'x-api-key' || lk === 'authorization' || lk === 'accept-encoding') continue;",
      "      frozenHeaders[key] = value;",
      "    }",
      "    let frozenBody = sanitizeToolPairs(body, req.url, req.headers['content-type']);",
      "    if (account.accountUuid) frozenBody = patchAccountUuid(frozenBody, account.accountUuid);",
      "    if (account.modelMap) frozenBody = rewriteModel(frozenBody, account.modelMap);",
      "    if (frozenBody !== body) frozenHeaders['content-length'] = String(frozenBody.length);",
      "    ctx.managedFrozenRequests.set(account.index, Object.freeze({",
      "      method: req.method,",
      "      body: frozenBody,",
      "      headers: Object.freeze({ ...frozenHeaders }),",
      "    }));",
      "  }",
      "",
      "  const managedFrozenRequest = ctx.managedFrozenRequests.get(account.index);",
      "  const method = managedFrozenRequest.method;",
      "  const sendBody = managedFrozenRequest.body;",
      "  const headers = { ...managedFrozenRequest.headers };",
      "  if (account.type === 'oauth') headers.authorization = `Bearer ${account.credential}`;",
      "  else headers['x-api-key'] = account.credential;",
      "  const upstreamUrl = `${account.upstream || upstream}${req.url}`;",
      "",
      "  const retryManagedFailure = async (failure, retryAfterMs = null) => {",
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
      "        !res.headersSent && !res.destroyed && remaining > 0) {",
      "      const next = completed + 1;",
      "      ctx.managedSameAccountRetries.set(account.index, next);",
      "      ctx.managedRetryAccountIndex = account.index;",
      "      const waitMs = retryAfterMs == null ? managedBackoffMs(next) : retryAfterMs;",
      "      console.log(`[TeamClaude] Retryable upstream failure on \"${account.name}\" — hidden retry ${next}/${MANAGED_SAME_ACCOUNT_RETRIES} in ${waitMs}ms`);",
      "      if (!await managedSleep(waitMs, res, ctx)) {",
      "        if (!res.destroyed) {",
      "          ctx.managedLastFailure = managedDeadlineFailure();",
      "          managedWriteFailure(res, ctx.managedLastFailure);",
      "        }",
      "        return;",
      "      }",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "    ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);",
      "    ctx.managedRetryAccountIndex = null;",
      "    ctx.tried.add(account.index);",
      "    if (res.headersSent || res.destroyed) {",
      "      if (!res.writableEnded) res.destroy();",
      "      return;",
      "    }",
      "    console.log(`[TeamClaude] Retry budget exhausted on \"${account.name}\" — trying another usable account`);",
      "    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "  };",
    ].join("\n") + "\n\n",
  );

  replaceServerUnique(
    "        redirect: 'manual',\n      }, sx, route);",
    [
      "        redirect: 'manual',",
      "        signal: managedLifecycle.signal,",
      "        headersTimeoutMs: Math.max(1, managedRemainingMs(ctx)),",
      "      }, sx, route);",
    ].join("\n"),
  );

  replaceServerRangeUnique(
    "    // Two kinds of 429 are handled differently below: a quota rejection rotates\n",
    "    // A 401 means the credential we injected was rejected. For an OAuth account\n",
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
      "      if (res.destroyed) return;",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    if (upstreamRes.status === 403 && !res.headersSent) {",
      "      ctx.managedLastFailure = managedErrorFailure;",
      "      (ctx.credentialRejected ??= new Set()).add(account.name);",
      "      ctx.managedPermanentTried.add(account.index);",
      "      ctx.tried.add(account.index);",
      "      console.error(`[TeamClaude] 403 on \"${account.name}\" — upstream refused the account credential`);",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    if ([400, 402].includes(upstreamRes.status)) {",
      "      ctx.status = upstreamRes.status;",
      "      managedWriteFailure(res, managedErrorFailure);",
      "      return;",
      "    }",
      "",
      "    if (upstreamRes.status === 429) {",
      "      const retryAfterMs = managedRetryAfter;",
      "      const failure = managedErrorFailure;",
      "      const nextUseSx = !!(sx?.useOn429());",
      "      const switchingToSx = nextUseSx && !route && !ctx.managedSxRetryUsed;",
      "      sx?.noteRateLimited(Math.max(1, Math.ceil((retryAfterMs ?? 1_000) / 1000)));",
      "      if (switchingToSx) {",
      "        ctx.managedSxRetryUsed = true;",
      "        ctx.managedSameAccountRetries.set(account.index,",
      "          (ctx.managedSameAccountRetries.get(account.index) || 0) + 1);",
      "        ctx.managedRetryAccountIndex = account.index;",
      "        console.log(`[TeamClaude] 429 on \"${account.name}\" — one immediate same-account retry via sx.org`);",
      "        if (res.destroyed || managedLifecycle.signal.aborted) return;",
      "        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, true);",
      "      }",
      "      const shortThrottle = retryAfterMs == null || retryAfterMs <= MANAGED_SHORT_429_MAX_MS;",
      "      if (shortThrottle) {",
      "        const pauseMs = retryAfterMs ?? managedBackoffMs((ctx.managedSameAccountRetries.get(account.index) || 0) + 1);",
      "        accountManager.pauseAccount(account.index, pauseMs / 1000);",
      "        // The retry helper waits once; pauseAccount applies the same boundary",
      "        // to concurrent requests and releases them through the normal ramp.",
      "        return retryManagedFailure(failure, retryAfterMs);",
      "      }",
      "      accountManager.markRateLimited(account.index, Math.min(Math.max(Math.ceil(retryAfterMs / 1000), 1), 3600));",
      "      ctx.managedLastFailure = failure;",
      "      ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);",
      "      ctx.tried.add(account.index);",
      "      console.log(`[TeamClaude] Long 429 on \"${account.name}\" — switching account without exposing it to Claude`);",
      "      if (res.destroyed) return;",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    if ([408, 425, 500, 502, 503, 504].includes(upstreamRes.status)) {",
      "      const retryAfterMs = managedRetryAfterMs(upstreamRes);",
      "      const failure = await managedCaptureFailure(upstreamRes, retryAfterMs, ctx);",
      "      return retryManagedFailure(failure, retryAfterMs);",
      "    }",
    ].join("\n") + "\n\n",
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
    "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);\n    }\n\n    // Log the request head (once) followed by the response headers, streaming\n",
    [
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    // A second injected-credential 401 is account-specific, not a client",
      "    // request error. Fail over without leaking it into Claude's login state.",
      "    if (upstreamRes.status === 401 && !res.headersSent) {",
      "      ctx.managedLastFailure = await managedCaptureFailure(upstreamRes, null, ctx);",
      "      (ctx.credentialRejected ??= new Set()).add(account.name);",
      "      ctx.managedPermanentTried.add(account.index);",
      "      ctx.tried.add(account.index);",
      "      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);",
      "    }",
      "",
      "    // The retry deadline ends when a terminal response is accepted. Long",
      "    // successful SSE streams keep their existing body-idle watchdog and",
      "    // must not be aborted merely because they outlive the retry window.",
      "    managedLifecycle.cleanup();",
      "",
      "    // Log the request head (once) followed by the response headers, streaming",
    ].join("\n") + "\n",
  );

  replaceServerRangeUnique(
    "    const isTransient = err instanceof Error &&\n",
    "  }\n}\n\n// Idle deadline for the RESPONSE BODY",
    [
      "    const managedAbortReason = managedLifecycle.signal.reason;",
      "    if (managedLifecycle.signal.aborted) {",
      "      if (res.destroyed || managedAbortReason?.code === 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED') return;",
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
      "    if (!res.headersSent && !res.destroyed) {",
      "      return retryManagedFailure(managedTransportFailure());",
      "    }",
      "    ctx.status = 502;",
      "    if (!res.writableEnded) res.destroy();",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(serverPath, serverSource);
}

const upstreamFetchPath = process.env.ROUTER_TEAMCLAUDE_UPSTREAM_FETCH_FILE;
const cancellationMarker = "TeamClaude local policy: compose managed cancellation with direct-fetch timeout";
let upstreamFetchSource = fs.readFileSync(upstreamFetchPath, "utf8");

if (!upstreamFetchSource.includes(cancellationMarker)) {
  const directFetchNeedle = [
    "function directFetch(url, opts, timeoutMs) {",
    "  const ctrl = new AbortController();",
    "  const timer = setTimeout(() => ctrl.abort(headersTimeoutError(timeoutMs)), timeoutMs);",
    "  timer.unref?.();",
    "  return fetch(url, { ...opts, signal: ctrl.signal }).then(",
    "    (res) => { clearTimeout(timer); return res; },",
    "    (err) => { clearTimeout(timer); throw err; },",
    "  );",
    "}",
  ].join("\n");
  const directFetchReplacement = [
    `// ${cancellationMarker}.`,
    "function directFetch(url, opts, timeoutMs) {",
    "  const ctrl = new AbortController();",
    "  const externalSignal = opts.signal;",
    "  const onExternalAbort = () => ctrl.abort(externalSignal.reason);",
    "  if (externalSignal?.aborted) onExternalAbort();",
    "  else externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });",
    "  const cleanup = () => {",
    "    clearTimeout(timer);",
    "    externalSignal?.removeEventListener?.('abort', onExternalAbort);",
    "  };",
    "  const timer = setTimeout(() => ctrl.abort(headersTimeoutError(timeoutMs)), timeoutMs);",
    "  timer.unref?.();",
    "  return fetch(url, { ...opts, signal: ctrl.signal }).then(",
    "    (res) => { cleanup(); return res; },",
    "    (err) => { cleanup(); throw err; },",
    "  );",
    "}",
  ].join("\n");
  const first = upstreamFetchSource.indexOf(directFetchNeedle);
  if (first < 0 || upstreamFetchSource.indexOf(directFetchNeedle, first + directFetchNeedle.length) >= 0) {
    throw new Error("unsupported TeamClaude direct-fetch cancellation layout; refusing an unsafe patch");
  }
  upstreamFetchSource = upstreamFetchSource.slice(0, first) + directFetchReplacement +
    upstreamFetchSource.slice(first + directFetchNeedle.length);
  fs.writeFileSync(upstreamFetchPath, upstreamFetchSource);
}

if (!serverSource.includes(retryMarker) ||
    !serverSource.includes("const MANAGED_BACKOFF_BASE_MS = 250;") ||
    !serverSource.includes("const MANAGED_RETRY_DEADLINE_MS = 120_000;") ||
    !serverSource.includes("signal: managedLifecycle.signal") ||
    !serverSource.includes("managedCaptureFailure(upstreamRes, managedRetryAfter, ctx)") ||
    !serverSource.includes("const terminalFailure = managedTerminalFailure(ctx.managedLastFailure);") ||
    !serverSource.includes("ctx.managedFrozenRequests.set(account.index, Object.freeze") ||
    !serverSource.includes("return retryManagedFailure(managedTransportFailure());") ||
    !serverSource.includes("Confirmed quota/billing rejection") ||
    !serverSource.includes("managedSameAccountRetries") ||
    serverSource.includes("TEAMCLAUDE_MANAGED_RETRY_BASE_MS") ||
    serverSource.includes("TEAMCLAUDE_MANAGED_RETRY_DEADLINE_MS") ||
    serverSource.includes("TeamClaude local policy: transport failures never rotate accounts")) {
  throw new Error("TeamClaude hidden-retry policy patch is incomplete");
}
if (!upstreamFetchSource.includes(cancellationMarker) ||
    !upstreamFetchSource.includes("const onExternalAbort = () => ctrl.abort(externalSignal.reason);") ||
    !upstreamFetchSource.includes("externalSignal?.removeEventListener?.('abort', onExternalAbort);")) {
  throw new Error("TeamClaude direct-fetch cancellation patch is incomplete");
}
