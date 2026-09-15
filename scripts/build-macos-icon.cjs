const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
if (process.platform !== 'darwin') {
  console.error('macOS 原生图标需要在安装 Xcode 26 或更新版本的 Mac 上编译。');
  process.exit(1);
}
const output = path.join(root, 'build/macos-icon');
fs.mkdirSync(output, { recursive: true });
const result = spawnSync('xcrun', [
  'actool', path.join(root, 'desktop/assets/brand/CodexBei.icon'),
  '--compile', output,
  '--platform', 'macosx',
  '--minimum-deployment-target', '13.0',
  '--app-icon', 'CodexBei',
  '--output-partial-info-plist', path.join(output, 'partial.plist'),
], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) {
  console.error('原生深浅图标编译失败，请确认 Xcode 已完成许可确认和首次启动组件安装。');
  process.exit(result.status || 1);
}
for (const name of ['Assets.car', 'CodexBei.icns']) {
  if (!fs.statSync(path.join(output, name)).size) throw new Error(`图标产物为空：${name}`);
}
