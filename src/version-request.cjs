const semver = require('semver');
const { validateTemplate, selectTemplate } = require('./template-policy.cjs');
const { validAppVersion } = require('./app-version.cjs');
const exact = (o, keys) => o && Object.getPrototypeOf(o) === Object.prototype && Object.keys(o).every((k) => keys.includes(k));
const validVersion = (v) => typeof v === 'string' && v.length <= 100 && semver.valid(v) === v;
function normalizeRequest(value) {
  if (!exact(value, ['clientVersion', 'targets']) || !validVersion(value.clientVersion) || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > 20) throw new Error('Invalid versions');
  const targets = value.targets.map((t) => {
    if (!exact(t, ['kind', 'runtimeVersion', 'appVersion']) || !['cli', 'desktop'].includes(t.kind) || !validVersion(t.runtimeVersion) ||
      (t.appVersion !== undefined && (t.kind !== 'desktop' || !validAppVersion(t.appVersion)))) throw new Error('Invalid target');
    return { kind: t.kind, runtimeVersion: t.runtimeVersion, ...(t.appVersion === undefined ? {} : { appVersion: t.appVersion }) };
  });
  return { clientVersion: value.clientVersion, targets: [...new Set(targets.map(JSON.stringify))].sort().map((s) => JSON.parse(s)) };
}
function requestFor(installations, clientVersion) {
  return normalizeRequest({ clientVersion, targets: installations.map((t) => ({ kind: t.kind, runtimeVersion: t.runtimeVersion,
    ...(t.kind === 'desktop' && t.appVersion ? { appVersion: t.appVersion } : {}) })) });
}
const requestKey = (request) => JSON.stringify(normalizeRequest(request));
function resolveResponse(manifest, request) {
  request = normalizeRequest(request);
  return { schemaVersion: 1, release: manifest.release, request, template: selectTemplate(manifest, request.targets, request.clientVersion) };
}
function validateResponse(value, request) {
  if (!exact(value, ['schemaVersion', 'release', 'request', 'template']) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.release) || value.release < 1 || requestKey(value.request) !== requestKey(request)) throw new Error('Invalid response');
  if (value.template !== null) {
    validateTemplate(value.template);
    if (!selectTemplate({ templates: [value.template] }, request.targets, request.clientVersion)) throw new Error('Mismatched template');
  }
  return value;
}
module.exports = { normalizeRequest, requestFor, requestKey, resolveResponse, validateResponse, validAppVersion };
