const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handle } = require('../worker/handler.cjs');
const { requestFor } = require('../src/version-request.cjs');
const { TemplateStore, RESOLVE_URL } = require('../src/template-store.cjs');
const bootstrap = require('../src/bootstrap-manifest.json');
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
  const m = policies(); m.templates[1].targets = [{ kind: 'cli', runtimeRange: '>=0.153.0-alpha.1 <0.153.0' }];
  assert.equal((await (await handle(request(requestFor(targets)), m)).json()).template.id, 'codex-0152');
});
test('same-release responses cache independently by version, including the default and offline restart', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-filter-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manager = new TemplateStore({ directory, fetchImpl: (url, options) => handle(new Request(url, options), policies()) });
  assert.equal(await manager.check(cli), true); assert.equal(await manager.check(desktop), true);
  assert.equal(manager.resolve(cli).template.id, 'codex-default'); assert.equal(manager.resolve(desktop).template.id, 'codex-0152');
  const unknown = [{ kind: 'cli', runtimeVersion: '0.999.0' }]; assert.equal(await manager.check(unknown), true); assert.equal(manager.resolve(unknown).template.id, 'codex-default');
  const cached = fs.readFileSync(path.join(directory, 'resolved-templates.json'), 'utf8'); assert.equal(cached.includes('/private/path'), false); assert.equal(cached.includes('private-placeholder'), false);
  const restarted = new TemplateStore({ directory, fetchImpl: () => { throw Error(); } });
  assert.equal(await restarted.check(desktop), false); assert.equal(restarted.resolve(desktop).template.id, 'codex-0152'); assert.equal(restarted.resolve(unknown).template.id, 'codex-default');
});
test('client rejects a response matched for another runtime and honors an authoritative no-match', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-filter-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let m = policies();
  const manager = new TemplateStore({ directory, fetchImpl: () => handle(request(requestFor(desktop)), m) });
  assert.equal(await manager.check(cli), false); assert.equal(manager.resolve(cli).source, 'bundled');
  manager.fetch = (url, options) => handle(new Request(url, options), m);
  assert.equal(await manager.check(cli), true);
  m.release++; const special = structuredClone(m.templates[0]); special.id = 'cli-special'; special.default = false; special.targets = [{ kind: 'cli', runtimeRange: '0.153.4' }]; m.templates.push(special, { ...structuredClone(special), id: 'ambiguous' });
  assert.equal(await manager.check(cli), true); assert.equal(manager.resolve(cli), null);
});
