'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = process.argv[2];
const check = process.argv.includes('--check');
if (!root || JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version !== '1.1.13') {
  throw new Error('Model blocklist patch requires TeamClaude 1.1.13');
}
const moduleName = 'model-blocklist.mjs';
const helper = fs.readFileSync(path.join(__dirname, moduleName), 'utf8');
const sources = new Map();
function replace(source, old, value) {
  if (source.split(old).length !== 2) throw new Error('Unexpected model-blocklist patch layout');
  return source.replace(old, value);
}
for (const filename of ['server.js', 'index.js']) {
  const file = path.join(root, 'src', filename);
  let source = fs.readFileSync(file, 'utf8');
  if (!source.includes('// Managed model blocklist r26.')) {
    if (check) throw new Error(`${filename}: model blocklist patch missing`);
    if (filename === 'server.js') {
      source = replace(source, "import { TopLevelFieldFinder, modelGlobMatches } from './model.js';",
        "import { TopLevelFieldFinder } from './model.js';\n// Managed model blocklist r26.\nimport { findBlockedRequestModel, writeModelBlocked } from './model-blocklist.mjs';");
      const start = source.indexOf('      // Model blocklist (issue #116):');
      const end = source.indexOf('      const ctx = ', start);
      if (start < 0 || end < 0) throw new Error('Missing request model gate');
      source = source.slice(0, start) + `      const blocked = findBlockedRequestModel(body, config.blockedModels);
      if (blocked) {
        writeModelBlocked(res, blocked);
        hooks.onRequestEnd?.(reqId, { method: req.method, path: req.url, account: '(blocked)', status: 400, model: blocked.model, sessionId });
        return;
      }

` + source.slice(end);
      source = replace(source, '      const ctx = { account: null, status: null,',
        '      const ctx = { modelPolicy: config, account: null, status: null,');
      source = replace(source, '  // Pin this session to the serving account (for affinity) and keep it "active"',
        `  // Check effective account aliases and frozen retries before OAuth refresh or inference.
  const blocked = findBlockedRequestModel(body, ctx.modelPolicy?.blockedModels, account.modelMap)
    || (ctx.managedFrozenRequests?.has(account.index)
      ? findBlockedRequestModel(ctx.managedFrozenRequests.get(account.index).body, ctx.modelPolicy?.blockedModels)
      : null);
  if (blocked) {
    ctx.status = 400;
    ctx.account = '(blocked)';
    writeModelBlocked(res, blocked);
    return;
  }

  // Pin this session to the serving account (for affinity) and keep it "active"`);
    } else {
      source = "// Managed model blocklist r26.\nimport { reloadModelBlocklist } from './model-blocklist.mjs';\n" + source.replace(/^#![^\n]*\n/, '');
      source = replace(source, '    if (!diskConfig) return 0;',
        '    if (!diskConfig) return 0;\n    reloadModelBlocklist(config, diskConfig);');
      source = replace(source, '        if (config.routes != null) diskConfig.routes = config.routes;',
        '        if (config.routes != null) diskConfig.routes = config.routes;\n        diskConfig.blockedModels = [...(config.blockedModels || [])];');
      source = '#!/usr/bin/env node\n' + source;
    }
  }
  if (filename === 'server.js' && (!source.includes('modelPolicy: config') || !source.includes('account.modelMap)') || !source.includes('writeModelBlocked(res, blocked)'))) {
    throw new Error('Incomplete request model blocklist');
  }
  if (filename === 'index.js' && (!source.includes('reloadModelBlocklist(config, diskConfig)') || !source.includes('diskConfig.blockedModels ='))) {
    throw new Error('Incomplete blocklist reload/persistence');
  }
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: source, encoding: 'utf8' });
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
