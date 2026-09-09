// Prepare metadata only. Upload packages first, then explicitly deploy the feed.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateAppRelease } = require('../worker/updates.cjs');
function prepare(directory, baseUrl, notes) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw Error('Provide an HTTPS download directory');
  const metadata = fs.readdirSync(directory).filter(name => name.endsWith('.update.json'));
  if (!metadata.length) throw Error('No signed update artifacts found');
  const release = { version: '', notes, pub_date: new Date().toISOString(), platforms: {} };
  for (const name of metadata) {
    const artifact = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (path.basename(artifact.file) !== artifact.file || artifact.file.includes('\\')) throw Error('Invalid artifact path');
    if (release.version && release.version !== artifact.version) throw Error('Mixed versions');
    if (release.platforms[artifact.platform]) throw Error('Duplicate platform');
    const file = path.join(directory, artifact.file);
    if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile()) throw Error('Artifact must be a regular file');
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== artifact.sha256
      || fs.readFileSync(file + '.sig', 'utf8').trim() !== artifact.signature) throw Error('Artifact changed after signing');
    release.version = artifact.version;
    release.platforms[artifact.platform] = { url: new URL(encodeURIComponent(artifact.file), base).href, signature: artifact.signature };
  }
  return validateAppRelease(release);
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4) throw Error('Usage: node scripts/prepare-app-release.cjs <artifact-directory> <https-download-directory> <notes-file> <output-json>');
    const release = prepare(args[0], args[1], fs.readFileSync(args[2], 'utf8'));
    fs.writeFileSync(args[3], JSON.stringify(release, null, 2) + '\n', { flag: 'wx' });
    console.log(`Prepared ${release.version} metadata; nothing was uploaded or published.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare };
