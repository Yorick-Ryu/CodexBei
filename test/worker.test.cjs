const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handle } = require('../worker/handler.cjs');
const { requestFor } = require('../worker/lib/version-request.cjs');
const RESOLVE_URL = 'https://codexbei.beiapi.cn/config/v1/resolve';
const bootstrap = require('../templates/bootstrap.json');
const cli = [{ kind: 'cli', runtimeVersion: '0.153.4', executable: '/private/path', apiKey: 'private-placeholder' }];
const desktop = [{ kind: 'desktop', runtimeVersion: '0.152.1', appVersion: '26.901.51231.0' }];
const request = (body, url = RESOLVE_URL) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function policies() {
  const manifest = structuredClone(bootstrap);
  const older = structuredClone(manifest.templates[0]); older.id = 'codex-0152'; older.default = false; older.targets = [{ kind: 'desktop', runtimeRange: '>=0.152.0 <0.153.0', appRange: { min: '26.900.0.0', maxExclusive: '26.902.0.0' } }];
  manifest.templates.push(older); return manifest;
}
test('Worker returns only the requested policy, rejects unknown fields and unsupported transport', async () => {
  const response = await handle(request(requestFor(desktop)), policies());
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.template.id, 'codex-0152'); assert.equal(body.templates, undefined);
  assert.equal(JSON.stringify(body).includes('codex-default'), false);
  for (const body of [{}, { ...requestFor(cli), apiKey: 'private-placeholder' }, { clientVersion: '0.3.1', targets: [{ kind: 'cli', runtimeVersion: 'rust-v0.153.4' }] }]) assert.equal((await handle(request(body), policies())).status, 400);
  assert.equal((await handle(request(requestFor(cli), RESOLVE_URL.replace('https:', 'http:')), policies())).status, 400);
  assert.equal((await handle(new Request(RESOLVE_URL), policies())).status, 405);
  assert.equal((await handle(request({ padding: 'x'.repeat(5000) }), policies())).status, 400);
});
test('unknown and preview versions use default, with explicit preview overrides taking precedence', async () => {
  const targets = [{ kind: 'cli', runtimeVersion: '0.153.0-alpha.5.1' }];
  for (const versions of [targets, [], [{ kind: 'desktop', runtimeVersion: null }]]) {
    const response = await handle(request(requestFor(versions)), policies());
    assert.equal(response.status, 200); assert.equal((await response.json()).template.id, 'codex-default');
  }
  const m = policies(); m.templates.find(t => t.id === 'codex-0152').targets = [{ kind: 'cli', runtimeRange: '>=0.153.0-alpha.1 <0.153.0' }];
  assert.equal((await (await handle(request(requestFor(targets)), m)).json()).template.id, 'codex-0152');
});

test('native catalog requires all selected runtimes to meet the boundary', async () => {
  for (const [versions, native] of [
    [['0.156.0'], true], [['0.156.1', '0.156.0'], true],
    [['0.156.0', '0.155.1'], false], [['0.155.1', '0.156.0'], false],
    [['0.156.0', null], false], [['0.156.0-alpha.16'], false], [['0.157.0-alpha.1'], true],
    [['0.162.0-alpha.17.2'], true], [['0.162.1', '0.162.0-alpha.17.2'], true],
    [['0.162.0-alpha.17.2', '0.155.1'], false], [[], false],
  ]) {
    const targets = versions.map((runtimeVersion, i) => ({ kind: i ? 'desktop' : 'cli', runtimeVersion }));
    for (const clientVersion of ['0.1.3', '0.1.3-alpha.1', '0.1.4-alpha.1']) {
      const body = await (await handle(request({ clientVersion, targets }), bootstrap)).json();
      assert.equal(body.template.id, native ? 'codex-native-catalog' : 'codex-default');
    }
  }
  const { materialize, validateTemplate } = require('../worker/lib/template-policy.cjs');
  const native = bootstrap.templates.find(t => t.id === 'codex-native-catalog');
  const result = materialize(native, { baseUrl: 'https://example.com/proxy/v1', apiKey: 'test', model: 'test' });
  assert.equal(result.model_providers.custom.model_catalog_url, 'https://example.com/proxy/v1/models');
  assert.equal(result.features.api_key_model_discovery, true);
  const invalid = structuredClone(native);
  invalid.set.model_providers.custom.model_catalog_url = 'https://untrusted.example/models';
  assert.throws(() => validateTemplate(invalid));
});

test('templates cannot delete existing user configuration', async () => {
  const manifest = structuredClone(bootstrap);
  manifest.templates[0].remove = [['preferred_auth_method']];
  assert.equal((await handle(request(requestFor(cli)), manifest)).status, 503);
});

test('runtime preview matching keeps range boundaries', async () => {
  for (const [runtimeRange, runtimeVersion, expected] of [
    ['>=0.156.0 <0.163.0', '0.156.0-alpha.16', false],
    ['>=0.156.0 <0.163.0', '0.162.0-alpha.17.2', true],
    ['>=0.156.0 <0.163.0', '0.163.0-alpha.1', true],
    ['>=0.156.0 <0.163.0', '0.163.0', false],
    ['>=0.162.0-alpha.18 <0.162.0', '0.162.0-alpha.17.2', false],
    ['>=0.162.0-alpha.18 <0.162.0', '0.162.0-alpha.18', true],
  ]) {
    const manifest = structuredClone(bootstrap);
    manifest.templates[1].targets = [{ kind: 'desktop', runtimeRange }];
    const body = await (await handle(request({ clientVersion: '0.1.8', targets: [{ kind: 'desktop', runtimeVersion }] }), manifest)).json();
    assert.equal(body.template.id, expected ? 'codex-native-catalog' : 'codex-default', runtimeRange + ': ' + runtimeVersion);
  }
});

test('client version gates native templates without changing legacy response shape', async () => {
  const { requestKey, validateResponse } = require('../worker/lib/version-request.cjs');
  const targets = [{ kind: 'cli', runtimeVersion: '0.156.0' }];
  for (const [version, native] of [
    [undefined, false], ['0.1.2', false], ['0.1.2-alpha.1', false],
    ['0.1.3-alpha.1', true], ['0.1.3-rc.1', true], ['0.1.3', true],
    ['0.1.4-alpha.1', true], ['0.2.0-beta.1', true], ['0.2.0', true],
  ]) {
    const input = requestFor(targets, version);
    const response = await handle(request(input), bootstrap);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.request, input);
    assert.equal(body.template.id, native ? 'codex-native-catalog' : 'codex-default');
    assert.equal(body.release, bootstrap.release);
    validateResponse(body, input);
    if (version === undefined) assert.equal(Object.hasOwn(body.request, 'clientVersion'), false);
  }
  assert.notEqual(requestKey(requestFor(targets)), requestKey(requestFor(targets, '0.1.3')));
  assert.notEqual(requestKey(requestFor(targets, '0.1.2')), requestKey(requestFor(targets, '0.1.3')));
  for (const clientVersion of [null, 13, '', 'v0.1.3', '0.1', 'x'.repeat(101)]) {
    assert.equal((await handle(request({ clientVersion, targets }), bootstrap)).status, 400);
  }
  const modern = await (await handle(request(requestFor(targets, '0.1.3')), bootstrap)).json();
  const legacy = requestFor(targets);
  assert.throws(() => validateResponse({ ...modern, request: legacy }, legacy));
});
