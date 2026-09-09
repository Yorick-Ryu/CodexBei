const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const team = 'HYB659G8FH';
const profile = 'codexbei-notary';
function fail(message) { console.error(message); process.exit(1); }
function run(command, args, options = {}) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options }); if (result.status !== 0) fail('构建或签名验证失败，请检查上方日志。'); return result; }
if (process.platform !== 'darwin') fail('正式 macOS 构建必须在 Mac 上运行。');
const flags = process.argv.slice(2);
if (flags.some(v => !['--arm64','--x64'].includes(v))) fail('仅支持 --arm64、--x64；不指定时构建两种架构。');
const identities = spawnSync('security', ['find-identity','-v','-p','codesigning'], { encoding: 'utf8' });
const identity = identities.stdout?.split('\n').find(v => v.includes('Developer ID Application:') && v.includes(`(${team})`))?.match(/"([^"]+)"/)?.[1];
if (!identity) fail('缺少指定团队的 Developer ID Application 证书与私钥。');
if (spawnSync('xcrun', ['notarytool','history','--keychain-profile',profile], { stdio: 'ignore', timeout: 30000 }).status !== 0) fail('无法验证钥匙串公证凭据。');
const env = { ...process.env, APPLE_SIGNING_IDENTITY: identity };
const updaterKey = process.env.TAURI_SIGNING_PRIVATE_KEY || path.join(os.homedir(), '.codexbei/signing/updater/codexbei.key');
if (!fs.existsSync(updaterKey) || !fs.lstatSync(updaterKey).isFile() || fs.lstatSync(updaterKey).isSymbolicLink()
  || (fs.statSync(updaterKey).mode & 0o077)) fail('自动更新签名私钥必须是仓库外的私有文件（600）。');
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
if (fs.readFileSync(updaterKey + '.pub', 'utf8').trim() !== config.plugins.updater.pubkey) fail('更新签名公钥与客户端不匹配。');
env.TAURI_SIGNING_PRIVATE_KEY = updaterKey;
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '';
// Sign with Tauri, then notarize explicitly using the existing Keychain profile.
for (const key of ['APPLE_ID','APPLE_PASSWORD','APPLE_API_KEY','APPLE_API_KEY_PATH','APPLE_API_ISSUER','APPLE_API_KEY_ID']) delete env[key];
const stamp = new Date().toISOString().replace(/[:.]/g,'-');
const destination = path.join(root,'releases',`tauri-${stamp}`); fs.mkdirSync(destination, { recursive: true });
for (const arch of flags.length ? flags : ['--arm64','--x64']) {
  const target = arch === '--arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  run(path.join(root,'node_modules/.bin/tauri'), ['build','--target',target,'--bundles','app,dmg'], { env });
  const bundles = path.join(root,'src-tauri/target',target,'release/bundle');
  const app = path.join(bundles,'macos/CodexBei.app');
  run('codesign',['--verify','--deep','--strict',app]);
  const zip = path.join(destination, `CodexBei-macos-${target}.zip`);
  run('ditto',['-c','-k','--keepParent',app,zip]);
  run('xcrun',['notarytool','submit',zip,'--keychain-profile',profile,'--wait']);
  run('xcrun',['stapler','staple',app]); run('xcrun',['stapler','validate',app]);
  fs.unlinkSync(zip); run('ditto',['-c','-k','--keepParent',app,zip]);
  // Stapling changes the bundle: regenerate and sign the final updater archive.
  const updater = path.join(destination, `CodexBei_${config.version}_${target}.app.tar.gz`);
  run('tar', ['-czf', updater, '-C', path.dirname(app), path.basename(app)], { env: { ...env, COPYFILE_DISABLE: '1' } });
  const signerEnv = { ...env };
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY; // The signer forbids combining string-key env with --private-key-path.
  run(path.join(root, 'node_modules/.bin/tauri'), ['signer', 'sign', '--private-key-path', updaterKey, updater], { env: signerEnv });
  const platform = `darwin-${arch === '--arm64' ? 'aarch64' : 'x86_64'}`;
  fs.writeFileSync(path.join(destination, `${platform}.update.json`), JSON.stringify({
    version: config.version, platform, file: path.basename(updater), signature: fs.readFileSync(updater + '.sig', 'utf8').trim(),
    sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(updater)).digest('hex'),
  }, null, 2) + '\n');
  for (const name of fs.readdirSync(path.join(bundles,'dmg')).filter(v => v.endsWith('.dmg'))) {
    const dmg = path.join(destination,name); fs.copyFileSync(path.join(bundles,'dmg',name),dmg);
    run('xcrun',['notarytool','submit',dmg,'--keychain-profile',profile,'--wait']);
    run('xcrun',['stapler','staple',dmg]); run('xcrun',['stapler','validate',dmg]);
  }
}
console.log(`正式签名与公证产物：${destination}`);
