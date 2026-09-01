import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCerts, createConnectHandler } from './mitm.js';
import { patchAccountUuid } from './account-uuid-rewrite.js';
import { sanitizeToolPairs } from './tool-pair-sanitize.js';
import { parseRequestModel, parseAdvisorModel } from './account-manager.js';
import { TopLevelFieldFinder, modelGlobMatches } from './model.js';
import { BodyWriter } from './request-log.js';
import { upstreamFetch } from './upstream-fetch.js';
import { tunnelTls } from './sx.js';
import { createEgressGuard } from './egress-guard.js';


export const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
// Path prefix for the deprecated URL-based account pin (superseded by TC_ACCT).
const PIN_PREFIX = '/tc-acct/';
const INLINE_RETRY_AFTER_MAX_SECONDS = 15;

// Response header names that are connection-specific and thus illegal on an
// HTTP/2 response (Node's Http2ServerResponse.writeHead rejects them). Also
// hop-by-hop on h1, so stripping them is correct on both paths.
const CONNECTION_SPECIFIC_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-connection', 'te', 'trailer',
]);

// Hide bounded transient retries across the usable pool.
const MANAGED_SAME_ACCOUNT_RETRIES = 2;
const MANAGED_POOL_RETRY_ROUNDS = 2;
const MANAGED_SHORT_429_MAX_MS = 15_000;
const MANAGED_BACKOFF_BASE_MS = 250;
const MANAGED_BACKOFF_MAX_MS = 2_000;
const MANAGED_POOL_WAIT_MAX_MS = 15_000;
const MANAGED_RETRY_DEADLINE_MS = 120_000;

function managedRetryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function managedBackoffMs(retryOrdinal) {
  const base = Math.min(MANAGED_BACKOFF_BASE_MS * (2 ** Math.max(0, retryOrdinal - 1)), MANAGED_BACKOFF_MAX_MS);
  const jitterMax = Math.min(100, Math.floor(base / 5));
  return base + Math.floor(Math.random() * (jitterMax + 1));
}

function managedMonotonicMs(ctx) {
  return typeof ctx?.managedNow === 'function'
    ? ctx.managedNow() : Number(process.hrtime.bigint() / 1_000_000n);
}

function managedRemainingMs(ctx) {
  return Math.max(0, ctx.managedRetryDeadlineAt - managedMonotonicMs(ctx));
}

function managedDeadlineExpired(ctx) {
  return managedRemainingMs(ctx) <= 0;
}

function managedCancellationError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function managedEnsureLifecycle(res, ctx) {
  if (ctx.managedLifecycle) return ctx.managedLifecycle;
  const controller = new AbortController();
  let timer = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer) clearTimeout(timer);
    res.off('close', onClose);
    res.off('finish', onFinish);
  };
  const abort = reason => {
    if (!controller.signal.aborted) controller.abort(reason);
    cleanup();
  };
  const onClose = () => abort(managedCancellationError(
    'downstream client disconnected', 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED'));
  const onFinish = () => cleanup();
  const remaining = managedRemainingMs(ctx);
  res.once('close', onClose);
  res.once('finish', onFinish);
  if (res.destroyed) onClose();
  else if (!(remaining > 0)) abort(managedCancellationError(
    'managed retry deadline exhausted', 'TEAMCLAUDE_MANAGED_DEADLINE'));
  else {
    timer = setTimeout(() => abort(managedCancellationError(
      'managed retry deadline exhausted', 'TEAMCLAUDE_MANAGED_DEADLINE')), remaining);
    timer.unref?.();
  }
  ctx.managedLifecycle = { controller, signal: controller.signal, cleanup };
  return ctx.managedLifecycle;
}

function managedAwaitLifecycle(promise, ctx, onAbort = () => undefined) {
  const signal = ctx.managedLifecycle?.signal;
  if (!signal) return promise;
  promise.catch?.(() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => {
      try { Promise.resolve(onAbort()).catch(() => {}); } catch { /* best effort */ }
      finish(reject, signal.reason || managedCancellationError(
        'managed request cancelled', 'TEAMCLAUDE_MANAGED_CANCELLED'));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => finish(resolve, value), error => finish(reject, error));
  });
}

async function managedAwaitAccountOperation(operation, res, ctx) {
  try {
    await managedAwaitLifecycle(Promise.resolve(operation), ctx);
    return true;
  } catch (error) {
    const reason = ctx.managedLifecycle?.signal.reason;
    if (!ctx.managedLifecycle?.signal.aborted) throw error;
    if (res.destroyed || reason?.code === 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED') return false;
    const failure = managedDeadlineFailure();
    ctx.managedLastFailure = failure;
    ctx.status = failure.status;
    managedWriteFailure(res, failure);
    return false;
  }
}

function managedSleep(ms, res, ctx) {
  const remaining = managedRemainingMs(ctx);
  const signal = ctx.managedLifecycle?.signal;
  if (!(ms > 0)) return Promise.resolve(!res.destroyed && !signal?.aborted && remaining > 0);
  if (res.destroyed || signal?.aborted) return Promise.resolve(false);
  const boundedMs = Math.min(ms, remaining);
  if (!(boundedMs > 0)) return Promise.resolve(false);
  return new Promise(resolve => {
    let timer = null;
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (res.destroyed || signal?.aborted) { finish(false); return; }
    timer = setTimeout(() => finish(!res.destroyed && !signal?.aborted && !managedDeadlineExpired(ctx)), boundedMs);
    timer.unref?.();
  });
}

function managedPoolWaitMs(ctx, accountManager) {
  const now = Date.now();
  const monotonicNow = managedMonotonicMs(ctx);
  const waits = [];
  for (const notBefore of ctx.managedRetryNotBefore.values()) {
    if (notBefore > monotonicNow) waits.push(notBefore - monotonicNow);
  }
  for (const account of accountManager.accounts) {
    const quota = account.quota || {};
    const threshold = accountManager.switchThreshold ?? 0.98;
    const quotaResets = [
      quota.unified5h >= threshold ? quota.unified5hReset : null,
      quota.unified7d >= threshold ? quota.unified7dReset : null,
      quota.unified7dSonnet >= threshold ? quota.unified7dSonnetReset : null,
      quota.unified7dFable >= threshold ? quota.unified7dFableReset : null,
      (quota.tokensLimit > 0 && quota.tokensRemaining / quota.tokensLimit <= 1 - threshold) ? quota.resetsAt : null,
      (quota.requestsLimit > 0 && quota.requestsRemaining / quota.requestsLimit <= 1 - threshold) ? quota.resetsAt : null,
    ];
    for (const reset of [account.pausedUntil, account.rateLimitedUntil, ...quotaResets]) {
      const at = typeof reset === 'number' ? reset : Date.parse(reset);
      if (Number.isFinite(at) && at > now) waits.push(at - now);
    }
  }
  const floor = managedBackoffMs(MANAGED_SAME_ACCOUNT_RETRIES + (ctx.managedPoolRetryRounds || 0) + 1);
  const target = waits.length ? Math.max(floor, Math.min(...waits)) : floor;
  const remaining = managedRemainingMs(ctx);
  return target <= MANAGED_POOL_WAIT_MAX_MS && target < remaining ? target : null;
}

function managedHasRetryableCandidate(ctx, accountManager) {
  return accountManager.accounts.some(account =>
    !ctx.managedPermanentTried.has(account.index) && !account.disabled &&
    account.status !== 'error' && account.status !== 'exhausted');
}

function managedResetPoolPass(ctx) {
  ctx.tried.clear();
  for (const index of ctx.managedPermanentTried) ctx.tried.add(index);
  const now = managedMonotonicMs(ctx);
  for (const [index, notBefore] of ctx.managedRetryNotBefore) {
    if (notBefore > now) ctx.tried.add(index);
  }
}

function managedErrorSignal(body) {
  try {
    const value = JSON.parse(body.toString('utf8'));
    const error = value?.error || value;
    return [value?.type, value?.code, error?.type, error?.code, error?.message]
      .filter(v => typeof v === 'string').join(' ').toLowerCase();
  } catch {
    return '';
  }
}

function managedQuotaOrBillingKind(status, rateLimitHeaders, body) {
  if (status === 429 && (
      rateLimitHeaders['anthropic-ratelimit-unified-5h-status'] === 'rejected' ||
      rateLimitHeaders['anthropic-ratelimit-unified-7d-status'] === 'rejected')) return 'general-quota';
  if (status === 429 &&
      rateLimitHeaders['anthropic-ratelimit-unified-7d_oi-status'] === 'rejected') return 'model-quota';
  if (![400, 402, 403, 429].includes(status)) return false;
  const signal = managedErrorSignal(body);
  if (/(?:billing[_ -]?error|credit balance|spend(?:ing)? limit|subscription expired)/.test(signal)) return 'billing';
  return /(?:insufficient[_ -]?quota|quota[_ -]?(?:exceeded|exhausted)|usage limit (?:has been )?(?:reached|exceeded)|subscription limit)/.test(signal)
    ? 'unknown-quota' : null;
}

function managedPersistModelQuota(account, rateLimitHeaders, retryAfterMs) {
  const quota = account.quota || (account.quota = {});
  const now = Date.now();
  const exactSeconds = Number(rateLimitHeaders['anthropic-ratelimit-unified-7d_oi-reset']);
  const exactReset = Number.isFinite(exactSeconds) && exactSeconds * 1000 > now
    ? Math.trunc(exactSeconds * 1000) : null;
  const existingReset = Number.isFinite(quota.unified7dFableReset) && quota.unified7dFableReset > now
    ? quota.unified7dFableReset : null;
  const sharedReset = Number.isFinite(quota.unified7dReset) && quota.unified7dReset > now
    ? quota.unified7dReset : null;
  const fallbackReset = now + Math.max(Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? retryAfterMs : 60_000, 1_000);
  quota.unified7dFable = Math.max(Number(quota.unified7dFable) || 0, 1);
  quota.unified7dFableReset = exactReset || existingReset || sharedReset || fallbackReset;
}

function managedResponseHeaders(response) {
  const headers = {};
  for (const [key, value] of response.headers.entries()) {
    if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
    if (key === 'content-encoding' || key === 'content-length') continue;
    headers[key] = value;
  }
  return headers;
}

async function managedCaptureFailure(response, retryAfterMs = null, ctx) {
  const chunks = [];
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await managedAwaitLifecycle(
          reader.read(), ctx, () => reader.cancel());
        if (done) break;
        chunks.push(Buffer.from(value));
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released/cancelled */ }
    }
  }
  const body = Buffer.concat(chunks);
  return { status: response.status, headers: managedResponseHeaders(response), body, retryAfterMs };
}

function managedTransportFailure() {
  return {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: 'Managed upstream transport failed after exhausting the usable account pool.' },
    })),
  };
}

function managedDeadlineFailure() {
  return {
    status: 504,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'timeout_error', message: 'Managed upstream retry deadline exhausted.' },
    })),
  };
}

function managedCredentialFailure() {
  return {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'proxy_error', message: 'Managed upstream credentials were unavailable across the usable account pool.' },
    })),
  };
}

function managedCapacityFailure(source = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (Number.isFinite(source?.retryAfterMs) && source.retryAfterMs > 0) {
    headers['retry-after'] = String(Math.max(1, Math.ceil(source.retryAfterMs / 1000)));
  }
  return {
    status: 503,
    headers,
    body: Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Managed upstream capacity remained unavailable after exhausting the usable account pool.' },
    })),
  };
}

function managedTerminalFailure(failure) {
  if (failure?.status === 401 || failure?.status === 403) return managedCredentialFailure();
  if (failure?.status === 429) return managedCapacityFailure(failure);
  return failure || managedCapacityFailure();
}

function managedWriteFailure(res, failure) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(failure.status, failure.headers);
  res.end(failure.body);
}


// Constant-time proxy-API-key comparison (both the HTTP gate and the CONNECT
// gate use it). Returns false on any type/length mismatch without leaking timing.
export function safeKeyEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// True if a socket's remote address is loopback — the proxy-key gate exempts
// localhost on both the HTTP and CONNECT paths.
export function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export function createProxyServer(accountManager, config, hooks = {}, sx = null) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  const holdMs = (config.holdSeconds || 0) * 1000;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const requestHandler = async (req, res) => {
    try {
      // Auth check — skip for localhost connections.
      const clientKey = req.headers['x-api-key'];
      const isLocal = isLoopbackAddr(req.socket.remoteAddress);
      if (proxyApiKey && !safeKeyEqual(clientKey, proxyApiKey) && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Control-plane mutations are refused when the request was issued by a web
      // page. The gate above exempts loopback from the API key, so without this
      // any site the operator happens to visit can POST here cross-origin: a
      // `fetch(..., {mode:'no-cors', body})` with a text/plain content type is a
      // CORS "simple request", so no preflight is sent and the request lands.
      // The page cannot read the reply, but the side effect is the point —
      // forcing the whole fleet onto one named account is a targeted quota
      // drain, and reload is reachable the same way.
      //
      // Origin (and Sec-Fetch-Site) are set by the browser and cannot be
      // forged from page JavaScript, while curl and the CLI send neither — so
      // this costs legitimate callers nothing. Deliberately not a content-type
      // requirement, which would also close the hole but would break the
      // documented `curl -X POST .../teamclaude/reload` that sends no body.
      if (req.method === 'POST' && (req.url || '').startsWith('/teamclaude/')
          && !isSameOriginControlRequest(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'cross-origin request refused: the control plane is not reachable from a web page',
        }));
        return;
      }

      // Forward-proxy request (HTTP_PROXY): an absolute-form URL is a tool
      // proxying plain HTTP to some host. Account logic is only for hosts we
      // manage (the Anthropic upstream, which is HTTPS-only and never arrives
      // this way); forward anything else transparently instead of hijacking it.
      if (/^https?:\/\//i.test(req.url || '')) { relayHttpForward(req, res); return; }

      // Status endpoint
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        const status = accountManager.getStatus();
        const extra = hooks.getStatusExtra?.() || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...extra, ...status }, null, 2));
        return;
      }

      // Reload endpoint — re-sync accounts from config without a restart. This
      // is the headless equivalent of pressing 'R' in the TUI. Local control
      // only (no upstream calls); the auth gate above already applies.
      if (req.method === 'POST' && req.url === '/teamclaude/reload') {
        if (!hooks.reload) {
          res.writeHead(501, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'reload not supported' }));
          return;
        }
        try {
          const added = await hooks.reload();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, added: added || 0 }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
        return;
      }

      // Switch endpoint — make one account the preferred one, the headless
      // equivalent of picking it with 's' in the TUI. Both do the same single
      // thing: move currentIndex. That is a preference, and a weak one: _select
      // abandons it as soon as the account is unavailable, and also whenever any
      // available account carries a strictly lower priority value. So the answer
      // reports whether the choice will actually take effect rather than only
      // that it was recorded. Body:
      // {"account": "<name|email|accountUuid|accountUuid/orgUuid|orgUuid>"}.
      // Local control only (no upstream calls); the auth gate above applies.
      if (req.method === 'POST' && req.url === '/teamclaude/switch') {
        const names = () => (accountManager.accounts || []).map(a => a.name);
        let target;
        try {
          const raw = await readControlBody(req);
          target = JSON.parse(raw || '{}')?.account;
        } catch (err) {
          // Say which of the two it was, but never echo the parser's own message
          // back to a caller — that is our internals, not their input.
          const tooLarge = err.message === 'body too large';
          res.writeHead(tooLarge ? 413 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: tooLarge ? 'request body too large' : 'invalid request body' }));
          return;
        }
        if (typeof target !== 'string' || !target.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing "account"', accounts: names() }));
          return;
        }
        const index = resolveAccountPin(accountManager, target);
        if (index == null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `no such account "${target}"`, accounts: names() }));
          return;
        }
        accountManager.currentIndex = index;
        const name = accountManager.accounts[index].name;
        // Recording the choice and the choice taking effect are two different
        // things: selection skips an account it cannot use on the very next
        // request, so a bare "ok" would be a lie for a disabled or spent target.
        // The switch still happens (that is the TUI's behaviour) and the answer
        // says whether traffic will follow it.
        const { eligible, reason } = accountManager.eligibility(index);
        // Leave a trace where every other account change already leaves one: the
        // TUI swaps console.log for its activity pane and headless mode tees it
        // to the activity log, so this one line covers both. Without it a manual
        // switch is the only account change that happens invisibly — on exactly
        // the background-service deployment this endpoint exists for.
        console.log(`[TeamClaude] Switched to account "${name}" (manual)`
          + (eligible ? '' : ` — ${reason}, so rotation will not use it`));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, account: name, eligible, ...(reason ? { reason } : {}) }));
        return;
      }

      return forward(req, res);
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  };

  // Opt-in egress pin: null unless config.egress.pin is set, and then shared by
  // the base listener and the MITM one so both honour the same hold.
  const egress = createEgressGuard(config, console.error);
  const forward = createProxyRequestListener({ accountManager, upstream, logDir, hooks, sx, holdMs, config, egress });
  const server = http.createServer(requestHandler);

  // Forward-proxy support (always on, so multiple claude instances can use
  // either ANTHROPIC_BASE_URL or HTTPS_PROXY against the same server). A CONNECT
  // to the upstream host is a transparent MITM relay (rewrite only auth); the
  // test host is answered locally; anything else is blind-tunneled. Certs are
  // minted lazily on the first intercepted CONNECT.
  const mitmHost = (() => { try { return new URL(upstream).hostname; } catch { return 'api.anthropic.com'; } })();
  let certsPromise = null;
  const ensureLeaf = async () => {
    // Reset the memo on failure so a transient cert error doesn't wedge the MITM
    // path permanently (a cached rejected promise would re-throw on every CONNECT).
    certsPromise ||= ensureCerts(mitmHost).catch((err) => { certsPromise = null; throw err; });
    const c = await certsPromise;
    return { key: c.leafKeyPem, cert: c.leafCertPem };
  };
  server.on('connect', createConnectHandler({ config, accountManager, ensureLeaf, logDir, hooks, log: console.error, sx, egress }));
  // Remote Control's real-time channel is a WebSocket, not a request/response
  // call — Node fires 'upgrade' for that handshake, never 'request', so it
  // needs its own listener (base-URL routing path; the MITM path wires the
  // same relayUpgrade onto its own terminating server in mitm.js).
  server.on('upgrade', (req, socket, head) => relayUpgrade(req, socket, head, upstream, sx));

  return server;
}

/**
 * Whether a control-plane POST did NOT come from a web page.
 *
 * Both headers are browser-set and unforgeable from page JavaScript:
 *   - `Sec-Fetch-Site` is the explicit answer where it exists (Chrome, Safari,
 *     Firefox). Anything but `same-origin` / `none` is a page reaching across.
 *   - `Origin` is the fallback for browsers that send no Sec-Fetch-Site. Its
 *     mere presence on a POST to a local control endpoint means a page issued
 *     it; matching it against our own host would mean guessing which of
 *     localhost / 127.0.0.1 / [::1] / a LAN address the caller used, and a
 *     browser-issued same-origin call is not a thing worth supporting here.
 *
 * Non-browser callers (curl, the CLI, `teamclaude attach`) send neither and are
 * unaffected.
 */
export function isSameOriginControlRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  return !req.headers.origin;
}

// Read a control-endpoint body as text. Capped, unlike the proxied request path:
// these endpoints carry a couple of fields, so anything larger is a mistake or an
// attack and buffering it whole would be the wrong answer either way.
async function readControlBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Resolve an account pin to an index, or null.
 *
 * Accepted forms, first match wins:
 *   - `accountUuid/orgUuid` — fully qualified, the only form that distinguishes
 *     one person's accounts across several orgs
 *   - `accountUuid`
 *   - `orgUuid`
 *   - the display name (`email` or `email (Org)`), or the bare email
 *
 * UUIDs are the identity to use for anything scripted or long-lived: display
 * names are rewritten in place when an email gains a second org (see
 * accountsCommand), so a name is a convenience, not an identifier.
 *
 * The rotation index is deliberately NOT accepted. It is array position, so
 * deleting an account would silently repoint every later pin at a DIFFERENT
 * account — a wrong-account misroute rather than an honest failure.
 */
export function resolveAccountPin(accountManager, token) {
  const accounts = accountManager.accounts || [];
  const norm = (s) => (s || '').trim().toLowerCase();
  const t = norm(token);
  if (!t) return null;

  const at = (pick) => accounts.findIndex(a => norm(pick(a)) === t);
  const qualified = accounts.findIndex(a => a.accountUuid && a.orgUuid
    && `${norm(a.accountUuid)}/${norm(a.orgUuid)}` === t);

  for (const i of [
    qualified,
    at(a => a.accountUuid),
    at(a => a.orgUuid),
    at(a => a.name),
    at(a => (a.name || '').split(' (')[0]), // display name minus the org suffix
  ]) if (i >= 0) return i;

  return null;
}

// Paths that must reach upstream with the client's own credential (never a
// rotated account token): the Remote Control channel and attachment transfers.
// teamclaude applies its account logic (rotation, exhaustion, token injection)
// ONLY to hosts it manages — the Anthropic upstream. Anything else must be
// forwarded transparently, never hijacked into "all accounts exhausted". For
// HTTPS this is already true (the CONNECT tunnel in mitm.js blind-relays
// non-upstream hosts). This is the plain-HTTP counterpart: a tool honoring
// HTTP_PROXY sends an ABSOLUTE-form request (`GET http://host/path`), which
// otherwise gets misrouted to Anthropic. Blind-relay it to its target with the
// client's own headers — no account selection, no token injection,
// content-encoding passed through (a transparent forward proxy). Anthropic is
// HTTPS-only, so in practice this only ever sees third-party hosts.
export function relayHttpForward(req, res) {
  let target;
  try { target = new URL(req.url); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Malformed forward-proxy URL' } }));
    return;
  }
  const transport = target.protocol === 'http:' ? http : https;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // Drop hop-by-hop + proxy-control headers; `host` is reset from the target.
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'proxy-connection') continue;
    headers[key] = value;
  }

  const upstreamReq = transport.request(target, { method: req.method, headers }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
  });
  upstreamReq.on('error', (err) => {
    console.error(`[TeamClaude] HTTP forward to ${target.host} failed:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  });
  res.on('close', () => upstreamReq.destroy());
  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

const CLIENT_CREDENTIAL_PATHS = ['/v1/code/', '/api/oauth/files/', '/api/oauth/file_upload'];

/**
 * Build the core proxy request listener — buffer the body, then forward with
 * account selection + retry (forwardRequest). Shared by the base HTTP server and
 * the MITM's terminating h2/h1 server, so both get identical buffering, model-
 * aware routing, and retry-on-quota behavior. Control endpoints (status/reload)
 * and the proxy-API-key gate live in the base server's wrapper, not here.
 */
export function createProxyRequestListener({ accountManager, upstream, logDir = null, hooks = {}, sx = null, holdMs = 0, config = {}, forcedPin = null, egress = null }) {
  let counter = 0;
  return async (req, res) => {
    try {
      // Claude Code's telemetry (`/api/event_logging/*`) is high-volume noise in
      // the activity log. `config.eventLogging` (read live so the TUI toggle takes
      // effect immediately): 'show' forwards + displays; 'hide' (default) forwards
      // but suppresses the activity entry; 'block' answers 200 locally without
      // forwarding (no upstream round-trip, no account/token spent).
      const eventLogging = config?.eventLogging || 'hide';
      const isEventLog = (req.url || '').startsWith('/api/event_logging');
      if (isEventLog && eventLogging === 'block') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const hideActivity = isEventLog && eventLogging !== 'show';
      // Egress pin (opt-in): with the exit IP off the pinned one — a VPN that
      // dropped — hold rather than send. Upstream answers a request from an
      // unexpected region with a 403 that Claude Code reports as a dead session,
      // so sending it costs a re-login while waiting costs latency. Checked here
      // rather than per-account: it is a property of the connection, and this is
      // the one path every request takes, MITM included.
      if (egress?.enabled()) {
        const state = await egress.waitUntilPinned({ isAborted: () => res.destroyed });
        if (res.destroyed) return;
        if (!state.ok) {
          res.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '30' });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'proxy_error',
              message: `Egress is ${state.ip || 'unknown'}, not the pinned ${state.expected.join(', ')} — not sending this request. Check the VPN.`,
            },
          }));
          return;
        }
      }
      // Client token refresh: pass through untouched (the proxy manages its own
      // tokens via ensureTokenFresh; rewriting client refreshes would conflict).
      if (req.method === 'POST' && req.url === '/v1/oauth/token') { await relayRaw(req, res, upstream, sx); return; }
      // Remote Control (/v1/code/*) is bound to the session's paired claude.ai
      // identity — forward with the client's OWN credential (streamed), never a
      // rotated account token, which would 403 the worker event stream.
      // Attachment transfers (/api/oauth/files/*, /api/oauth/file_upload) are
      // likewise account-bound: files uploaded from claude.ai belong to the
      // paired identity, so fetching them with a rotated token 403s and Claude
      // Code silently drops the image from the message.
      if (CLIENT_CREDENTIAL_PATHS.some((p) => (req.url || '').startsWith(p))) { await relayStream(req, res, upstream, sx); return; }

      // Account pin: a request to `/tc-acct/<name-or-index>/...` (e.g. via
      // ANTHROPIC_BASE_URL=http://host:port/tc-acct/deepseek) is forced onto that
      // one account, bypassing rotation. Used by the keep-warm scheduler and for
      // manual per-account testing. The prefix is stripped before forwarding.
      let pinnedIndex = null;
      // DEPRECATED: the path-prefix pin. Superseded by TC_ACCT, which works in
      // MITM mode too (this form cannot — inside a CONNECT tunnel the path is
      // the real upstream one). Kept for the warmer and for direct API callers.
      // One segment only, so the fully-qualified `accountUuid/orgUuid` form is
      // not expressible here; use TC_ACCT for that.
      const url = req.url || '';
      const afterPrefix = url.startsWith(PIN_PREFIX) ? url.slice(PIN_PREFIX.length) : null;
      // The token runs to the next '/', which also begins the real request path.
      const tokenEnd = afterPrefix == null ? -1 : afterPrefix.indexOf('/');
      if (tokenEnd > 0) {
        const token = decodeURIComponent(afterPrefix.slice(0, tokenEnd));
        pinnedIndex = resolveAccountPin(accountManager, token);
        if (pinnedIndex == null) {
          const reqId = ++counter;
          const sessionId = req.headers['x-claude-code-session-id'] || null;
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(unknown pin: "${token}")`, status: 404, model: null, sessionId, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Unknown account pin "${token}"` } }));
          return;
        }
        req.url = afterPrefix.slice(tokenEnd);
      }

      // MITM-mode pin. A CONNECT carrying `Proxy-Authorization: Basic <acct>:…`
      // has no URL to hang a `/tc-acct/` prefix on — the path inside the tunnel
      // is the real Anthropic one — so the pin arrives as a listener bound to
      // that account (see createConnectHandler). Resolved per request rather
      // than at CONNECT time: a hot reload can renumber accounts while a tunnel
      // is open, and a name outliving an index is the safer half of that race.
      if (pinnedIndex == null && forcedPin != null) {
        pinnedIndex = resolveAccountPin(accountManager, forcedPin);
        if (pinnedIndex == null) {
          const reqId = ++counter;
          const sessionId = req.headers['x-claude-code-session-id'] || null;
          if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: `(unknown pin: "${forcedPin}")`, status: 404, model: null, sessionId, pinned: false });
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `Unknown account pin "${forcedPin}" (from TC_ACCT)` } }));
          return;
        }
      }

      const reqId = ++counter;
      // Claude Code tags each session's requests with this header (present on
      // /v1/messages and count_tokens). Read from headers up front so it drives
      // session-aware routing (issue #109) and colors the TUI activity stream.
      const sessionId = req.headers['x-claude-code-session-id'] || null;
      if (!hideActivity) hooks.onRequestStart?.(reqId, { method: req.method, path: req.url, sessionId, pinned: pinnedIndex != null });

      // Buffer request body (needed to resend on a different account after a 429).
      // Peek the top-level `model` field incrementally as chunks arrive so the
      // TUI can show it the instant it appears in the stream — usually the first
      // frame — rather than waiting for the whole body and the request to finish.
      const bodyChunks = [];
      const modelFinder = new TopLevelFieldFinder('model');
      for await (const chunk of req) {
        bodyChunks.push(chunk);
        if (!modelFinder.done) {
          const found = modelFinder.push(chunk);
          if (found && !hideActivity) hooks.onRequestModel?.(reqId, { model: found });
        }
      }
      const body = Buffer.concat(bodyChunks);

      const model = modelFinder.done ? modelFinder.value : parseRequestModel(body);
      // An advisor request (Claude Code's advisor tool) carries a SECOND model
      // nested in tools[]; the advisor sub-inference runs on the selected
      // account, so selection must be eligible for it too (issue #98).
      const advisorModel = parseAdvisorModel(body);

      // Model blocklist (issue #116): reject a request for a blocked model right
      // here instead of forwarding it. A model no account can serve (e.g. Fable
      // once it left base plans) otherwise gets rate-limited upstream and hangs
      // the pipeline; a fast, non-retryable 400 lets the client move on. Read
      // live from the shared config so the TUI editor takes effect immediately.
      const blockedBy = model ? (config?.blockedModels || []).find((p) => modelGlobMatches(p, model)) : null;
      if (blockedBy) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Model "${model}" is blocked by teamclaude (matched "${blockedBy}").` } }));
        }
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model, sessionId });
        return;
      }

      const ctx = { account: null, status: null, tried: new Set(), reauthed: new Set(), model, advisorModel, pinnedIndex, holdBudgetMs: holdMs, sessionId };
      // Hold the session "in flight" across the WHOLE request (incl. retries and
      // a multi-minute streaming completion) so it stays counted as active and
      // never expires mid-request.
      accountManager.beginSession(sessionId);
      try {
        await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir, sx);
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Internal proxy error' } }));
        }
      } finally {
        accountManager.endSession(sessionId);
        if (!hideActivity) hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: ctx.account, status: ctx.status, model: ctx.model, sessionId, pinned: ctx.pinnedIndex != null });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  };
}

// Per-request https.Agent tunneled through sx.org — one-shot (no keep-alive
// reuse, matching upstream-fetch.js's proxiedFetch), so a fresh sx tunnel is
// dialed for this connection only.
function sxAgent(sx, targetHost) {
  const proxy = sx.getProxy();
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_options, cb) => {
    tunnelTls({ proxy, targetHost, targetPort: 443, tlsOptions: sx.tlsOptions || {} })
      .then((sock) => cb(null, sock))
      .catch((err) => cb(err));
    return undefined;
  };
  return agent;
}

/**
 * Relay a request to upstream with the client's OWN headers intact (including
 * its authorization) — used for Remote Control (/v1/code/*), whose event
 * stream is a long-poll: the client keeps the request open indefinitely and
 * the upstream may withhold response headers for minutes between events. No
 * buffering, no timeout, no reconstruction — just pipe bytes both ways as they
 * arrive, exactly like a transparent proxy would.
 */
function relayStream(req, res, upstream, sx) {
  const target = new URL(`${upstream}${req.url}`);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk) || lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;
  const transport = target.protocol === 'http:' ? http : https;

  const upstreamReq = transport.request(target, { method: req.method, headers, agent }, (upstreamRes) => {
    const responseHeaders = {};
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key) || key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.statusCode, responseHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    console.error('[TeamClaude] Remote Control relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  });
  // Client disconnected (e.g. Claude Code closed the channel): tear down the
  // upstream side too instead of leaking an open connection.
  res.on('close', () => upstreamReq.destroy());

  if (['GET', 'HEAD'].includes(req.method)) upstreamReq.end();
  else req.pipe(upstreamReq);
}

/**
 * Relay a WebSocket upgrade (e.g. Remote Control's real-time
 * `/v1/session_ingress/ws/*` channel) to upstream with the client's own
 * headers intact. An HTTP server never emits 'request' for an Upgrade
 * handshake — only 'upgrade', with a raw socket instead of a response object —
 * so this needs its own relay rather than going through relayStream/res.
 * Reuses Node's http(s) client, which already knows how to speak the Upgrade
 * handshake (emits its own 'upgrade' event on a 101); once that fires it's
 * just two raw sockets spliced together.
 */
export function relayUpgrade(req, socket, head, upstream, sx) {
  const target = new URL(`${upstream}${req.url}`);
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    // Unlike relayStream, do NOT strip 'upgrade'/'connection' here — they ARE
    // the handshake. Only 'host' (the client transport reconstructs it from
    // `target`) and h2 pseudo-headers are dropped.
    if (lk.startsWith(':') || lk === 'host') continue;
    headers[key] = value;
  }

  const useProxy = !!(sx?.useByDefault() && sx.isProvisioned());
  const agent = useProxy ? sxAgent(sx, target.hostname) : undefined;
  const transport = target.protocol === 'http:' ? http : https;

  const upstreamReq = transport.request(target, { method: req.method, headers, agent });

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const headerLines = Object.entries(upstreamRes.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\r\n');
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${headerLines}\r\n\r\n`);
    if (upstreamHead?.length) socket.write(upstreamHead);
    if (head?.length) upstreamSocket.write(head);
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    // An upgraded socket defaults to half-open: the peer's FIN only ends the
    // READABLE side ('end'), it does NOT destroy the socket or fire 'close' —
    // so without this, one side hanging up (dropped wifi, killed CLI) leaves
    // the other socket open forever. destroy() is idempotent, so reacting to
    // both 'end' and 'close' on each side is a safe, redundant backstop.
    socket.on('end', () => upstreamSocket.destroy());
    upstreamSocket.on('end', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    // The 101 detaches this socket from upstreamReq, so the request's 'error'
    // listener no longer covers it. A link that flaps mid-session then raises
    // 'error' (write EPIPE / read ECONNRESET) on a socket nobody listens to,
    // which Node escalates to an uncaught exception — one dropped WebSocket
    // would kill the proxy for every other session. Close the pair instead.
    upstreamSocket.on('error', () => socket.destroy());
  });

  upstreamReq.on('error', (err) => {
    console.error('[TeamClaude] Remote Control WebSocket relay error:', err.message);
    socket.destroy();
  });
  socket.on('error', () => upstreamReq.destroy());

  upstreamReq.end();
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream, sx) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await upstreamFetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    }, sx, sx?.useByDefault());

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      // `.text()` already decompressed the body, so drop content-encoding and
      // the now-stale content-length (both refer to the compressed bytes) — else
      // a gzip'd upstream response reaches the client mis-framed / truncated.
      if (key === 'transfer-encoding' || key === 'connection' ||
          key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// A per-request log that streams to disk as the request/response flow, instead
// of buffering the whole body in memory and writing once at the end. The file
// is opened on first write; header sections are written verbatim and bodies are
// streamed through BodyWriter (JSON pretty-printed on the fly, SSE/other raw),
// so even a ~1M-token response costs only the current chunk.
function openRequestLog(logDir, reqId) {
  const filename = `${logTimestamp()}_${String(reqId).padStart(5, '0')}.log`;
  const ws = createWriteStream(join(logDir, filename), { flags: 'a' });
  ws.on('error', (err) => console.error(`[TeamClaude] Failed to write log: ${err.message}`));
  let ended = false;
  const write = (s) => { if (!ended && s) ws.write(Buffer.from(String(s), 'latin1')); };
  return {
    write,
    // Stream a complete body buffer under a section header.
    body(label, buf, contentType) {
      if (!buf || !buf.length) { write(`\n\n=== ${label} ===\n(empty)`); return; }
      new BodyWriter(write, label, contentType || '').chunk(buf);
    },
    // A BodyWriter to append chunks incrementally (e.g. an SSE response).
    bodyWriter(label, contentType) { return new BodyWriter(write, label, contentType || ''); },
    end() { if (!ended) { ended = true; ws.end('\n'); } },
  };
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

export async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, useSx) {
  ctx.managedSameAccountRetries ??= new Map();
  ctx.managedFrozenRequests ??= new Map();
  ctx.managedPermanentTried ??= new Set();
  ctx.managedRetryNotBefore ??= new Map();
  ctx.managedRetryAccountIndex ??= null;
  ctx.managedLastFailure ??= null;
  ctx.managedRetryDeadlineAt ??= managedMonotonicMs(ctx) + MANAGED_RETRY_DEADLINE_MS;
  const managedLifecycle = managedEnsureLifecycle(res, ctx);
  if (managedDeadlineExpired(ctx) || managedLifecycle.signal.aborted) {
    if (res.destroyed || managedLifecycle.signal.reason?.code === 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED') return;
    const failure = managedDeadlineFailure();
    ctx.managedLastFailure = failure;
    ctx.status = failure.status;
    managedWriteFailure(res, failure);
    return;
  }
  // This function is exported, so a caller may hand us a ctx built elsewhere.
  // The 401 path reads ctx.reauthed on every response; default it here rather
  // than trusting every construction site to include it.
  ctx.reauthed ??= new Set();
  // Whether THIS attempt dials via sx.org. Undefined on the first call → derive
  // from the default policy ('always' routes; 'off'/'429' start direct).
  const route = useSx === undefined ? !!(sx?.useByDefault()) : useSx;

  // Select account, skipping any already tried (and failed) this request.
  // A hidden same-account retry is an explicit one-shot preference. It is
  // consumed here so any later recursion must deliberately request it again.
  const managedRetryIndex = ctx.managedRetryAccountIndex;
  ctx.managedRetryAccountIndex = null;
  let account = managedRetryIndex == null ? null : accountManager.accounts[managedRetryIndex];
  if (account && (ctx.tried.has(account.index) || account.disabled ||
      account.status === 'error' || account.status === 'exhausted' || account.status === 'throttled' ||
      (ctx.managedRetryNotBefore.get(account.index) || 0) > managedMonotonicMs(ctx))) {
    ctx.tried.add(account.index);
    account = null;
  }
  if (!account) {
    // The model scopes availability so a spent model-family bucket does not
    // unnecessarily remove an otherwise healthy account from the pool.
    account = ctx.pinnedIndex != null
      ? (ctx.tried.has(ctx.pinnedIndex) ? null : accountManager.accounts[ctx.pinnedIndex])
      : accountManager.getActiveAccount(ctx.tried, ctx.model, ctx.advisorModel, ctx.sessionId);
  }
  if (!account) {
    // Every candidate was refused by upstream (403). Waiting will not help — the    // account needs attention, not a retry — so say so plainly rather than
    // reporting a rate limit. Not a 403 either: the client's own credential is
    // fine, and a 403 would make it drop its login over someone else's problem.
    //
    // Only when the refusals are the WHOLE story, though. If some accounts were
    // refused and others are merely out of quota, a reset will still serve this
    // request — so fall through to the retry-after/hold path below rather than
    // failing fast on the strength of one bad credential. Reporting 502 there
    // would turn a recoverable exhaustion into a hard error, and silently skip
    // the holdSeconds wait an unattended run depends on.
    const rejected = ctx.credentialRejected;
    const allRefused = rejected?.size > 0 && (ctx.pinnedIndex != null
      ? rejected.has(accountManager.accounts[ctx.pinnedIndex]?.name)
      : rejected.size === accountManager.accounts.length);
    if (allRefused) {
      const names = [...rejected].map(n => `"${n}"`).join(', ');
      ctx.status = 502;
      ctx.account = `(${[...rejected].join(', ')} refused)`;
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: `Upstream refused the credential for account ${names} (403). Check the account, then re-add it with: teamclaude login` },
        }));
      }
      return;
    }
    // A retryable failure is surfaced only after selection proves there is no
    // other usable account left. Pinned calls may retry their one account,
    // but must never enter a pool round or leak to another account.
    ctx.managedLastFailure ||= managedCapacityFailure();
    if (ctx.managedLastFailure) {
      const poolRound = ctx.managedPoolRetryRounds || 0;
      const waitMs = managedPoolWaitMs(ctx, accountManager);
      if (ctx.pinnedIndex == null &&
          managedHasRetryableCandidate(ctx, accountManager) &&
          poolRound < MANAGED_POOL_RETRY_ROUNDS && waitMs != null) {
        ctx.managedPoolRetryRounds = poolRound + 1;
        console.log(`[TeamClaude] Usable pool exhausted — hidden pool retry ${poolRound + 1}/${MANAGED_POOL_RETRY_ROUNDS} in ${waitMs}ms`);
        if (!await managedSleep(waitMs, res, ctx)) {
          if (!res.destroyed) {
            ctx.managedLastFailure = managedDeadlineFailure();
            managedWriteFailure(res, ctx.managedLastFailure);
          }
          return;
        }
        managedResetPoolPass(ctx);
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
      }
      const terminalFailure = managedTerminalFailure(ctx.managedLastFailure);
      ctx.status = terminalFailure.status;
      ctx.account = '(managed retry pool exhausted)';
      managedWriteFailure(res, terminalFailure);
      return;
    }
    // A pinned request concerns exactly one account: don't compute a fleet-wide    // retry-after or sleep on other accounts' windows — return immediately.
    if (ctx.pinnedIndex != null) {
      ctx.status = 429;
      ctx.account = '(pinned account unavailable)';
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Pinned account is unavailable (rate-limited, errored, or already tried). Retry shortly.' },
        }));
      }
      return;
    }
    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);

    // Long-hold mode: hold the HTTP connection and poll until an account
    // recovers or the budget (holdSeconds) runs out. Claude Code waits for
    // the first response byte, so this is transparent to the client as long
    // as API_TIMEOUT_MS on the Claude Code side is large enough.
    if (ctx.holdBudgetMs > 0) {
      // Cap the per-poll sleep to 60s so a newly-available account (e.g. one
      // manually enabled or whose quota reset early) is picked up within a
      // minute instead of sleeping the full retryAfter (often 3600s).
      const waitMs = Math.min(retryAfter * 1000, ctx.holdBudgetMs, 60_000);
      ctx.holdBudgetMs -= waitMs;
      console.log(`[TeamClaude] All accounts exhausted — holding connection, retry in ${Math.ceil(waitMs / 1000)}s (${Math.ceil(ctx.holdBudgetMs / 1000)}s budget left)`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }

    const exhaustedRetries = ctx.exhaustedRetries || 0;
    if (exhaustedRetries < 1 && retryAfter <= INLINE_RETRY_AFTER_MAX_SECONDS) {
      ctx.exhaustedRetries = exhaustedRetries + 1;
      console.log(`[TeamClaude] All accounts exhausted — waiting ${retryAfter}s before retry`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir, sx, route);
    }
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  // Pin this session to the serving account (for affinity) and keep it "active"
  // in the running-sessions readout. Passive when distribution is off.
  accountManager.recordSession(ctx.sessionId, account.index);
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  if (!await managedAwaitAccountOperation(accountManager.ensureTokenFresh(account.index), res, ctx)) return;
  if (account.status === 'error') {
    (ctx.credentialRejected ??= new Set()).add(account.name);
    ctx.managedPermanentTried.add(account.index);
    ctx.tried.add(account.index);
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
  }

  // Freeze one normalized request per account before its first upstream attempt.
  // Every later retry/pool round on that account reuses the exact bytes and
  // header values; only router-owned authentication changes. Cross-account
  // failover may need that account's UUID/model map, while the prompt-cache
  // content, history and tool ordering remain byte-for-byte stable per account.
  if (!ctx.managedFrozenRequests.has(account.index)) {
    const frozenHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lk = key.toLowerCase();
      if (lk.startsWith(':') || HOP_BY_HOP_HEADERS.has(lk)) continue;
      if (lk === 'x-api-key' || lk === 'authorization' || lk === 'accept-encoding') continue;
      frozenHeaders[key] = value;
    }
    let frozenBody = sanitizeToolPairs(body, req.url, req.headers['content-type']);
    if (account.accountUuid) frozenBody = patchAccountUuid(frozenBody, account.accountUuid);
    if (account.modelMap) frozenBody = rewriteModel(frozenBody, account.modelMap);
    if (frozenBody !== body) frozenHeaders['content-length'] = String(frozenBody.length);
    ctx.managedFrozenRequests.set(account.index, Object.freeze({
      method: req.method,
      body: frozenBody,
      headers: Object.freeze({ ...frozenHeaders }),
    }));
  }

  const managedFrozenRequest = ctx.managedFrozenRequests.get(account.index);
  const method = managedFrozenRequest.method;
  const sendBody = managedFrozenRequest.body;
  const headers = { ...managedFrozenRequest.headers };
  if (account.type === 'oauth') headers.authorization = `Bearer ${account.credential}`;
  else headers['x-api-key'] = account.credential;
  const upstreamUrl = `${account.upstream || upstream}${req.url}`;

  const retryManagedFailure = async (failure, retryAfterMs = null) => {
    failure.retryAfterMs = Number.isFinite(retryAfterMs) ? retryAfterMs : null;
    ctx.managedLastFailure = failure;
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      ctx.managedRetryNotBefore.set(account.index, managedMonotonicMs(ctx) + retryAfterMs);
    }
    const completed = ctx.managedSameAccountRetries.get(account.index) || 0;
    const remaining = managedRemainingMs(ctx);
    const retryAfterIsShort = retryAfterMs == null ||
      (retryAfterMs <= MANAGED_SHORT_429_MAX_MS && retryAfterMs < remaining);
    if (completed < MANAGED_SAME_ACCOUNT_RETRIES && retryAfterIsShort &&
        !res.headersSent && !res.destroyed && remaining > 0) {
      const next = completed + 1;
      ctx.managedSameAccountRetries.set(account.index, next);
      ctx.managedRetryAccountIndex = account.index;
      const waitMs = retryAfterMs == null ? managedBackoffMs(next) : retryAfterMs;
      console.log(`[TeamClaude] Retryable upstream failure on "${account.name}" — hidden retry ${next}/${MANAGED_SAME_ACCOUNT_RETRIES} in ${waitMs}ms`);
      if (!await managedSleep(waitMs, res, ctx)) {
        if (!res.destroyed) {
          ctx.managedLastFailure = managedDeadlineFailure();
          managedWriteFailure(res, ctx.managedLastFailure);
        }
        return;
      }
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }
    ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);
    ctx.managedRetryAccountIndex = null;
    ctx.tried.add(account.index);
    if (res.headersSent || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    console.log(`[TeamClaude] Retry budget exhausted on "${account.name}" — trying another usable account`);
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
  };

  // Streaming request log, opened lazily on the first terminal outcome (a
  // pure-429-then-retry attempt writes no file, matching prior behavior). The
  // request head+body are written once, just before the response is logged.
  let log = null;
  let reqLogged = false;
  const getLog = () => (logDir ? (log ||= openRequestLog(logDir, reqId)) : null);
  const logRequestHead = () => {
    const l = getLog();
    if (!l || reqLogged) return;
    reqLogged = true;
    const safeHeaders = { ...headers };
    if (safeHeaders['x-api-key']) safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    if (safeHeaders['authorization']) safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    l.write(`=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`);
    if (body.length > 0) l.body('REQUEST BODY', body, req.headers['content-type']);
  };

  try {
    // Storm control: pace requests onto a freshly-switched account so a failover
    // burst doesn't slam it all at once and cascade (issue #84). The slot is held
    // only until the response headers arrive — long enough to stagger the burst,
    // then released so streaming bodies don't tie up concurrency. Fail-open: a
    // client that disconnects while waiting just drops out.
    if (!await accountManager.admit(account.index, () => res.destroyed || managedLifecycle.signal.aborted || managedDeadlineExpired(ctx))) {
      if (!res.destroyed) {
        ctx.managedLastFailure = managedDeadlineFailure();
        ctx.status = ctx.managedLastFailure.status;
        managedWriteFailure(res, ctx.managedLastFailure);
      }
      return;
    }
    let upstreamRes;
    try {
      upstreamRes = await upstreamFetch(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : sendBody,
        redirect: 'manual',
        signal: managedLifecycle.signal,
        headersTimeoutMs: Math.max(1, managedRemainingMs(ctx)),
      }, sx, route);
    } finally {
      accountManager.release(account.index);
    }

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-')) {
        rateLimitHeaders[key] = value;
      }
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // Any non-429 response is live proof a rate-limit hold no longer binds —
    // this is what lets a revalidation probe (a throttled account selected by
    // _selectProbe) clear its own hold and return the fleet to service.
    if (upstreamRes.status !== 429) accountManager.clearRateLimited(account.index);

    // Buffer only statuses whose structured body can identify account-specific
    // quota/billing. TeamClaude's fetch shim has a single-consumer body (no
    // Response.clone), so permanent errors are relayed from this exact capture.
    const managedRetryAfter = managedRetryAfterMs(upstreamRes);
    const managedErrorFailure = [400, 402, 403, 429].includes(upstreamRes.status)
      ? await managedCaptureFailure(upstreamRes, managedRetryAfter, ctx) : null;
    const quotaOrBillingKind = managedQuotaOrBillingKind(
      upstreamRes.status, rateLimitHeaders, managedErrorFailure?.body || Buffer.alloc(0));

    if (quotaOrBillingKind && !res.headersSent) {
      ctx.managedLastFailure = managedErrorFailure;
      if (quotaOrBillingKind === 'model-quota') {
        managedPersistModelQuota(account, rateLimitHeaders, managedRetryAfter);
      } else if (quotaOrBillingKind === 'general-quota' || quotaOrBillingKind === 'billing') {
        const holdSeconds = Math.min(Math.max(Math.ceil((managedRetryAfter ?? 3_600_000) / 1000), 1), 3600);
        accountManager.markRateLimited(account.index, holdSeconds);
      }
      ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);
      ctx.managedPermanentTried.add(account.index);
      ctx.tried.add(account.index);
      console.log(`[TeamClaude] Confirmed quota/billing rejection on "${account.name}" — switching account`);
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    if (upstreamRes.status === 403 && !res.headersSent) {
      ctx.managedLastFailure = managedErrorFailure;
      (ctx.credentialRejected ??= new Set()).add(account.name);
      ctx.managedPermanentTried.add(account.index);
      ctx.tried.add(account.index);
      console.error(`[TeamClaude] 403 on "${account.name}" — upstream refused the account credential`);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    if ([400, 402].includes(upstreamRes.status)) {
      ctx.status = upstreamRes.status;
      managedWriteFailure(res, managedErrorFailure);
      return;
    }

    if (upstreamRes.status === 429) {
      const retryAfterMs = managedRetryAfter;
      const failure = managedErrorFailure;
      const nextUseSx = !!(sx?.useOn429());
      const switchingToSx = nextUseSx && !route && !ctx.managedSxRetryUsed;
      sx?.noteRateLimited(Math.max(1, Math.ceil((retryAfterMs ?? 1_000) / 1000)));
      if (switchingToSx) {
        ctx.managedSxRetryUsed = true;
        ctx.managedSameAccountRetries.set(account.index,
          (ctx.managedSameAccountRetries.get(account.index) || 0) + 1);
        ctx.managedRetryAccountIndex = account.index;
        console.log(`[TeamClaude] 429 on "${account.name}" — one immediate same-account retry via sx.org`);
        if (res.destroyed || managedLifecycle.signal.aborted) return;
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, true);
      }
      const shortThrottle = retryAfterMs == null || retryAfterMs <= MANAGED_SHORT_429_MAX_MS;
      if (shortThrottle) {
        const pauseMs = retryAfterMs ?? managedBackoffMs((ctx.managedSameAccountRetries.get(account.index) || 0) + 1);
        accountManager.pauseAccount(account.index, pauseMs / 1000);
        // The retry helper waits once; pauseAccount applies the same boundary
        // to concurrent requests and releases them through the normal ramp.
        return retryManagedFailure(failure, retryAfterMs);
      }
      accountManager.markRateLimited(account.index, Math.min(Math.max(Math.ceil(retryAfterMs / 1000), 1), 3600));
      ctx.managedLastFailure = failure;
      ctx.managedSameAccountRetries.set(account.index, MANAGED_SAME_ACCOUNT_RETRIES);
      ctx.tried.add(account.index);
      console.log(`[TeamClaude] Long 429 on "${account.name}" — switching account without exposing it to Claude`);
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    if ([408, 425, 500, 502, 503, 504].includes(upstreamRes.status)) {
      const retryAfterMs = managedRetryAfterMs(upstreamRes);
      const failure = await managedCaptureFailure(upstreamRes, retryAfterMs, ctx);
      return retryManagedFailure(failure, retryAfterMs);
    }

    // A 401 means the credential we injected was rejected. For an OAuth account
    // that usually means the access token was revoked BEFORE its clock expiry —
    // something else refreshed the same token family, so upstream reports it
    // revoked while it still looks fresh locally. ensureTokenFresh's expiry
    // check cannot see that (it only compares the clock), so the account would
    // otherwise keep serving a dead token until the token aged out, and every
    // request in between would surface a 401 to the client with no recovery.
    // Force one refresh and retry. If the refresh is itself rejected the refresh
    // token is dead too: ensureTokenFresh marks the account errored, and the
    // retry's status check rotates to another account. Bounded to one re-auth
    // per account per request, so a genuinely dead credential surfaces the 401
    // instead of looping.
    // A 403 ("Request not allowed") is upstream refusing THIS account outright —
    // not a stale token a refresh could fix, and not anything the client sent.
    // The client never sees the credential we inject, so it cannot act on the
    // rejection; Claude Code reads a 403 as "your session is dead", drops its
    // own login and asks for a re-login over an account problem it has no part
    // in. Skip the account for the rest of this request and fail over. With no
    // account left, the no-account branch reports a proxy error instead.
    if (upstreamRes.status === 403 && !res.headersSent) {
      await upstreamRes.body?.cancel();
      // A set, not a name: the no-account branch needs to tell "every account was
      // refused" (fail fast, nothing to wait for) from "this one was, others are
      // just out of quota" (still worth holding for a reset).
      (ctx.credentialRejected ??= new Set()).add(account.name);
      ctx.tried.add(account.index);
      console.error(`[TeamClaude] 403 on "${account.name}" — upstream refused the account credential`);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    if (upstreamRes.status === 401 && account.type === 'oauth' && account.refreshToken
        && !ctx.reauthed.has(account.index)) {
      ctx.reauthed.add(account.index);
      await upstreamRes.body?.cancel();
      console.log(`[TeamClaude] 401 on "${account.name}" — token rejected; forcing refresh and retrying`);
      if (!await managedAwaitAccountOperation(accountManager.ensureTokenFresh(account.index, true), res, ctx)) return;
      if (res.destroyed) return;
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // A second injected-credential 401 is account-specific, not a client
    // request error. Fail over without leaking it into Claude's login state.
    if (upstreamRes.status === 401 && !res.headersSent) {
      ctx.managedLastFailure = await managedCaptureFailure(upstreamRes, null, ctx);
      (ctx.credentialRejected ??= new Set()).add(account.name);
      ctx.managedPermanentTried.add(account.index);
      ctx.tried.add(account.index);
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir, sx, route);
    }

    // The retry deadline ends when a terminal response is accepted. Long
    // successful SSE streams keep their existing body-idle watchdog and
    // must not be aborted merely because they outlive the retry window.
    managedLifecycle.cleanup();

    // Log the request head (once) followed by the response headers, streaming
    // to disk from here on.
    logRequestHead();
    getLog()?.write(`\n\n=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers). The
    // connection-specific names are also illegal on an HTTP/2 response — when
    // this runs behind the MITM's h2 server, writeHead would otherwise throw.
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (CONNECTION_SPECIFIC_HEADERS.has(key)) continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    res.writeHead(upstreamRes.status, responseHeaders);

    if (!upstreamRes.body) {
      const l = getLog();
      if (l) { l.write('\n\n=== RESPONSE BODY ===\n(empty)'); l.end(); }
      res.end();
      return;
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming) {
      // Stream each chunk straight to the log as it is relayed — never hold the
      // whole (potentially ~1M-token) SSE body in memory.
      const l = getLog();
      const bw = l ? l.bodyWriter('RESPONSE BODY (streamed)', contentType) : null;
      await streamResponse(upstreamRes.body, res, account.index, accountManager, bw);
      l?.end();
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      const l = getLog();
      if (l) { l.body('RESPONSE BODY', buf, contentType); l.end(); }
      res.end(buf);
    }
  } catch (err) {
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    logRequestHead();
    const l = getLog();
    if (l) { l.write(`\n\n=== ERROR ===\n${err.stack || err.message}`); l.end(); }

    const managedAbortReason = managedLifecycle.signal.reason;
    if (managedLifecycle.signal.aborted) {
      if (res.destroyed || managedAbortReason?.code === 'TEAMCLAUDE_MANAGED_CLIENT_CLOSED') return;
      const failure = managedDeadlineFailure();
      ctx.managedLastFailure = failure;
      ctx.status = failure.status;
      managedWriteFailure(res, failure);
      return;
    }

    // A thrown fetch/socket/TLS/timeout error is transport state, never proof
    // that the request or account is bad. Hide bounded retries on the sticky
    // account, then try every other usable account before surfacing failure.
    if (!res.headersSent && !res.destroyed) {
      return retryManagedFailure(managedTransportFailure());
    }
    ctx.status = 502;
    if (!res.writableEnded) res.destroy();
  }
}

// Idle deadline for the RESPONSE BODY, complementing the headers timeout in
// upstream-fetch.js. The headers guard only covers time-to-first-byte; once
// headers arrive it is disarmed, so a network drop AFTER the stream starts would
// otherwise hang the read forever (the SSE completion just goes silent mid-way).
// This watchdog resets on every chunk, so a long but healthy stream is never
// cut — it fires only when the socket produces nothing for the whole window,
// converting a mid-stream hang into a fast failure that evicts the dead socket
// (reader.cancel destroys the underlying connection on both the direct-fetch and
// the sx-tunnel path, since both hand back a web ReadableStream). Override with
// TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS.
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 120_000;

function resolveBodyIdleTimeout() {
  const env = Number(process.env.TEAMCLAUDE_UPSTREAM_BODY_TIMEOUT_MS);
  return env > 0 ? env : DEFAULT_BODY_IDLE_TIMEOUT_MS;
}

// Race a single reader.read() against an inactivity deadline. Resolves to the
// read result, or rejects with a transient TEAMCLAUDE_BODY_TIMEOUT if no chunk
// arrives within `ms`. The pending read is abandoned on timeout; the caller
// cancels the reader (evicting the socket) in its finally block.
export function readWithIdleTimeout(reader, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`upstream stream idle for ${ms}ms`);
      err.code = 'TEAMCLAUDE_BODY_TIMEOUT';
      reject(err);
    }, ms);
    timer.unref?.();
  });
  const read = reader.read();
  // If the timeout wins the race, `read` is abandoned; swallow any later
  // rejection so it can't surface as an unhandledRejection.
  read.catch(() => {});
  return Promise.race([read, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, accountIndex, accountManager, bodyWriter) {
  const reader = webStream.getReader();
  const idleMs = resolveBodyIdleTimeout();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let errored = false;

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleMs);
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      // Forward chunk immediately
      const ok = res.write(value);

      // Append to the log as it streams (no whole-body buffering)
      if (bodyWriter) bodyWriter.chunk(Buffer.from(value));

      const text = decoder.decode(value, { stream: true });

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          // Remove BOTH listeners when either fires: otherwise the un-fired one
          // (usually 'close') stays attached and accumulates one leaked listener
          // per backpressure cycle over a long SSE stream to a slow client.
          const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
          res.once('drain', done);
          res.once('close', done);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } catch (err) {
    // A mid-stream idle timeout (or any read error) means the upstream went
    // silent after headers. Rethrow to the caller's transient handler, which
    // destroys the client connection so the truncated stream is NOT ended
    // cleanly (a clean res.end() would look like a complete response and
    // suppress the client's retry). reader.cancel() in finally evicts the socket.
    errored = true;
    throw err;
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs (and, on the
    // timeout path, to destroy the dead socket so the pool drops it).
    reader.cancel().catch(() => {});
    if (!errored && !res.writableEnded) res.end();
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

// Rewrite the `model` field in a JSON request body using a per-account map.
// Returns the original buffer unchanged if the model isn't in the map or the
// body isn't valid JSON, so non-messages endpoints pass through safely.
// Exported for tests.
export function rewriteModel(body, modelMap) {
  try {
    const obj = JSON.parse(body.toString('utf8'));
    if (obj.model && modelMap[obj.model]) {
      obj.model = modelMap[obj.model];
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
  } catch { /* not JSON — pass through unchanged */ }
  return body;
}

function computeRetryAfter(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = acct.rateLimitedUntil || acct.quota.resetsAt;
    if (reset) {
      const ms = new Date(reset).getTime() - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000));
}
