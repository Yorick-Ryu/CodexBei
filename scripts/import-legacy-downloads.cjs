// One-time import of already published binaries, including releases without an updater.
const fs = require('node:fs');
const path = require('node:path');
const { binaryPath } = require('../worker/releases.cjs');
const { createStore, digest } = require('./lib/release-store.cjs');
const { putImmutable } = require('./publish-app-release.cjs');

function legacyFiles(version, directory) {
  const sums = new Map();
  const bytes = fs.readFileSync(path.join(directory, 'SHA256SUMS'));
  for (const line of bytes.toString().trim().split('\n')) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || sums.has(match[2])) throw Error('Invalid or duplicate legacy checksum');
    sums.set(match[2], match[1]);
  }
  const files = [];
  for (const [name, sha256] of sums) {
    const key = `downloads/${version}/${name}`;
    if (!binaryPath.test(key) || name === 'SHA256SUMS') continue;
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw Error(`Expected regular public artifact: ${name}`);
    const data = fs.readFileSync(file);
    if (digest(data) !== sha256) throw Error(`Legacy checksum mismatch: ${name}`);
    files.push({ key, sha256, size: data.length, path: file });
  }
  if (!files.length) throw Error('No verified legacy public artifacts');
  // Filter the public checksum file so it cannot expose names of private archive files.
  const publicSums = Buffer.from(files.map(file => `${file.sha256}  ${path.basename(file.key)}\n`).join(''));
  files.push({ key: `downloads/${version}/SHA256SUMS`, sha256: digest(publicSums), size: publicSums.length, bytes: publicSums });
  return files;
}

async function main() {
  const [version, directory, ...flags] = process.argv.slice(2);
  let credentialsFile, apply = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--credentials-file' && flags[i + 1]) credentialsFile = flags[++i];
    else if (flags[i] === '--apply') apply = true;
    else throw Error('Unknown legacy import argument');
  }
  if (!version || !directory) throw Error('Usage: import-legacy-downloads.cjs <version> <public-artifact-directory> [--credentials-file <private-json>] [--apply]');
  const files = legacyFiles(version, directory);
  if (apply) {
    const store = createStore(credentialsFile);
    for (const file of files) await putImmutable(store, file, file.bytes ?? await fs.openAsBlob(file.path));
    const bytes = Buffer.from(JSON.stringify({ version, files: files.map(({ path: localPath, bytes: localBytes, ...file }) => file) }, null, 2) + '\n');
    await putImmutable(store, { key: `migrations/${version}.json`, sha256: digest(bytes), size: bytes.length }, bytes);
  }
  console.log(`${apply ? 'Imported and verified' : 'Verified locally'} ${files.length} public files for ${version}; current release was not changed.`);
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { legacyFiles };
