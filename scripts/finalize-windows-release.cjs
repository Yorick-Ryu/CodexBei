const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw Error('Unexpected symlink in build artifacts');
    return entry.isDirectory() ? filesIn(file) : [file];
  });
}
function finalize(source, destination, sourceCommit) {
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error('Provide the verified build commit');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const key = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(os.homedir(), '.codexbei/signing/updater/codexbei.key');
  const stat = fs.lstatSync(key);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('Updater key must be a private regular file (600)');
  if (fs.readFileSync(key + '.pub', 'utf8').trim() !== config.plugins.updater.pubkey) throw Error('Signing key does not match the application');
  const files = filesIn(source);
  const reports = files.filter(file => /windows-package-(x86_64|aarch64)-pc-windows-msvc\.json$/.test(file));
  if (reports.length !== 2) throw Error('Expected both native Windows verification reports');
  fs.mkdirSync(destination, { recursive: true });
  const seen = new Set();
  for (const reportFile of reports) {
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    if (!['aarch64-pc-windows-msvc', 'x86_64-pc-windows-msvc'].includes(report.target)) throw Error('Unexpected Windows target');
    const arm = report.target === 'aarch64-pc-windows-msvc';
    const platform = arm ? 'windows-aarch64' : 'windows-x86_64';
    if (seen.has(platform)) throw Error('Duplicate platform');
    seen.add(platform);
    const packageOnly = report.verificationMode === 'package-only';
    if (report.source !== sourceCommit || report.installExitCode !== 0
      || (packageOnly ? ![config.version, config.version + '.0'].includes(report.appVersion) : report.windowTitle !== 'CodexBei')
      || report.machine !== (arm ? 0xAA64 : 0x8664)) throw Error('Native Windows verification failed');
    const installers = files.filter(file => path.basename(file) === report.installer);
    if (installers.length !== 1 || hash(installers[0]).toUpperCase() !== report.installerSha256.toUpperCase()) throw Error('Installer does not match verified artifact');
    const file = path.join(destination, `CodexBei_${config.version}_${arm ? 'arm64' : 'x64'}-setup.exe`);
    if (fs.existsSync(file)) throw Error('Refusing to overwrite an existing release');
    fs.copyFileSync(installers[0], file);
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    const cli = path.join(root, 'node_modules/.bin/tauri');
    const signed = spawnSync(cli, ['signer', 'sign', '--private-key-path', key, file], { cwd: root, env, stdio: 'pipe' });
    if (signed.status !== 0) throw Error('Updater signing failed');
    fs.writeFileSync(path.join(destination, `${platform}.update.json`), JSON.stringify({
      version: config.version, platform, file: path.basename(file), signature: fs.readFileSync(file + '.sig', 'utf8').trim(), sha256: hash(file),
    }, null, 2) + '\n');
    fs.copyFileSync(reportFile, path.join(destination, `${platform}.verification.json`));
    console.log(`${platform}: ${packageOnly ? 'silent install/version/architecture verified; UI checks skipped' : 'native install/start verified'}; updater signature added`);
  }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw Error('Usage: node scripts/finalize-windows-release.cjs <downloaded-artifacts> <release-directory> <build-commit>');
    finalize(...args);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
