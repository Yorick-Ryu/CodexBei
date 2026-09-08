const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const TOML = require('@iarna/toml');
const { ConfigStore, MODEL, atomicWrite } = require('../src/config.cjs');
const { patchPreset } = require('../src/toml-patch.cjs');
const { preset } = require('../src/config.cjs');
const KEY = 'sk-fixture-not-a-real-credential';

function fixture(t, initial, options = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.codex', 'config.toml');
  if (initial !== undefined) { fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, initial); }
  const store = new ConfigStore({ backupDir: path.join(dir, 'backups'), home: dir, env: {}, ...options });
  return { dir, file, store };
}

test('retention keeps ten newest backups, preserves the latest undo snapshot and ignores unrelated files', async (t) => {
  const { dir, file, store } = fixture(t, 'model="original"\n');
  const ids = [];
  for (let i = 0; i < 13; i++) {
    const metadata = store.snapshot(file, Buffer.from(`model="state-${i}"\n`), fs.readFileSync(file), 'configure');
    metadata.created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    fs.writeFileSync(path.join(store.backupDir, metadata.id, 'metadata.json'), JSON.stringify(metadata));
    ids.push(metadata.id);
  }
  fs.writeFileSync(path.join(store.backupDir, 'unrelated.txt'), 'keep');
  const trash = path.join(dir, 'trash'); fs.mkdirSync(trash);
  const move = async (folder) => fs.renameSync(folder, path.join(trash, path.basename(folder)));
  await store.pruneBackups(move);
  assert.deepEqual(store.list().map(item => item.id), ids.slice(3).reverse());
  for (const id of ids.slice(0, 3)) assert.ok(fs.existsSync(path.join(trash, id, 'metadata.json')));
  assert.equal(fs.readFileSync(path.join(store.backupDir, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(file, 'utf8'), 'model="original"\n');
  const state = store.inspectRestore(ids[3]);
  const restored = store.restore(ids[3], state.currentHash);
  // Even a backwards clock must not prune the snapshot needed to undo this restore.
  const metadataFile = path.join(store.backupDir, restored.backupId, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataFile)); metadata.created = '2020-01-01T00:00:00.000Z';
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await store.pruneBackups(move, restored.backupId);
  assert.equal(store.list().length, 10);
  assert.ok(store.list().some(item => item.id === restored.backupId));
  assert.equal(store.loadBackup(restored.backupId).bytes.toString(), 'model="original"\n');
});

test('failed retention leaves recovery snapshots and the current configuration intact', async (t) => {
  const { file, store } = fixture(t, 'model="original"\n');
  for (let i = 0; i < 11; i++) store.snapshot(file, fs.readFileSync(file), fs.readFileSync(file), 'configure');
  const ids = store.list().map(item => item.id);
  await assert.rejects(store.pruneBackups(async () => { throw new Error('trash unavailable'); }), /trash unavailable/);
  assert.deepEqual(store.list().map(item => item.id), ids);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model="original"\n');
});

test('backup list summarizes the saved endpoint and official login state without exposing keys or reading current settings', (t) => {
  const original = 'model_provider="custom"\n[model_providers.custom]\nbase_url="https://old.example/v1"\nrequires_openai_auth=true\nexperimental_bearer_token="' + KEY + '"\n';
  const { file, store } = fixture(t, original);
  const first = store.apply(store.prepare(file, KEY).id).backupId;
  const second = store.apply(store.prepare(file, KEY).id).backupId;
  const rows = store.list();
  assert.equal(rows.find(row => row.id === first).baseUrl, 'https://old.example/v1');
  assert.equal(rows.find(row => row.id === first).keepOfficialLogin, true);
  assert.equal(rows.find(row => row.id === second).baseUrl, 'https://api.beiapi.cn/v1');
  assert.equal(rows.find(row => row.id === second).keepOfficialLogin, false);
  assert.equal(JSON.stringify(rows).includes(KEY), false);
  const missing = store.snapshot(file, null, fs.readFileSync(file), 'configure');
  const row = store.list().find(row => row.id === missing.id);
  assert.equal(row.baseUrl, null);
  assert.equal(row.keepOfficialLogin, null);
});

test('model discovery reuses a saved key only for its own gateway, without writing config', (t) => {
  const initial = 'model_provider="custom"\nmodel="model-a"\n[model_providers.custom]\nbase_url="https://api.beiapi.cn/v1"\nexperimental_bearer_token="' + KEY + '"\n';
  const { file, store } = fixture(t, initial);
  assert.deepEqual(store.modelCredentials(file, '', 'https://api.beiapi.cn/v1'), { baseUrl: 'https://api.beiapi.cn/v1', apiKey: KEY });
  assert.throws(() => store.modelCredentials(file, '', 'https://other.example/v1'), /地址已更改/);
  assert.throws(() => store.modelCredentials(file, 'invalid', 'https://api.beiapi.cn/v1'), /密钥/);
  assert.equal(JSON.stringify(store.inspect(file)).includes(KEY), false);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
});

test('updating the preset preserves MCP, projects, other providers, extra headers and comments byte for byte', (t) => {
  const untouched = '# My tools\n[mcp_servers.editor]\ncommand = "node"\nargs = ["tool.js"]\n[mcp_servers.editor.env]\nMODE = "local"\n\n[projects."/work/repo"]\ntrust_level = "trusted"\n\n[model_providers.office]\nname = "office"\nbase_url = "https://example.com/v1"\n';
  const original = '# personal setup\nmodel = "old" # keep my note\nsandbox_mode = "workspace-write"\n[model_providers.custom]\nname = "old provider" # name comment\nbase_url = "https://example.com/v1"\nrequest_max_retries = 7\nhttp_headers = { "x-extra" = "keep" }\n\n' + untouched;
  const { file, store } = fixture(t, original);
  const plan = store.prepare(file, KEY);
  assert.equal(JSON.stringify(plan).includes(KEY), false);
  store.apply(plan.id);
  const output = fs.readFileSync(file, 'utf8');
  assert.ok(output.includes(untouched));
  assert.ok(output.includes('# personal setup\n'));
  assert.ok(output.includes('model = "gpt-6-astra" # keep my note'));
  assert.ok(output.includes('name = "OpenAI" # name comment'));
  const parsed = TOML.parse(output);
  assert.equal(parsed.sandbox_mode, 'workspace-write');
  assert.equal(parsed.model_providers.custom.request_max_retries, 7);
  assert.equal(parsed.model_providers.custom.http_headers['x-extra'], 'keep');
  assert.equal(parsed.model_providers.custom.experimental_bearer_token, KEY);
});

test('new configuration is backed up as absent and restoring removes only the generated file', (t) => {
  const { file, store } = fixture(t);
  const result = store.apply(store.prepare(file, KEY).id);
  assert.equal(TOML.parse(fs.readFileSync(file, 'utf8')).model, MODEL);
  const other = path.join(path.dirname(file), 'auth.json');
  fs.writeFileSync(other, '{"fixture":true}');
  store.restore(result.backupId, store.inspectRestore(result.backupId).currentHash);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(other, 'utf8'), '{"fixture":true}');
});

test('restore recovers the original bytes and keeps later edits in an undo backup', (t) => {
  const original = '# exact formatting\r\nmodel=\'old\'\r\n';
  const { file, store } = fixture(t, original);
  const configured = store.apply(store.prepare(file, KEY).id);
  const later = fs.readFileSync(file, 'utf8') + '\r\n[mcp_servers.later]\r\ncommand="new"\r\n';
  fs.writeFileSync(file, later);
  const state = store.inspectRestore(configured.backupId);
  assert.equal(state.changed, true);
  const restored = store.restore(configured.backupId, state.currentHash);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  store.restore(restored.backupId, store.inspectRestore(restored.backupId).currentHash);
  assert.equal(fs.readFileSync(file, 'utf8'), later);
});

test('invalid TOML does not overwrite the file or leak original contents', (t) => {
  const original = 'private_setting = "sensitive fixture\n';
  const { file, store } = fixture(t, original);
  assert.throws(() => store.prepare(file, KEY), (error) => !error.message.includes('sensitive fixture') && error.message.includes('TOML'));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(store.list().length, 0);
});

test('a file edited after preview cannot be overwritten', (t) => {
  const { file, store } = fixture(t, 'model="old"\n');
  const plan = store.prepare(file, KEY);
  fs.writeFileSync(file, 'model="edited"\n');
  assert.throws(() => store.apply(plan.id), /发生变化/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model="edited"\n');
});

test('backup failure leaves the original untouched', (t) => {
  const original = 'model="old"\n';
  const { file, store } = fixture(t, original, { write: () => { throw new Error('simulated disk full'); } });
  assert.throws(() => store.apply(store.prepare(file, KEY).id), /disk full/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('target write failure leaves original and valid backup intact', (t) => {
  const { file, store } = fixture(t, 'model="old"\n');
  store.write = (target, bytes) => {
    if (target === file) throw new Error('simulated write failure');
    atomicWrite(target, bytes);
  };
  assert.throws(() => store.apply(store.prepare(file, KEY).id), /write failure/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model="old"\n');
  assert.equal(store.list().length, 1);
});

test('tampered backup cannot replace current configuration', (t) => {
  const { file, store } = fixture(t, 'model="old"\n');
  const result = store.apply(store.prepare(file, KEY).id);
  const current = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(path.join(store.backupDir, result.backupId, 'config.toml'), 'model="tampered"');
  assert.throws(() => store.inspectRestore(result.backupId), /校验失败/);
  assert.equal(fs.readFileSync(file, 'utf8'), current);
});

test('concurrent change after restore confirmation is rejected', (t) => {
  const { file, store } = fixture(t, 'model="old"\n');
  const result = store.apply(store.prepare(file, KEY).id);
  const state = store.inspectRestore(result.backupId);
  fs.writeFileSync(file, 'model="edited"\n');
  assert.throws(() => store.restore(result.backupId, state.currentHash), /已改变/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'model="edited"\n');
});

test('symlink config and changed directory target are rejected', (t) => {
  const { dir, file, store } = fixture(t, 'model="old"\n');
  const other = path.join(dir, 'other.toml');
  fs.renameSync(file, other);
  fs.symlinkSync(other, file);
  assert.throws(() => store.prepare(file, KEY), /普通文件/);
  assert.equal(fs.readFileSync(other, 'utf8'), 'model="old"\n');
});

test('CODEX_HOME is detected before default directory without reading credentials', (t) => {
  const { dir, store } = fixture(t);
  store.env.CODEX_HOME = path.join(dir, 'custom-codex');
  const candidates = store.detect();
  assert.equal(candidates[0].file, path.join(dir, 'custom-codex', 'config.toml'));
  assert.equal(candidates[0].source, 'CODEX_HOME');
  assert.equal(candidates.length, 2);
});

test('active profile cannot be silently ignored', (t) => {
  const { file, store } = fixture(t, 'profile="work"\n[profiles.work]\nmodel="office"\n');
  assert.throws(() => store.prepare(file, KEY), /profile/);
});

test('incoming base URL updates provider and actor header together while preserving tools', (t) => {
  const original = '[mcp_servers.editor]\ncommand="keep"\n';
  const { file, store } = fixture(t, original);
  const plan = store.prepare(file, KEY, 'https://api.example.com/gateway/');
  assert.ok(plan.preview.includes('https://api.example.com/gateway/v1'));
  store.apply(plan.id);
  const config = TOML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.model_providers.custom.base_url, 'https://api.example.com/gateway/v1');
  assert.equal(config.model_providers.custom.http_headers['x-openai-actor-authorization'], config.model_providers.custom.base_url);
  assert.ok(fs.readFileSync(file, 'utf8').includes(original));
});

test('placeholder keys and path traversal backups are rejected', (t) => {
  const { file, store } = fixture(t);
  assert.throws(() => store.prepare(file, 'sk-your-api-key'), /占位符/);
  assert.throws(() => store.inspectRestore('../outside'), /无效/);
  assert.equal(fs.existsSync(file), false);
});

test('legacy authorization headers cannot override the new key while unrelated headers remain', () => {
  const source = '[model_providers.custom]\nhttp_headers={Authorization="old", "X-OpenAI-Actor-Authorization"="old-actor", "x-extra"="keep"}\nenv_http_headers={AUTHORIZATION="OLD_KEY", "x-openai-actor-authorization"="OLD_ACTOR", "x-trace"="TRACE_ID"}\n';
  const result = patchPreset(source, preset(KEY));
  const provider = TOML.parse(result.text).model_providers.custom;
  assert.equal(provider.http_headers.Authorization, undefined);
  assert.equal(provider.http_headers['X-OpenAI-Actor-Authorization'], undefined);
  assert.equal(provider.http_headers['x-extra'], 'keep');
  assert.deepEqual(provider.env_http_headers, { 'x-trace': 'TRACE_ID' });
  assert.equal(result.changes.filter((change) => change.action === '移除冲突认证项').length, 4);
});

test('a home path reached through an alias can create a new config without changing another directory', (t) => {
  const { dir, store } = fixture(t);
  const alias = path.join(dir, 'home-alias');
  fs.symlinkSync(dir, alias, 'dir');
  store.home = alias;
  const plan = store.prepare(store.detect()[0].file, KEY);
  const result = store.apply(plan.id);
  assert.equal(result.file, path.join(dir, '.codex', 'config.toml'));
});

for (const [name, source] of [
  ['inline tables', 'model_providers={custom={name="old", env_key="OLD", http_headers={"x-extra"="keep"}}, other={name="other"}}\n'],
  ['quoted tables and CRLF', '["model_providers"."custom"]\r\nenv_key="OLD"\r\nhttp_headers={"x-extra"="keep"}\r\n'],
  ['dotted keys', 'model_providers.custom.env_key="OLD"\nmodel_providers.custom.http_headers.x-extra="keep"\n'],
  ['command auth table', '[model_providers.custom.auth]\ncommand="old"\nargs=["token"]\n[model_providers.custom.http_headers]\nx-extra="keep"\n'],
  ['command auth dotted inside provider', '[model_providers.custom]\nauth.command="old"\nhttp_headers={"x-extra"="keep"}\n'],
]) {
  test(`${name}: updates managed values, preserves extra headers and removes conflicting auth`, () => {
    const result = patchPreset(source, preset(KEY));
    const config = TOML.parse(result.text);
    assert.equal(config.model, MODEL);
    assert.equal(config.model_providers.custom.http_headers['x-extra'], 'keep');
    assert.equal(config.model_providers.custom.env_key, undefined);
    assert.equal(config.model_providers.custom.auth, undefined);
    assert.ok(result.changes.some((change) => change.action === '移除冲突认证项'));
    assert.equal(patchPreset(result.text, preset(KEY)).text, result.text);
  });
}

test('selected model flows into preview and saved config while preserving tools', (t) => {
  const tools = '[mcp_servers.editor]\ncommand="node"\n';
  const { file, store } = fixture(t, 'model="old"\n'+tools);
  const plan = store.prepare(file, KEY, 'https://api.example.com/v1', 'gpt-5.6-terra');
  assert.equal(TOML.parse(plan.preview).model, 'gpt-5.6-terra');
  store.apply(plan.id);
  const output = fs.readFileSync(file, 'utf8');
  assert.equal(TOML.parse(output).model, 'gpt-5.6-terra');
  assert.ok(output.includes(tools));
  assert.throws(() => store.prepare(file, KEY, undefined, 'bad\nmodel'));
  assert.equal(fs.readFileSync(file, 'utf8'), output);
});

test('historical preview reads the selected snapshot, hides credentials while preserving ordinary values and never writes', (t) => {
  const original = '# api_key=fixture-comment-secret\nmodel="old-model"\nmodel_provider="custom"\ncustom_text="fixture-private-text"\n[model_providers.custom]\nbase_url="https://fixture-user:fixture-password@example.com/v1?token=fixture-query-secret"\nexperimental_bearer_token="fixture-bearer-secret"\nhttp_headers={ "x-custom"="fixture-header-secret" }\n[mcp_servers.editor]\nargs=["fixture-argument-secret"]\nenv={ API_KEY="fixture-env-secret", MODE="local" }\n';
  const { file, store } = fixture(t, original);
  const { backupId } = store.apply(store.prepare(file, KEY).id);
  const current = fs.readFileSync(file);
  const entries = fs.readdirSync(store.backupDir);
  const preview = store.previewBackup(backupId);
  assert.equal(preview.file, file);
  assert.equal(preview.existed, true);
  const parsed = TOML.parse(preview.content);
  assert.equal(parsed.model, 'old-model');
  assert.equal(new URL(parsed.model_providers.custom.base_url).pathname, '/v1');
  assert.equal(parsed.custom_text, 'fixture-private-text');
  assert.deepEqual(parsed.mcp_servers.editor.args, ['fixture-argument-secret']);
  assert.equal(parsed.mcp_servers.editor.env.MODE, 'local');
  assert.equal(parsed.model_providers.custom.http_headers['x-custom'], 'fixture-header-secret');
  for (const privateValue of ['fixture-comment-secret', 'fixture-password', 'fixture-query-secret', 'fixture-bearer-secret', 'fixture-env-secret', KEY]) {
    assert.equal(JSON.stringify(preview).includes(privateValue), false);
  }
  assert.deepEqual(fs.readFileSync(file), current);
  assert.equal(fs.readFileSync(path.join(store.backupDir, backupId, 'config.toml'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(store.backupDir), entries);
  fs.writeFileSync(path.join(store.backupDir, backupId, 'config.toml'), 'model="tampered"');
  assert.throws(() => store.previewBackup(backupId), /校验失败/);
  assert.throws(() => store.previewBackup('../config.toml'), /无效/);
});

test('historical preview distinguishes absent and empty configuration files', (t) => {
  for (const initial of [undefined, '']) {
    const { file, store } = fixture(t, initial);
    const { backupId } = store.apply(store.prepare(file, KEY).id);
    const preview = store.previewBackup(backupId);
    assert.equal(preview.existed, initial !== undefined);
    assert.equal(preview.content, '');
    assert.equal(fs.existsSync(file), true);
  }
});


test('historical preview preserves tool settings, references and token limits but masks embedded credentials', () => {
  const { backupPreview } = require('../src/backup-preview.cjs');
  const source = TOML.stringify({
    model_max_output_tokens: 8000,
    access_tokens: ['fixture-access-secret'],
    mcp_servers: { editor: { command: 'node', args: ['tool.js', '--api-key', 'fixture-flag-secret', '--token=fixture-inline-secret'], env: { MODE: 'local', API_KEY: 'fixture-env-secret' } } },
    model_providers: { custom: { env_key: 'OPENAI_API_KEY', base_url: 'https://example.com/gateway/v1?region=cn', http_headers: { 'x-extra': 'keep', Authorization: 'Bearer fixture-header-secret' } } },
  });
  const preview = backupPreview(Buffer.from(source));
  const parsed = TOML.parse(preview);
  assert.equal(parsed.model_max_output_tokens, 8000);
  assert.equal(parsed.mcp_servers.editor.command, 'node');
  assert.equal(parsed.mcp_servers.editor.args[0], 'tool.js');
  assert.equal(parsed.model_providers.custom.env_key, 'OPENAI_API_KEY');
  assert.equal(parsed.model_providers.custom.base_url, 'https://example.com/gateway/v1?region=cn');
  assert.equal(parsed.model_providers.custom.http_headers['x-extra'], 'keep');
  for (const secret of ['fixture-flag-secret', 'fixture-inline-secret', 'fixture-env-secret', 'fixture-header-secret', 'fixture-access-secret']) assert.equal(preview.includes(secret), false);
});

test('deleting one backup moves only that verified snapshot to trash and preserves the current config', async (t) => {
  const { dir, file, store } = fixture(t, 'model="old"\n');
  const first = store.apply(store.prepare(file, KEY).id).backupId;
  const second = store.apply(store.prepare(file, KEY).id).backupId;
  const current = fs.readFileSync(file);
  const trash = path.join(dir, 'trash');
  const result = await store.deleteBackup(first, async (folder) => {
    assert.equal(folder, path.join(store.backupDir, first));
    fs.renameSync(folder, trash);
  });
  assert.deepEqual(result, { id: first });
  assert.deepEqual(store.list().map(item => item.id), [second]);
  assert.equal(fs.readFileSync(path.join(trash, 'config.toml'), 'utf8'), 'model="old"\n');
  assert.deepEqual(fs.readFileSync(file), current);
  await assert.rejects(store.deleteBackup('../config.toml', () => assert.fail('must not trash invalid path')), /无效/);
  await assert.rejects(store.deleteBackup(first, () => assert.fail('must not trash missing backup')), /不存在/);
  await assert.rejects(store.deleteBackup(second, async () => { throw new Error('fixture trash unavailable'); }), /trash unavailable/);
  assert.equal(store.list().length, 1);
  assert.deepEqual(fs.readFileSync(file), current);
});

test('official login choice agrees with preview, persists both ways and leaves login credentials untouched', (t) => {
  const { file, store } = fixture(t, 'model="old"\n');
  const auth = path.join(path.dirname(file), 'auth.json');
  fs.writeFileSync(auth, 'fixture-official-login-state');
  const template = structuredClone(require('../src/bootstrap-manifest.json').templates[0]);
  const originalTemplate = JSON.stringify(template);
  for (const keepOfficialLogin of [true, false]) {
    const before = fs.readFileSync(file);
    const plan = store.prepare(file, keepOfficialLogin ? KEY : '', undefined, undefined, template, keepOfficialLogin);
    assert.equal(TOML.parse(plan.preview).model_providers.custom.requires_openai_auth, keepOfficialLogin);
    assert.deepEqual(fs.readFileSync(file), before);
    const applied = store.apply(plan.id);
    assert.equal(TOML.parse(fs.readFileSync(file, 'utf8')).model_providers.custom.requires_openai_auth, keepOfficialLogin);
    assert.equal(store.inspect(file).keepOfficialLogin, keepOfficialLogin);
    assert.equal(fs.readFileSync(auth, 'utf8'), 'fixture-official-login-state');
    assert.equal(fs.readFileSync(path.join(store.backupDir, applied.backupId, 'config.toml')).equals(before), true);
  }
  assert.equal(JSON.stringify(template), originalTemplate);
  for (const invalid of ['true', 1, null, {}]) assert.throws(() => store.prepare(file, KEY, undefined, undefined, template, invalid), /官方登录选项无效/);
});

test('explicit official login choice survives a remote template removing that field', (t) => {
  const { file, store } = fixture(t, 'model="old"\n');
  const template = structuredClone(require('../src/bootstrap-manifest.json').templates[0]);
  delete template.set.model_providers.custom.requires_openai_auth;
  template.remove.push(['model_providers', 'custom', 'requires_openai_auth']);
  const plan = store.prepare(file, KEY, undefined, undefined, template, true);
  assert.equal(TOML.parse(plan.preview).model_providers.custom.requires_openai_auth, true);
  assert.equal(plan.preview.includes('# model_providers.custom.requires_openai_auth'), false);
  store.apply(plan.id);
  assert.equal(store.inspect(file).keepOfficialLogin, true);
});

test('backup preview retains original inline and table formatting and shows the actor endpoint without exposing tokens', () => {
  const { backupPreview } = require('../src/backup-preview.cjs');
  for (const headers of [
    'http_headers = { "x-openai-actor-authorization" = "https://api.beiapi.cn/v1", "Authorization" = "Bearer fixture-secret" }',
    '[model_providers.custom.http_headers]\r\n"x-openai-actor-authorization" = "https://api.beiapi.cn/v1"\r\nAuthorization = "Bearer fixture-secret"',
  ]) {
    const source = '# My provider\r\n[model_providers.custom]\r\nbase_url = "https://api.beiapi.cn/v1"\r\nexperimental_bearer_token = "fixture-key" # key stays local\r\n' + headers + '\r\n';
    const expected = source.replace('"fixture-key"', '"（已隐藏）"').replace('"Bearer fixture-secret"', '"（已隐藏）"');
    assert.equal(backupPreview(Buffer.from(source)), expected);
  }
});

test('format-preserving previews redact multiline, quoted, array and comment credentials', () => {
  const { backupPreview } = require('../src/backup-preview.cjs');
  const source = '# ordinary note\n# API_KEY="fixture-comment"\n[model_providers.custom]\nbase_url="https://api.beiapi.cn/v1"\nexperimental_bearer_token="""fixture-multiline\nsecond-line"""\nhttp_headers={"x-openai-actor-authorization"="Bearer fixture-actor"}\n[[tools]]\n"api_key"="fixture-quoted"\nargs=["tool.js", "--api-key", "fixture-argument"]\n';
  const preview = backupPreview(Buffer.from(source));
  assert.ok(preview.startsWith('# ordinary note\n'));
  assert.ok(preview.includes('[[tools]]'));
  assert.equal(TOML.parse(preview).tools[0].args[0], 'tool.js');
  for (const secret of ['fixture-comment', 'fixture-multiline', 'second-line', 'fixture-actor', 'fixture-quoted', 'fixture-argument']) assert.equal(preview.includes(secret), false);
});
