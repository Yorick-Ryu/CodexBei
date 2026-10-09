// Upload immutable versioned objects. Activation is a separate, conditional write.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const semver = require('semver');
const { stage } = require('./stage-app-downloads.cjs');
const { prepare } = require('./prepare-app-release.cjs');
const { origin, currentKey, validateSnapshot } = require('../worker/releases.cjs');
const { createStore, checksum, digest, verifyFile } = require('./lib/release-store.cjs');

function prepareUpload(source, release, directory) {
  const expected = prepare(source, `${origin}/downloads/${release.version}/`, release.notes);
  if (expected.version !== release.version || Object.keys(expected.platforms).length !== Object.keys(release.platforms).length
    || Object.entries(expected.platforms).some(([platform, artifact]) => artifact.url !== release.platforms[platform]?.url
      || artifact.signature !== release.platforms[platform]?.signature)) throw Error('Release feed does not match signed artifacts');
  stage(source, directory);
  const files = [];
  const add = (file, key) => {
    const bytes = fs.readFileSync(file);
    files.push({ path: file, key, sha256: digest(bytes), size: bytes.length });
  };
  for (const subdirectory of [`downloads/${release.version}`, 'download-assets']) {
    for (const name of fs.readdirSync(path.join(directory, subdirectory))) add(path.join(directory, subdirectory, name), `${subdirectory}/${name}`);
  }
  for (const name of ['index.html', 'favicon.ico']) add(path.join(directory, name), `site/${release.version}/${name}`);
  files.sort((a, b) => a.key.localeCompare(b.key, 'en'));
  const snapshot = validateSnapshot({ schemaVersion: 1, release, files: files.map(({ path: localPath, ...file }) => file) });
  return { snapshot, files };
}

async function putImmutable(store, file, body) {
  const existing = await store.get(file.key);
  if (existing) {
    const actual = await checksum(existing.body);
    if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw Error(`Refusing to replace published version: ${file.key}`);
    return;
  }
  await store.put(file.key, body, file.sha256);
  await verifyFile(store, file);
}

async function upload(store, prepared, log = () => {}) {
  validateSnapshot(prepared.snapshot);
  for (const file of prepared.files) {
    await putImmutable(store, file, await fs.openAsBlob(file.path));
    log(`Verified ${file.key}`);
  }
  // The immutable manifest is written last, only after every object is verified.
  const bytes = Buffer.from(JSON.stringify(prepared.snapshot, null, 2) + '\n');
  const key = `releases/${prepared.snapshot.release.version}.json`;
  await putImmutable(store, { key, sha256: digest(bytes), size: bytes.length }, bytes);
}

async function checkDeployment(store, legacyRelease) {
  const current = await store.get(currentKey);
  if (!current) throw Error('Migrate historical downloads and activate the existing release in R2 before deploying');
  const snapshot = validateSnapshot(await current.json());
  const versions = new Set([snapshot.release.version, legacyRelease.version]);
  for (const version of versions) {
    const object = await store.get(`releases/${version}.json`);
    if (!object) throw Error(`Historical release has not been migrated: ${version}`);
    const archived = validateSnapshot(await object.json());
    if (archived.release.version !== version) throw Error('Archived release version mismatch');
    if (version === snapshot.release.version && JSON.stringify(archived) !== JSON.stringify(snapshot)) throw Error('Current pointer differs from its verified release snapshot');
    if (version === legacyRelease.version) {
      for (const [platform, artifact] of Object.entries(legacyRelease.platforms)) {
        const stored = archived.release.platforms[platform];
        if (stored?.url !== artifact.url || stored?.signature !== artifact.signature) throw Error('Migrated release differs from the legacy update feed');
      }
    }
    for (const file of archived.files) {
      const metadata = await store.head(file.key);
      if (!metadata || metadata.headers.get('x-amz-meta-sha256') !== file.sha256 || Number(metadata.headers.get('content-length')) !== file.size) throw Error(`Release object missing or changed: ${file.key}`);
    }
  }
  return snapshot.release.version;
}

async function activate(store, version, expectedVersion, rollback = false, apply = false) {
  if (semver.valid(version) !== version || semver.prerelease(version) || semver.parse(version).build.length) throw Error('Provide a stable version');
  const current = await store.get(currentKey);
  const etag = current?.headers.get('etag');
  if (current && !etag) throw Error('Current release has no ETag; refusing unsafe activation');
  const previous = current ? validateSnapshot(await current.json()) : null;
  if ((previous?.release.version ?? 'none') !== expectedVersion) throw Error('Current release differs from --expected-version');
  if (previous && semver.lt(version, previous.release.version) && !rollback) throw Error('Use --rollback to select an older release');
  const manifest = await store.get(`releases/${version}.json`);
  if (!manifest) throw Error('Upload and verify the release before activation');
  const snapshot = validateSnapshot(await manifest.json());
  if (snapshot.release.version !== version) throw Error('Release version mismatch');
  for (const file of snapshot.files) await verifyFile(store, file);
  if (apply) {
    const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
    await store.put(currentKey, bytes, digest(bytes), etag);
  }
  return { from: previous?.release.version ?? 'none', to: version, applied: apply };
}

function parseArgs(args) {
  const [command, ...rest] = args;
  if (!['upload', 'activate'].includes(command)) throw Error('Usage: publish-app-release.cjs upload <artifact-directory> <prepared-feed.json> | activate <version> --expected-version <version|none> [--rollback] [--credentials-file <private-json>] [--apply]');
  const options = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    const argument = rest[i];
    if (['--apply', '--rollback'].includes(argument)) options[argument.slice(2)] = true;
    else if (['--credentials-file', '--expected-version'].includes(argument) && rest[i + 1] && !rest[i + 1].startsWith('--')) options[argument.slice(2)] = rest[++i];
    else if (argument.startsWith('--')) throw Error('Unknown or incomplete argument');
    else positional.push(argument);
  }
  if (positional.length !== (command === 'upload' ? 2 : 1) || command === 'upload' && (options.rollback || options['expected-version'])
    || command === 'activate' && !options['expected-version']) throw Error('Invalid release command arguments');
  return { command, positional, options };
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  if (command === 'activate') {
    const result = await activate(createStore(options['credentials-file']), positional[0], options['expected-version'], options.rollback, options.apply);
    console.log(`${result.applied ? 'Activated' : 'Verified; not activated'}: ${result.from} -> ${result.to}`);
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-release-'));
  try {
    const release = JSON.parse(fs.readFileSync(positional[1], 'utf8'));
    const prepared = prepareUpload(positional[0], release, directory);
    if (options.apply) await upload(createStore(options['credentials-file']), prepared, console.log);
    console.log(`${options.apply ? 'Uploaded' : 'Prepared locally'} ${release.version}; current release was not changed.`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { prepareUpload, putImmutable, upload, activate, checkDeployment };
