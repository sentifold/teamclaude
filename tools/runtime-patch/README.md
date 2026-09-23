# TeamClaude reliability runtime patch

Applies a set of reliability changes to an **installed** `@karpeleslab/teamclaude`
package. It edits the shipped `src/*.js` files in place; it does not build or
modify this repository.

## Why a patch and not a branch you install

The changes below are maintained against the exact published package layout and
are applied to whatever npm installed. That keeps this repo a clean fork of
upstream (so the same changes can be proposed upstream as ordinary pull
requests) while the patch stays byte-identical to what is running in production.

## What it changes

- **Bounded hidden retries and failover.** Transport errors, timeouts,
  `408/425/500/502/503/504/529` and short `429`s get at most two same-account
  retries with exponential backoff and jitter. A longer valid `Retry-After` is
  never shortened — the account is benched and the request fails over instead.
  Confirmed quota or billing rejection fails over immediately. All retry sleeps
  and pool waits share a monotonic 120s deadline and stop the moment the client
  disconnects.
- **Byte-identical replays.** One normalized request is frozen per account
  before its first attempt, so every replay on that account preserves tool
  order and prompt-cache prefixes. A cross-account UUID/model rewrite is an
  explicit cold-cache boundary.
- **No leaked terminal 429/401.** A spent pool answers a sanitized retryable
  failure carrying the earliest known recovery, instead of a raw `429` that
  stops the Claude session or a `401` that poisons the client's own login.
  Its `retry-after` is capped at 60 s: since 1.1.21 upstream's own value is the
  real quota reset, which can be days. The message carries upstream's
  exhaustion sentence (model, accounts, re-login names, the real reset).
- **One retry policy, not two.** 1.1.21's one-hop 429/5xx failovers, its 2 s
  headerless-429 retry and its inline 429 absorb are replaced by the managed
  policy rather than stacked under it. A 429 with neither `retry-after` nor
  rate-limit headers is request-scoped (#288): the account is never paused for
  it and it is re-asked no sooner than upstream's headerless delay. A transient
  failover detours the request without moving the fleet cursor (#286).
- **Sticky account selection.** A session-window reset no longer preempts a
  healthy current account mid-conversation; re-ranking happens only when a
  selection is genuinely required. Equal weekly resets are tie-broken by the
  shared 5-hour reset.
- **Caller cancellation** (dropped in 1.1.21). Upstream's `directFetch` now
  composes the caller's `AbortSignal` with its headers timeout itself (#321);
  the payload only refuses a layout that stops doing so.

## Requirements

The patch matches exact source layouts, so it is pinned:

```
@karpeleslab/teamclaude@1.1.21
```

It refuses to run against any other version rather than patching on a
best-effort basis.

## Use

```bash
npm install -g --ignore-scripts @karpeleslab/teamclaude@1.1.21
node tools/runtime-patch/apply.cjs
node tools/runtime-patch/apply.cjs --check   # verify, change nothing
```

Re-running is safe: every change carries a marker comment and is skipped if
already present.

**Disable autoupdate**, or an update will silently restore the unpatched
package: set `TEAMCLAUDE_DISABLE_AUTOUPDATE=1` everywhere TeamClaude runs. To
update deliberately, install the new pinned version and re-run this patch.

## Safety properties

- **Fail-closed.** Any unexpected source layout aborts before a single write.
  A partially recognised layout is treated as unsupported, never patched
  "as far as it goes".
- **Post-checked.** Every touched file is `node --check`ed, and the patch
  verifies its own markers are present before reporting success.
- **Idempotent.** Marker comments make re-application a no-op.

## Layout

- `apply.cjs` — resolves the installed package, enforces the version pin, runs
  the payload, validates the result.
- `payloads/teamclaude-runtime.cjs` — the patch itself, kept verbatim so it can
  be diffed against the source it was extracted from.


### r25: opt-in subscription final-week preference

The staged patch installs `subscription-priority.mjs` and hooks account selection.
Both routers read the same machine-local Router Limits `subscriptions.json` on
selection. Enable it with `"routingPolicy": { "mode": "final-week" }` at the top
level. Only manual `kind: "ends"` dates qualify; renewal/period-end dates do not.
Missing or malformed data leaves ordinary routing available.

Among eligible accounts, prefer the nearest cancellation date in the last weekly
window, falling back to seven calendar days when the reset is unknown. Date-only
billing evidence never hard-expires an account. Exact-model limits, disablement,
manual pins and retry exclusions remain authoritative. Operator numeric priority
in TeamClaude still wins. Existing sessions can move on their next request;
equal end dates preserve affinity. No request body, tier or retry code changes.
Codex weekly reset evidence must match the exact model and be at most 15 minutes
old; the preference never treats cached quota percentages as admission evidence.

The common behavioral test accepts two staged, patched package directories:
`node tools/runtime-patch/verify-subscription-priority.mjs /path/to/codex-multi-auth /path/to/teamclaude`.
Dotfiles `.bin/tests/test-subscription-priority.sh` stages read-only installed
fixtures, checks idempotency, and runs it with a private empty home.


## All Opus models blocked (r26)

The user prohibited the entire Opus family on both Macs on 2026-09-17. Keep the following
pattern in each machine-local TeamClaude config's `blockedModels`, preserving
other entries and all account state:

```json
["*opus*"]
```

All Opus versions and unversioned aliases are blocked, including advisor calls.
Fable, Sonnet and Haiku are unaffected. A policy refusal is a local
HTTP 400 with `error.code: model_blocked`, not an account outage: do not retry,
rotate accounts, remove the rule, or silently substitute a different model.
The user may explicitly change this policy later.

r26 checks the main model, every advisor tool, JSON-escaped IDs and the effective
per-account model map before token refresh/inference. The check applies to HTTP
and native Claude's pinned/unpinned CONNECT TLS h1/h2 path and to retries.
`POST /teamclaude/reload` now picks up blocklist changes; TUI edits persist them.
The blocklist applies to traffic through TeamClaude, not direct outside traffic.

Canonical patch: `sentifold/teamclaude`, `tools/runtime-patch/payloads/model-blocklist.*`.
Dotfiles carries identical payloads in `.bin/lib`; run
`.bin/tests/test-teamclaude-model-blocklist.sh` for offline behavior tests.
Stage using `agent-router-setup install-runtime`; activate only TeamClaude in a
safe maintenance window, retaining the previous immutable release for rollback.


## Socket error guard (r27)

TeamClaude died every few days with an uncaught `Error: read ECONNRESET at
TCP.onStreamRead`, dropping every routed stream. Reproduced: with
`NODE_USE_ENV_PROXY=1`, the Remote Control relays (`/v1/code/*` long-poll,
WebSocket upgrade, absolute-form `https://` forwards) used Node's proxy-aware
global agent. When the proxy refuses CONNECT (the smart proxy's `502 Protected
Egress Failed`), Node 26.8.1 abandons that proxy socket: not destroyed and no
`'error'` listener. The proxy's later reset is then fatal.

`socket-error-guard.cjs` routes those relays through TeamClaude's own
`proxyAgent`, and keeps a persistent `'error'` listener on every CONNECT tunnel
(`connectThroughProxy`, `tunnelTls`, `proxyAgent`) for the socket's whole life.
The owning TLS layer or HTTP client still receives the error and fails its
request; the guard only closes the socket. As defence in depth, `crash-log.js`
records and survives an uncaught `ECONNRESET`/`EPIPE`/`ETIMEDOUT`/`ECONNABORTED`
read/write error whose stack lies entirely in `node:internal/stream_base_commons`
(at most 20 a minute, logged as `tolerated stray stream error`). Every other
uncaught exception and every unhandled rejection still exits.

`node tools/runtime-patch/verify-socket-error-guard.mjs <patched package root>`
runs the reset scenarios, each in its own loopback-only child process;
`test/socket-error-guard.test.js` also reproduces the crash on an unpatched copy.

## 1.1.21 (runtime r30)

All payloads were re-anchored on the 1.1.21 layout and refuse any other
version. Socket guard: 1.1.21 moved every tunnel handshake into
`handshakeOverTunnel`, so its error listener now outlives the handshake there;
the upstream tunnel pool (r29) is unchanged; relays keep `guardedLookup` and
still tunnel through the guarded CONNECT path. An unpatched 1.1.21 still dies
in all seven reset scenarios of `verify-socket-error-guard.mjs`. Subscription
preference: the session-pin preemption now exists twice (session and drain
walks) and both use it. Model blocklist: upstream hot-reloads and persists the
list itself (#345) but still checks only the top-level model, so the payload
keeps the routing-field gate, the per-account alias/frozen-retry gate and a
reload that refuses a malformed list.

TeamClaude 1.1.15+ gives every config account an `id` (persisted on the next
save) and takes `<config>.lock` around writes. Both are forward-compatible:
1.1.13 loads, serves and saves such a config and keeps the ids.
