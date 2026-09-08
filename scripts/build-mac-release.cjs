const { spawnSync } = require('node:child_process');
const path = require('node:path');

const teamId = 'HYB659G8FH';
const profile = 'codexbei-notary';
const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== 'darwin') fail('macOS 签名与公证需要在 Mac 上执行。');
const architectures = process.argv.slice(2);
if (architectures.some((arg) => !['--arm64', '--x64'].includes(arg))) {
  fail('仅支持 --arm64 或 --x64；不指定时构建两种架构。');
}
const identities = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
if (identities.status !== 0 || !identities.stdout.split('\n').some((line) =>
  line.includes('Developer ID Application:') && line.includes(`(${teamId})`))) {
  fail(`缺少个人团队 ${teamId} 的 Developer ID Application 证书及私钥。`);
}
const credentials = spawnSync('xcrun', ['notarytool', 'history', '--keychain-profile', profile, '--output-format', 'json'], {
  stdio: 'ignore', timeout: 30000,
});
if (credentials.status !== 0) fail(`无法验证钥匙串公证配置 ${profile}，请检查凭据和网络。`);

// Release credentials stay in Keychain; unrelated shell credentials must not select another account.
const env = { ...process.env, CSC_NAME: teamId, CSC_IDENTITY_AUTO_DISCOVERY: 'true', APPLE_KEYCHAIN_PROFILE: profile };
for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_KEYCHAIN', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN']) delete env[name];
const result = spawnSync(path.join(root, 'node_modules', '.bin', 'electron-builder'), [
  '--mac', 'dmg', 'zip', ...(architectures.length ? architectures : ['--arm64', '--x64']),
  '-c.forceCodeSigning=true', `-c.mac.identity=${teamId}`, '-c.mac.hardenedRuntime=true',
  '-c.mac.notarize=true', '-c.directories.output=dist-release', '--publish', 'never',
], { cwd: root, env, stdio: 'inherit' });
process.exit(result.status ?? 1);
