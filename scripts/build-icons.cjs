const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const result = spawnSync(path.join(root, 'node_modules/.bin/tauri'), ['icon', 'desktop/assets/brand/app-icon.svg', '--output', 'src-tauri/icons'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
fs.copyFileSync(path.join(root, 'src-tauri/icons/icon.icns'), path.join(root, 'build/icon.icns'));
fs.copyFileSync(path.join(root, 'src-tauri/icons/icon.ico'), path.join(root, 'build/icon.ico'));

// Icon Composer supplies the background and macOS mask. Rasterize the foreground
// with Tauri's SVG renderer, which preserves the source's nested transforms.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-icon-'));
try {
  const source = fs.readFileSync(path.join(root, 'desktop/assets/brand/app-icon.svg'), 'utf8');
  const background = '  <rect x="100" y="100" width="824" height="824" rx="188" fill="#ffffff"/>\n';
  if (!source.includes(background)) throw new Error('图标底板已变更，请同步更新 Icon Composer 前景生成方式。');
  fs.writeFileSync(path.join(root, 'desktop/assets/brand/app-icon-dark.svg'), source.replace(background, background.replace('#ffffff', '#000000')));
  const foreground = path.join(temp, 'cloud.svg');
  fs.writeFileSync(foreground, source.replace(background, '').replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"'));
  const png = spawnSync(path.join(root, 'node_modules/.bin/tauri'), ['icon', foreground, '--output', temp, '--png', '1024'], { cwd: root, stdio: 'inherit' });
  if (png.status !== 0) throw new Error('原生图标前景生成失败。');
  fs.copyFileSync(path.join(temp, '1024x1024.png'), path.join(root, 'desktop/assets/brand/CodexBei.icon/Assets/cloud.png'));
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
