const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { origin, currentKey, installers, validateSnapshot, handleRelease } = require('../worker/releases.cjs');
const { digest, contentType } = require('../scripts/lib/release-store.cjs');
const { prepareUpload, upload, putImmutable, activate, checkDeployment } = require('../scripts/publish-app-release.cjs');
const { prepare } = require('../scripts/prepare-app-release.cjs');

function fixture(version = '0.1.5') {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-r2-test-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-r2-stage-'));
  const targets = { 'darwin-aarch64': `CodexBei_${version}_arm.app.tar.gz`, 'darwin-x86_64': `CodexBei_${version}_intel.app.tar.gz`,
    'windows-x86_64': `CodexBei_${version}_x64-setup.exe`, 'windows-aarch64': `CodexBei_${version}_arm64-setup.exe` };
  const write = (name, bytes) => fs.writeFileSync(path.join(source, name), bytes);
  for (const name of installers(version)) write(name, `installer-${name}`);
  for (const [platform, file] of Object.entries(targets)) {
    const signature = 'A'.repeat(200);
    write(file, `artifact-${platform}`); write(file + '.sig', signature);
    write(`${platform}.update.json`, JSON.stringify({ version, platform, file, signature, sha256: digest(fs.readFileSync(path.join(source, file))) }));
  }
  write('private.key', 'never publish');
  write('SHA256SUMS', fs.readdirSync(source).map(name => `${digest(fs.readFileSync(path.join(source, name)))}  ${name}\n`).join(''));
  const release = prepare(source, `${origin}/downloads/${version}/`, 'Release notes');
  const prepared = prepareUpload(source, release, staging);
  return { prepared, close() { fs.rmSync(source, { recursive: true }); fs.rmSync(staging, { recursive: true }); } };
}

function storage() {
  const objects = new Map(), writes = [];
  const store = {
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? new Response(null, { headers: { 'x-amz-meta-sha256': digest(bytes), 'content-length': String(bytes.length) } }) : null;
    },
    async get(key) { const bytes = objects.get(key); return bytes ? new Response(bytes, { headers: { etag: `"${digest(bytes)}"` } }) : null; },
    async put(key, body, sha256, etag) {
      const old = objects.get(key);
      if (etag ? !old || `"${digest(old)}"` !== etag : old) throw Error('Remote object changed');
      const bytes = Buffer.from(await new Response(body).arrayBuffer());
      assert.equal(digest(bytes), sha256);
      writes.push(key); objects.set(key, bytes);
    },
  };
  const object = (key, options = {}) => {
    const bytes = objects.get(key); if (!bytes) return null;
    const etag = digest(bytes), range = options.range;
    const metadata = { size: bytes.length, etag, httpEtag: `"${etag}"`,
      writeHttpMetadata(headers) { headers.set('Content-Type', contentType(key)); } };
    if (options.onlyIf && options.onlyIf.etagMatches !== etag) return metadata;
    return { ...metadata, body: new Response(range ? bytes.subarray(range.offset, range.offset + range.length) : bytes).body,
      json: async () => JSON.parse(bytes) };
  };
  return { objects, writes, store, bucket: { head: async key => object(key), get: async (key, options) => object(key, options) } };
}

test('release storage: uploads only allowlisted public files and repeated upload is idempotent', async () => {
  const f = fixture(), s = storage();
  try {
    await upload(s.store, f.prepared);
    assert.equal(s.objects.has(currentKey), false);
    assert.equal([...s.objects.keys()].some(key => key.includes('private.key') || key.endsWith('.update.json')), false);
    assert.equal(s.writes.at(-1), 'releases/0.1.5.json');
    const count = s.writes.length;
    await upload(s.store, f.prepared);
    assert.equal(s.writes.length, count);
    const file = f.prepared.files[0];
    await assert.rejects(putImmutable(s.store, { ...file, sha256: digest('different') }, Buffer.from('different')), /Refusing to replace/);
    assert.equal(s.writes.length, count);
  } finally { f.close(); }
});

test('release storage: partial uploads and corrupted objects cannot activate a release', async () => {
  const f = fixture(), s = storage();
  try {
    const originalPut = s.store.put;
    s.store.put = async (...args) => { if (s.writes.length === 2) throw Error('connection lost'); return originalPut(...args); };
    await assert.rejects(upload(s.store, f.prepared), /connection lost/);
    assert.equal(s.objects.has('releases/0.1.5.json'), false);
    await assert.rejects(activate(s.store, '0.1.5', 'none', false, true), /Upload and verify/);
    assert.equal(s.objects.has(currentKey), false);
    s.store.put = originalPut;
    await upload(s.store, f.prepared);
    s.objects.set(f.prepared.files[0].key, Buffer.from('corrupted'));
    await assert.rejects(activate(s.store, '0.1.5', 'none', false, true), /checksum mismatch/);
    assert.equal(s.objects.has(currentKey), false);
  } finally { f.close(); }
});

test('release storage: activation and rollback change only the pointer, retain historical files and reject races', async () => {
  const old = fixture('0.1.4'), next = fixture(), s = storage();
  try {
    await upload(s.store, old.prepared); await upload(s.store, next.prepared);
    await activate(s.store, '0.1.4', 'none', false, true);
    const before = new Map(s.objects);
    await activate(s.store, '0.1.5', '0.1.4');
    assert.deepEqual(s.objects, before); // Read-only verification does not publish.
    await activate(s.store, '0.1.5', '0.1.4', false, true);
    for (const [key, bytes] of before) if (key !== currentKey) assert.deepEqual(s.objects.get(key), bytes);
    await assert.rejects(activate(s.store, '0.1.4', '0.1.5', false, true), /--rollback/);
    await activate(s.store, '0.1.4', '0.1.5', true, true);
    const originalPut = s.store.put;
    s.store.put = async (...args) => {
      if (args[0] === currentKey) s.objects.set(currentKey, Buffer.from('concurrent publisher'));
      return originalPut(...args);
    };
    await assert.rejects(activate(s.store, '0.1.5', '0.1.4', false, true), /Remote object changed/);
    assert.equal(s.objects.get(currentKey).toString(), 'concurrent publisher');
  } finally { old.close(); next.close(); }
});

test('release HTTP: latest links and updater use the same pointer; direct old URLs survive activation', async () => {
  const old = fixture('0.1.4'), next = fixture(), s = storage();
  const request = route => new Request(origin + route);
  try {
    await upload(s.store, old.prepared); await upload(s.store, next.prepared);
    await activate(s.store, '0.1.4', 'none', false, true);
    await activate(s.store, '0.1.5', '0.1.4', false, true);
    const redirect = await handleRelease(request('/downloads/latest/CodexBei_x64-setup.exe'), s.bucket);
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), '/downloads/0.1.5/CodexBei_0.1.5_x64-setup.exe');
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    const update = await handleRelease(request('/updates/v1/darwin/aarch64/0.1.4'), s.bucket);
    assert.equal((await update.json()).version, '0.1.5');
    assert.equal((await handleRelease(request('/updates/v1/darwin/aarch64/0.1.5'), s.bucket)).status, 204);
    const historical = await handleRelease(request('/downloads/0.1.4/CodexBei_0.1.4_x64-setup.exe'), s.bucket);
    assert.equal(historical.status, 200);
    assert.equal(await historical.text(), 'artifact-windows-x86_64');
    assert.equal((await handleRelease(request('/releases/current.json'), s.bucket)).status, 404);
    assert.equal((await handleRelease(request('/downloads/0.1.5/private.key'), s.bucket)).status, 404);
    s.objects.delete(currentKey);
    assert.equal((await handleRelease(request('/updates/v1/darwin/aarch64/0.1.4'), s.bucket)).status, 503);
    assert.equal((await handleRelease(request('/downloads/0.1.4/CodexBei_0.1.4_x64-setup.exe'), s.bucket)).status, 200);
  } finally { old.close(); next.close(); }
});

test('release HTTP: binary downloads support HEAD, conditional requests and byte ranges', async () => {
  const s = storage(), key = 'downloads/0.1.4/CodexBei_0.1.4_x64-setup.exe';
  s.objects.set(key, Buffer.from('0123456789'));
  const request = options => handleRelease(new Request(`${origin}/${key}`, options), s.bucket);
  const head = await request({ method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal((await request({ headers: { 'If-None-Match': head.headers.get('etag') } })).status, 304);
  for (const [value, expected] of [['bytes=2-5', '2345'], ['bytes=-3', '789'], ['bytes=7-', '789']]) {
    const response = await request({ headers: { Range: value } });
    assert.equal(response.status, 206); assert.equal(await response.text(), expected);
  }
  const invalid = await request({ headers: { Range: 'bytes=20-' } });
  assert.equal(invalid.status, 416); assert.equal(invalid.headers.get('content-range'), 'bytes */10');
  const changed = await request({ headers: { Range: 'bytes=2-5', 'If-Range': '"old"' } });
  assert.equal(changed.status, 200); assert.equal(await changed.text(), '0123456789');
  assert.equal((await request({ method: 'POST' })).status, 405);
});

test('release snapshots reject missing artifacts, cross-version links and private file paths', () => {
  const f = fixture();
  try {
    for (const mutate of [
      value => value.files.pop(),
      value => value.files.push({ key: 'private.key', sha256: 'a'.repeat(64), size: 1 }),
      value => value.release.platforms['darwin-aarch64'].url = `${origin}/downloads/0.1.4/old.app.tar.gz`,
      value => value.release.platforms['darwin-aarch64'].url = 'https://example.com/app.tar.gz',
    ]) {
      const bad = structuredClone(f.prepared.snapshot); mutate(bad);
      assert.throws(() => validateSnapshot(bad));
    }
  } finally { f.close(); }
});

test('release deployment preflight rejects empty storage, missing legacy releases and damaged objects', async () => {
  const old = fixture('0.1.4'), next = fixture(), s = storage();
  try {
    await assert.rejects(checkDeployment(s.store, old.prepared.snapshot.release), /Migrate historical/);
    await upload(s.store, next.prepared);
    await activate(s.store, '0.1.5', 'none', false, true);
    await assert.rejects(checkDeployment(s.store, old.prepared.snapshot.release), /not been migrated/);
    await upload(s.store, old.prepared);
    assert.equal(await checkDeployment(s.store, old.prepared.snapshot.release), '0.1.5');
    s.objects.delete(old.prepared.files.find(file => file.key.endsWith('.exe')).key);
    await assert.rejects(checkDeployment(s.store, old.prepared.snapshot.release), /missing or changed/);
  } finally { old.close(); next.close(); }
});

test('legacy import validates checksums without requiring updater metadata and excludes private files', () => {
  const { legacyFiles } = require('../scripts/import-legacy-downloads.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-legacy-'));
  try {
    fs.writeFileSync(path.join(directory, 'old.exe'), 'legacy');
    fs.writeFileSync(path.join(directory, 'private.key'), 'private');
    fs.writeFileSync(path.join(directory, 'SHA256SUMS'), `${digest('legacy')}  old.exe\n${digest('private')}  private.key\n`);
    const files = legacyFiles('0.1.0', directory);
    assert.deepEqual(files.map(file => file.key), ['downloads/0.1.0/old.exe', 'downloads/0.1.0/SHA256SUMS']);
    assert.equal(files.at(-1).bytes.includes('private.key'), false);
    fs.writeFileSync(path.join(directory, 'old.exe'), 'tampered');
    assert.throws(() => legacyFiles('0.1.0', directory), /checksum mismatch/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
