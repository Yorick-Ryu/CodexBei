const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { validateManifest, selectTemplate, materialize } = require('../src/template-policy.cjs');
const { TemplateStore, RESOLVE_URL, MAX_BYTES } = require('../src/template-store.cjs');
const { ConfigStore } = require('../src/config.cjs');
const { detectInstallations, selectInstallations, parseVersion } = require('../src/codex-versions.cjs');
const { resolveResponse, requestFor } = require('../src/version-request.cjs');
const bootstrap = require('../src/bootstrap-manifest.json');
const KEY = 'sk-fixture-not-a-real-credential';
const clone = () => structuredClone(bootstrap);
const cli = { kind: 'cli', runtimeVersion: '0.153.4' };
function temporary(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-policy-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function updated() {
  const m = clone(); m.release = bootstrap.release + 1; m.templates[0].version = '1.1.0';
  m.templates[0].set.model_reasoning_effort = 'xhigh';
  delete m.templates[0].set.disable_response_storage;
  m.templates[0].remove = [['disable_response_storage']];
  return m;
}

test('matching uses CLI and desktop runtime versions independently, with explicit manual fallback', () => {
  const m = clone();
  assert.ok(selectTemplate(m, [cli], '0.3.1'));
  assert.equal(selectTemplate(m, [cli, { kind: 'desktop', runtimeVersion: '0.152.1', appVersion: '26.901.51231' }], '0.3.1'), null);
  assert.equal(selectTemplate(m, [{ kind: 'desktop', runtimeVersion: null, appVersion: '26.901.51231' }], '0.3.1'), null);
  assert.equal(selectTemplate(m, [cli], '0.1.5'), null);
  assert.equal(selectTemplate(m, [], '0.3.1'), null);
  const selected = selectInstallations([], { mode: 'manual', kind: 'desktop', runtimeVersion: '0.153.4', appVersion: '26.901.51231' });
  assert.ok(selectTemplate(m, selected, '0.3.1'));
  assert.throws(() => selectInstallations([], { mode: 'manual', kind: 'desktop', runtimeVersion: 'latest' }));
  m.templates[0].targets[1].appRange = { min: '27.0.0', maxExclusive: '28.0.0' };
  assert.equal(selectTemplate(m, selected, '0.3.1'), null);
  assert.equal(selectTemplate(m, [{ kind: 'cli', runtimeVersion: '0.153.4-beta.1' }], '0.3.1'), null);
});

test('higher matching template wins and equal-priority ambiguous templates are rejected', () => {
  const m = updated(); m.templates.push(clone().templates[0]);
  assert.equal(selectTemplate(m, [cli], '0.3.1').version, '1.1.0');
  m.templates.push({ ...structuredClone(m.templates[0]), id: 'overlapping' });
  assert.equal(selectTemplate(m, [cli], '0.3.1'), null);
});

test('remote templates cannot overwrite user models, carry credentials, touch unrelated settings or delete entire tables', () => {
  for (const mutate of [
    (t) => { t.set.model = 'gpt-6-astra'; },
    (t) => { t.set.model_providers.custom.experimental_bearer_token = KEY; },
    (t) => { t.set.model_providers.custom.base_url = 'https://other.example/v1'; },
    (t) => { t.set.mcp_servers = { injected: { command: 'arbitrary' } }; },
    (t) => { t.remove = [['model_providers', 'custom']]; },
    (t) => { t.remove = [['model']]; },
    (t) => { t.remove = [['model_reasoning_effort']]; },
    (t) => { t.set.model_providers.custom.requires_openai_auth = true; },
    (t) => { t.set.model_providers.custom.request_max_retries = 100000; },
    (t) => { t.targets[0].runtimeRange = 'latest'; },
  ]) {
    const m = clone(); mutate(m.templates[0]); assert.throws(() => validateManifest(m));
  }
  const poisoned = JSON.parse(JSON.stringify(clone()).replace('"name":"OpenAI"', '"__proto__":{"polluted":true},"name":"OpenAI"'));
  assert.throws(() => validateManifest(poisoned));
  assert.equal({}.polluted, undefined);
});

test('remote values bind the selected model and connection only when applying locally', () => {
  const result = materialize(updated().templates[0], { apiKey: KEY, baseUrl: 'https://example.com/v1', model: 'gpt-5.6-terra' });
  assert.equal(result.model, 'gpt-5.6-terra');
  assert.equal(result.model_providers.custom.experimental_bearer_token, KEY);
  assert.equal(result.model_reasoning_effort, 'xhigh');
  assert.equal(JSON.stringify(bootstrap).includes(KEY), false);
});

test('remote refresh caches validated releases without sending local data and survives offline restart', async (t) => {
  const directory = temporary(t);
  let requests = 0;
  const manager = new TemplateStore({ directory, clientVersion: '0.3.1', fetchImpl: async (url, options) => {
    requests++; assert.equal(url, RESOLVE_URL); assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST'); assert.deepEqual(JSON.parse(options.body), requestFor([cli], '0.3.1')); assert.equal(options.body.includes(KEY), false);
    return new Response(JSON.stringify(resolveResponse(updated(), requestFor([cli], '0.3.1'))));
  } });
  await Promise.all([manager.check([cli]), manager.check([cli])]); assert.equal(requests, 1);
  assert.equal(manager.resolve([cli]).template.version, '1.1.0');
  const bytes = fs.readFileSync(path.join(directory, 'resolved-templates.json'), 'utf8'); assert.equal(bytes.includes(KEY), false);
  const restarted = new TemplateStore({ directory, clientVersion: '0.3.1', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await restarted.check([cli]), false); assert.equal(restarted.resolve([cli]).template.version, '1.1.0');
  assert.equal(restarted.resolve([cli]).offline, true);
});

test('invalid, oversized, stale and silently mutated updates cannot replace the last usable cache', async (t) => {
  const directory = temporary(t); let response = () => new Response(JSON.stringify(resolveResponse(updated(), requestFor([cli], '0.3.1'))));
  const manager = new TemplateStore({ directory, clientVersion: '0.3.1', fetchImpl: async () => response() });
  assert.equal(await manager.check([cli]), true);
  const before = fs.readFileSync(path.join(directory, 'resolved-templates.json'));
  const mutated = updated(); mutated.templates[0].set.model_reasoning_effort = 'low';
  const futureSchema = updated(); futureSchema.schemaVersion = 2;
  for (const data of [clone(), mutated, futureSchema, { error: 'bad' }]) {
    response = () => new Response(JSON.stringify(data.templates ? { ...resolveResponse(data, requestFor([cli], '0.3.1')), schemaVersion: data.schemaVersion } : data)); assert.equal(await manager.check([cli]), false);
    assert.deepEqual(fs.readFileSync(path.join(directory, 'resolved-templates.json')), before);
  }
  response = () => new Response('a'.repeat(MAX_BYTES + 1)); assert.equal(await manager.check([cli]), false);
  response = () => new Response('', { status: 503 }); assert.equal(await manager.check([cli]), false);
  assert.equal(manager.resolve([cli]).template.version, '1.1.0');
});

test('corrupt disk cache falls back to the bundled validated policy, never an arbitrary version', (t) => {
  const directory = temporary(t); fs.writeFileSync(path.join(directory, 'resolved-templates.json'), 'broken');
  const manager = new TemplateStore({ directory, clientVersion: '0.3.1' });
  assert.equal(manager.resolve([cli]).source, 'bundled');
  assert.equal(manager.resolve([{ kind: 'cli', runtimeVersion: '0.150.0' }]), null);
});

test('template update keeps the stored key and user model, removes only a named deprecated field and restores exact original bytes', (t) => {
  const dir = temporary(t), file = path.join(dir, 'config.toml');
  const original = `model_provider="custom"\nmodel="gpt-5.6-terra"\ndisable_response_storage=true # old\n[model_providers.custom]\nexperimental_bearer_token="${KEY}"\nbase_url="https://example.com/v1"\nrequest_max_retries=7\n[mcp_servers.editor]\ncommand="node"\n[projects."/work"]\ntrust_level="trusted"\n`;
  fs.writeFileSync(file, original);
  const store = new ConfigStore({ backupDir: path.join(dir, 'backups'), home: dir, env: {} });
  const info = store.inspect(file); assert.equal(info.connection.hasKey, true); assert.equal(JSON.stringify(info).includes(KEY), false);
  const plan = store.prepare(file, '', info.connection.baseUrl, info.connection.model, updated().templates[0]);
  assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(plan.preview.includes(KEY), false);
  const result = store.apply(plan.id), config = TOML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.model, 'gpt-5.6-terra'); assert.equal(config.model_providers.custom.experimental_bearer_token, KEY);
  assert.equal(config.disable_response_storage, undefined); assert.equal(config.model_providers.custom.request_max_retries, 7);
  assert.ok(fs.readFileSync(file, 'utf8').includes('[mcp_servers.editor]\ncommand="node"\n[projects."/work"]\ntrust_level="trusted"\n'));
  assert.equal(store.inspect(file).template.version, '1.1.0');
  store.restore(result.backupId, store.inspectRestore(result.backupId).currentHash);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('CLI and app executables are probed independently, including a desktop app whose runtime is unknown', async () => {
  const calls = [];
  const options = { platform: 'darwin', home: '/fixture', env: { PATH: '/fixture/bin' }, exists: (p) => ['/fixture/bin/codex', '/Applications/ChatGPT.app/Contents/Info.plist', '/Applications/ChatGPT.app/Contents/Resources/codex'].includes(p), run: async (file, args) => {
    calls.push([file, args]);
    if (file === '/usr/bin/mdfind') return '';
    if (file === '/usr/bin/plutil') return JSON.stringify({ CFBundleIdentifier: 'com.openai.codex', CFBundleShortVersionString: '26.901.51231' });
    if (file === '/fixture/bin/codex') return 'codex-cli 0.153.4';
    if (file.endsWith('/Resources/codex')) return 'codex-cli 0.152.1';
    throw new Error('unexpected command');
  } };
  const found = await detectInstallations(options);
  assert.deepEqual(found.map((x) => [x.kind, x.runtimeVersion]), [['cli', '0.153.4'], ['desktop', '0.152.1']]);
  assert.equal(found[1].appVersion, '26.901.51231');
  const run = options.run; options.run = async (file, args) => file.endsWith('/Resources/codex') ? 'unrecognized output' : run(file, args);
  assert.equal((await detectInstallations(options))[1].runtimeVersion, null);
  assert.equal(parseVersion('CodexBei 0.153.4'), null);
});

test('Windows package detection probes its bundled executable without treating the app version as the runtime version', async () => {
  const win = path.win32;
  const cliFile = 'C:\\tools\\codex.exe';
  const location = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex';
  const desktopFile = win.join(location, 'app/resources', 'codex.exe');
  const found = await detectInstallations({ platform: 'win32', home: 'C:\\Users\\fixture', env: {}, exists: (p) => [cliFile, desktopFile].includes(p), run: async (file) => {
    if (file === 'where.exe') return cliFile;
    if (file === 'powershell.exe') return JSON.stringify([{ InstallLocation: location, Version: '26.901.51231.0' }]);
    if (file === cliFile) return 'codex-cli 0.153.4';
    if (file === desktopFile) return 'codex-cli 0.152.1';
    throw new Error('unexpected command');
  } });
  assert.deepEqual(found.map((item) => [item.kind, item.runtimeVersion]), [['cli', '0.153.4'], ['desktop', '0.152.1']]);
  assert.equal(found[1].appDisplayVersion, '26.901.51231.0');
  assert.equal(found[1].appVersion, '26.901.51231.0');
});

test('explicit leaf deletion supports quoted, dotted and inline TOML without dropping nearby custom fields', () => {
  const { patchPreset } = require('../src/toml-patch.cjs');
  for (const original of [
    '[model_providers.custom]\nrequest_max_retries=8 # old\nstream_max_retries=6 # keep\n',
    'model_providers.custom.request_max_retries=8\nmodel_providers.custom.stream_max_retries=6\n',
    'model_providers={custom={request_max_retries=8,stream_max_retries=6}}\n',
    '["model_providers"."custom"]\r\n"request_max_retries"=8\r\nstream_max_retries=6\r\n',
  ]) {
    const result = patchPreset(original, {}, [['model_providers', 'custom', 'request_max_retries']]);
    const parsed = TOML.parse(result.text);
    assert.equal(parsed.model_providers.custom.request_max_retries, undefined);
    assert.equal(parsed.model_providers.custom.stream_max_retries, 6);
  }
  assert.throws(() => patchPreset('[disable_response_storage]\ncustom=1\n', {}, [['disable_response_storage']]));
});

test('written preset and redacted preview agree, with the requested auth setting and inline headers', (t) => {
  const dir = temporary(t), file = path.join(dir, 'config.toml');
  const store = new ConfigStore({ backupDir: path.join(dir, 'backups'), home: dir, env: {} });
  const plan = store.prepare(file, KEY, 'https://api.beiapi.cn/v1', 'gpt-6-astra');
  store.apply(plan.id);
  const actual = fs.readFileSync(file, 'utf8');
  assert.equal(actual.replace(KEY, 'sk-••••••••（你的密钥）'), plan.preview);
  assert.equal(TOML.parse(actual).model_providers.custom.requires_openai_auth, false);
  assert.ok(actual.includes('http_headers = { "x-openai-actor-authorization" = "https://api.beiapi.cn/v1" }'));
  assert.equal(/^\s+\[/m.test(actual.replace(/\n\n/g, '\n')), false);
  const { patchPreset } = require('../src/toml-patch.cjs');
  const preset = materialize(bootstrap.templates[0], { apiKey: KEY, baseUrl: 'https://api.beiapi.cn/v1', model: 'gpt-6-astra' });
  const original = '[model_providers.custom] # provider comment\nrequires_openai_auth=true # auth comment\n\n[mcp_servers.editor]\ncommand="node"\n';
  const result = patchPreset(original, preset).text;
  assert.ok(result.includes('[model_providers.custom] # provider comment\nrequires_openai_auth=false # auth comment\n'));
  assert.ok(result.endsWith('[mcp_servers.editor]\ncommand="node"\n'));
  assert.equal(result.includes('\n\n\n'), false);
  assert.deepEqual(TOML.parse(result).model_providers.custom, preset.model_providers.custom);
  assert.equal(patchPreset(result, preset).text, result);
});
