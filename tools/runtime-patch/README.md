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
  `408/425/500/502/503/504` and short `429`s get at most two same-account
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
- **Sticky account selection.** A session-window reset no longer preempts a
  healthy current account mid-conversation; re-ranking happens only when a
  selection is genuinely required. Equal weekly resets are tie-broken by the
  shared 5-hour reset.
- **Caller cancellation.** `directFetch` composes a caller-provided
  `AbortSignal` with its headers timeout instead of discarding it.

## Requirements

The patch matches exact source layouts, so it is pinned:

```
@karpeleslab/teamclaude@1.1.13
```

It refuses to run against any other version rather than patching on a
best-effort basis.

## Use

```bash
npm install -g --ignore-scripts @karpeleslab/teamclaude@1.1.13
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
