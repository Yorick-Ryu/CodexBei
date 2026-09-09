const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleUpdate, validateAppRelease } = require('../worker/updates.cjs');
const request = (version = '0.1.0', platform = 'darwin/aarch64') => new Request(`https://codexbei.beiapi.cn/updates/v1/${platform}/${version}`);
const release = {
  version: '0.2.0', notes: '修复与改进', pub_date: '2026-09-08T00:00:00Z',
  platforms: { 'darwin-aarch64': { url: 'https://codexbei.beiapi.cn/downloads/CodexBei.app.tar.gz', signature: 'A'.repeat(200) } },
};
test('updater: unpublished, equal, older and missing platform return 204', () => {
  for (const [req, feed] of [[request(), null], [request('0.2.0'), release], [request('1.0.0'), release], [request('0.1.0', 'windows/x86_64'), release]]) {
    const response = handleUpdate(req, feed);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
test('updater: newer release provides only the requested signed artifact', async () => {
  const response = handleUpdate(request(), release);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: release.version, notes: release.notes, pub_date: release.pub_date, ...release.platforms['darwin-aarch64'] });
  assert.equal(handleUpdate(request('0.2.0-beta.1'), release).status, 200);
});
test('updater: invalid metadata never becomes an install offer', () => {
  for (const change of [r => r.version = 'latest', r => r.version = '0.3.0-beta.1', r => r.platforms = {}, r => r.platforms['darwin-aarch64'].url = 'http://example.com/app', r => r.platforms['darwin-aarch64'].signature = '', r => r.pub_date = 'yesterday']) {
    const broken = structuredClone(release); change(broken);
    assert.throws(() => validateAppRelease(broken));
    assert.equal(handleUpdate(request(), broken).status, 503);
  }
});
test('updater: transport, methods, paths and versions are constrained', () => {
  assert.equal(handleUpdate(new Request(request().url, { method: 'POST' }), release).status, 405);
  assert.equal(handleUpdate(new Request(request().url.replace('https:', 'http:')), release).status, 400);
  assert.equal(handleUpdate(request('invalid'), release).status, 400);
  assert.equal(handleUpdate(request('%ZZ'), release).status, 400);
  assert.equal(handleUpdate(new Request(request().url + '?key=example'), release).status, 404);
});
test('release preparation detects changed archives and mixed versions before publishing', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createHash } = require('node:crypto');
  const { prepare } = require('../scripts/prepare-app-release.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-feed-'));
  try {
    const file = 'CodexBei.app.tar.gz', signature = 'A'.repeat(200), bytes = Buffer.from('fixture archive');
    fs.writeFileSync(path.join(dir, file), bytes); fs.writeFileSync(path.join(dir, file + '.sig'), signature);
    const metadata = { version: '0.2.0', platform: 'darwin-aarch64', file, signature, sha256: createHash('sha256').update(bytes).digest('hex') };
    fs.writeFileSync(path.join(dir, 'darwin-aarch64.update.json'), JSON.stringify(metadata));
    assert.equal(prepare(dir, 'https://example.com/releases/0.2.0', '修复').platforms['darwin-aarch64'].url, 'https://example.com/releases/0.2.0/CodexBei.app.tar.gz');
    fs.writeFileSync(path.join(dir, file), 'changed');
    assert.throws(() => prepare(dir, 'https://example.com/releases', ''), /changed/);
    fs.writeFileSync(path.join(dir, file), bytes);
    fs.writeFileSync(path.join(dir, 'darwin-x86_64.update.json'), JSON.stringify({ ...metadata, platform: 'darwin-x86_64', version: '0.3.0' }));
    assert.throws(() => prepare(dir, 'https://example.com/releases', ''), /Mixed versions/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
