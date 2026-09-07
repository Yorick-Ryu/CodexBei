const semver = require('semver');
const { validAppRange, matchesAppRange } = require('./app-version.cjs');
const { createHash } = require('node:crypto');

const bindings = {
  model: '$model',
  'model_providers.custom.base_url': '$base_url',
  'model_providers.custom.experimental_bearer_token': '$api_key',
  'model_providers.custom.http_headers.x-openai-actor-authorization': '$base_url',
};
const rules = {
  model_provider: (v) => v === 'custom',
  model_reasoning_effort: (v) => ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(v),
  model_reasoning_summary: (v) => ['auto', 'concise', 'detailed', 'none'].includes(v),
  disable_response_storage: (v) => typeof v === 'boolean',
  preferred_auth_method: (v) => v === 'apikey',
  'model_providers.custom.name': (v) => typeof v === 'string' && v.length > 0 && v.length < 81,
  'model_providers.custom.wire_api': (v) => v === 'responses',
  'model_providers.custom.supports_websockets': (v) => typeof v === 'boolean',
  'model_providers.custom.requires_openai_auth': (v) => v === false,
  'model_providers.custom.request_max_retries': (v) => Number.isInteger(v) && v >= 0 && v <= 10,
  'model_providers.custom.stream_max_retries': (v) => Number.isInteger(v) && v >= 0 && v <= 10,
  'model_providers.custom.stream_idle_timeout_ms': (v) => Number.isInteger(v) && v >= 1000 && v <= 600000,
};
const deleteOnly = ['model_providers.custom.env_key', 'model_providers.custom.env_key_instructions'];
const fail = () => { throw new Error('远端配置格式无效，已保留现有配置。'); };
const record = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key));
const validRange = (v) => typeof v === 'string' && v.length <= 100 && Boolean(semver.validRange(v));
const templateDigest = (template) => createHash('sha256').update(JSON.stringify(template)).digest('hex');

function flatten(value, prefix = []) {
  if (!record(value)) fail();
  const fields = [];
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || !key || key.includes('.')) fail();
    const parts = [...prefix, key];
    if (parts.length > 4) fail();
    if (record(child)) fields.push(...flatten(child, parts));
    else fields.push({ path: parts, value: child });
  }
  return fields;
}

function validateTemplate(template) {
  if (/sk-[A-Za-z0-9_-]{12,}/.test(JSON.stringify(template))) fail();
  if (!exactKeys(template, ['id', 'version', 'clientRange', 'targets', 'set', 'remove']) ||
    typeof template.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(template.id) || !semver.valid(template.version) || !validRange(template.clientRange) ||
    !Array.isArray(template.targets) || !template.targets.length || template.targets.length > 10) fail();
  for (const target of template.targets) {
    if (!exactKeys(target, ['kind', 'runtimeRange', 'appRange']) || !['cli', 'desktop'].includes(target.kind) ||
      !validRange(target.runtimeRange) || (target.appRange !== undefined && (target.kind !== 'desktop' || !validAppRange(target.appRange)))) fail();
  }
  const fields = flatten(template.set);
  const names = fields.map((field) => field.path.join('.'));
  if (fields.length > 32) fail();
  for (const field of fields) {
    const name = field.path.join('.');
    if (Object.hasOwn(bindings, name)) { if (field.value !== bindings[name]) fail(); }
    else if (!Object.hasOwn(rules, name) || !rules[name](field.value)) fail();
  }
  for (const name of ['model_provider', ...Object.keys(bindings)]) if (!names.includes(name)) fail();
  if (!Array.isArray(template.remove) || template.remove.length > 32) fail();
  const removed = new Set();
  for (const parts of template.remove) {
    if (!Array.isArray(parts) || parts.some((p) => typeof p !== 'string' || p.includes('.'))) fail();
    const name = parts.join('.');
    // Only exact managed leaves may be removed; never delete a whole table or model/key/URL binding.
    if ((!Object.hasOwn(rules, name) && !deleteOnly.includes(name)) || name === 'model_provider' || names.includes(name) || removed.has(name)) fail();
    removed.add(name);
  }
  return template;
}

function validateManifest(manifest) {
  if (/sk-[A-Za-z0-9_-]{12,}/.test(JSON.stringify(manifest))) fail();
  if (!exactKeys(manifest, ['schemaVersion', 'release', 'publishedAt', 'templates']) || manifest.schemaVersion !== 1 ||
    !Number.isSafeInteger(manifest.release) || manifest.release < 1 || typeof manifest.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.publishedAt)) || !Array.isArray(manifest.templates) || !manifest.templates.length || manifest.templates.length > 50) fail();
  const seen = new Set();
  for (const template of manifest.templates) {
    validateTemplate(template);
    const key = `${template.id}@${template.version}`;
    if (seen.has(key)) fail();
    seen.add(key);
  }
  return manifest;
}

function matches(template, installation) {
  return Boolean(semver.valid(installation.runtimeVersion)) && template.targets.some((target) =>
    target.kind === installation.kind && semver.satisfies(installation.runtimeVersion, target.runtimeRange) &&
    (!target.appRange || matchesAppRange(installation.appVersion, target.appRange)));
}

function selectTemplate(manifest, installations, clientVersion) {
  if (!installations.length || !semver.valid(clientVersion)) return null;
  const candidates = manifest.templates.filter((template) => semver.satisfies(clientVersion, template.clientRange) && installations.every((item) => matches(template, item)))
    .sort((a, b) => semver.rcompare(a.version, b.version));
  // Ambiguous equal-priority policies need an explicit remote correction, never array-order selection.
  if (candidates.length > 1 && semver.eq(candidates[0].version, candidates[1].version)) return null;
  return candidates[0] ?? null;
}

function materialize(template, connection) {
  validateTemplate(template);
  const values = { '$api_key': connection.apiKey, '$base_url': connection.baseUrl, '$model': connection.model };
  const result = {};
  for (const field of flatten(template.set)) {
    let cursor = result;
    for (const part of field.path.slice(0, -1)) cursor = cursor[part] ??= {};
    cursor[field.path.at(-1)] = Object.hasOwn(bindings, field.path.join('.')) ? values[field.value] : field.value;
  }
  return result;
}

module.exports = { validateManifest, validateTemplate, selectTemplate, templateDigest, materialize };
