'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.argv[2];
const check = process.argv.includes('--check');
if (!root || JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version !== '1.1.21') {
  throw new Error('Model blocklist patch requires TeamClaude 1.1.21');
}
// 1.1.21 hot-reloads and persists blockedModels itself (#345) but still checks
// only the top-level model. This keeps the routing-field gate (advisors,
// JSON-escaped ids, effective account aliases, frozen retries) and a reload
// that refuses a malformed list instead of silently unblocking everything.
const marker = '// Managed model blocklist r26.';
const moduleName = 'model-blocklist.mjs';
const helper = fs.readFileSync(path.join(__dirname, moduleName), 'utf8');
const sources = new Map();
function replace(source, old, value) {
  if (source.split(old).length !== 2) throw new Error('Unexpected model-blocklist patch layout');
  return source.replace(old, () => value);
}
for (const filename of ['server.js', 'index.js']) {
  const file = path.join(root, 'src', filename);
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes(marker)) {
    if (check) throw new Error(`${filename}: model blocklist patch missing`);
    if (filename === 'server.js') {
      source = replace(source, "import { TopLevelFieldFinder, modelGlobMatches } from './model.js';\n",
        `import { TopLevelFieldFinder, modelGlobMatches } from './model.js';\n${marker}\nimport { findBlockedRequestModel, writeModelBlocked } from './model-blocklist.mjs';\n`);
      source = replace(source, `      const blockedBy = model ? (config?.blockedModels || []).find((p) => modelGlobMatches(p, model)) : null;
      if (blockedBy) {
        if (!res.headersSent) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: \`Model "\${model}" is blocked by teamclaude (matched "\${blockedBy}").\` } }));
        }
        recordEarlyOutcome(accountManager, { pinKey }, req.url, true);
        openEntry = null;   // this path owns the close below; the outer catch must not repeat it
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model, sessionId });
`, `      const blocked = findBlockedRequestModel(body, config?.blockedModels);
      if (blocked) {
        writeModelBlocked(res, blocked);
        recordEarlyOutcome(accountManager, { pinKey }, req.url, true);
        openEntry = null;   // this path owns the close below; the outer catch must not repeat it
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model: blocked.model, sessionId });
`);
      source = replace(source, '      const ctx = { account: null, status: null,',
        '      const ctx = { modelPolicy: config, account: null, status: null,');
      source = replace(source, "  // Pin this conversation to the serving account for the model's weekly bucket\n",
        `  // Check effective account aliases and frozen retries before OAuth refresh or inference.
  const blocked = findBlockedRequestModel(body, ctx.modelPolicy?.blockedModels, account.modelMap)
    || (ctx.managedFrozenRequests?.has(account.index)
      ? findBlockedRequestModel(ctx.managedFrozenRequests.get(account.index).body, ctx.modelPolicy?.blockedModels)
      : null);
  if (blocked) {
    ctx.status = 400;
    ctx.account = '(blocked)';
    ctx.delivered = true;   // a 4xx IS an answer — see answeredStatus
    writeModelBlocked(res, blocked);
    return;
  }

  // Pin this conversation to the serving account for the model's weekly bucket
`);
    } else {
      const shebang = '#!/usr/bin/env node\n';
      if (!source.startsWith(shebang)) throw new Error('Unexpected model-blocklist patch layout');
      source = `${shebang}${marker}\nimport { reloadModelBlocklist } from './model-blocklist.mjs';\n${source.slice(shebang.length)}`;
      source = replace(source, '    if (!diskConfig) return 0;\n',
        '    if (!diskConfig) return 0;\n    reloadModelBlocklist(config, diskConfig);\n');
    }
  }
  if (filename === 'server.js' && (!source.includes('modelPolicy: config') || !source.includes('account.modelMap)') ||
      !source.includes('const blocked = findBlockedRequestModel(body, config?.blockedModels);') ||
      source.includes('find((p) => modelGlobMatches(p, model))'))) {
    throw new Error('Incomplete request model blocklist');
  }
  if (filename === 'index.js' && (!source.includes('reloadModelBlocklist(config, diskConfig)') ||
      !source.includes('if (config.blockedModels != null) diskConfig.blockedModels = config.blockedModels;'))) {
    throw new Error('Incomplete blocklist reload/persistence');
  }
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source.replace(/^#![^\n]*\n/, ''), encoding: 'utf8' });
  if (syntax.status !== 0) throw new Error(syntax.stderr);
  sources.set(file, source);
}
const helperPath = path.join(root, 'src', moduleName);
if (check) {
  if (fs.readFileSync(helperPath, 'utf8') !== helper) throw new Error('Model blocklist helper differs');
} else {
  for (const [file, source] of sources) fs.writeFileSync(file, source);
  fs.writeFileSync(helperPath, helper);
}
console.log(`TeamClaude model blocklist: ${check ? 'verified' : 'patched'}`);
