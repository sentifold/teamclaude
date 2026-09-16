import { modelGlobMatches } from './model.js';

// Inspect actual routing fields only, never model names inside user text or schemas.
// JSON decoding also covers escaped IDs and every advisor (not just the first).
export function findBlockedRequestModel(body, patterns = [], modelMap = null) {
  if (!patterns.length) return null;
  let request;
  try { request = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (!request || typeof request !== 'object') return null;
  const models = [{ model: request.model, field: 'model' }];
  if (modelMap && typeof request.model === 'string' && modelMap[request.model]) {
    models.push({ model: modelMap[request.model], field: 'mapped model' });
  }
  for (const tool of Array.isArray(request.tools) ? request.tools : []) {
    if (tool && typeof tool.type === 'string' && /^advisor/i.test(tool.type)) {
      models.push({ model: tool.model, field: 'advisor model' });
    }
  }
  for (const entry of models) {
    if (typeof entry.model !== 'string') continue;
    const pattern = patterns.find(p => modelGlobMatches(p, entry.model));
    if (pattern) return { ...entry, pattern };
  }
  return null;
}

export function writeModelBlocked(res, blocked) {
  if (res.headersSent) return;
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: {
    type: 'invalid_request_error', code: 'model_blocked',
    message: `Model "${blocked.model}" is blocked by teamclaude (${blocked.field}, matched "${blocked.pattern}"). Choose an allowed model.`,
  } }));
}

export function reloadModelBlocklist(config, diskConfig) {
  const patterns = diskConfig.blockedModels ?? [];
  if (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string' || !p.trim())) {
    throw new Error('blockedModels must be an array of nonempty model patterns');
  }
  config.blockedModels = [...patterns];
}
