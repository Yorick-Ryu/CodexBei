const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const windowsOnly = process.argv.includes('--windows');
if (!windowsOnly) {
  const result = spawnSync(path.join(root, 'node_modules/.bin/tauri'), ['icon', 'desktop/assets/brand/app-icon.svg', '--output', 'src-tauri/icons'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  fs.copyFileSync(path.join(root, 'src-tauri/icons/icon.icns'), path.join(root, 'build/icon.icns'));
}

// Icon Composer supplies the background and macOS mask. Rasterize the foreground
// with Tauri's SVG renderer, which preserves the source's nested transforms.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-icon-'));
try {
  const source = fs.readFileSync(path.join(root, 'desktop/assets/brand/app-icon.svg'), 'utf8');
  const background = '  <rect x="100" y="100" width="824" height="824" rx="188" fill="#ffffff"/>\n';
  if (!source.includes(background)) throw new Error('图标底板已变更，请同步更新 Icon Composer 前景生成方式。');

  // Windows embeds the ICO for both the executable and window icon. Use tighter
  // framing and a larger foreground while keeping the macOS sources unchanged.
  const transform = 'translate(153.6 153.6) scale(.7)';
  if (!source.includes(transform)) throw new Error('图标前景已变更，请同步更新 Windows 图标生成方式。');
  const windowsSource = source.replace('viewBox="0 0 1024 1024"', 'viewBox="80 80 864 864"')
    .replace(transform, 'translate(102.4 102.4) scale(.8)');
  const windowsSvg = path.join(root, 'desktop/assets/brand/app-icon-windows.svg');
  fs.writeFileSync(windowsSvg, windowsSource);
  const windowsOutput = path.join(temp, 'windows');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const windows = spawnSync(path.join(root, 'node_modules/.bin/tauri'), ['icon', windowsSvg, '--output', windowsOutput, ...sizes.flatMap(size => ['--png', String(size)])], { cwd: root, stdio: 'inherit' });
  if (windows.status !== 0) throw new Error('Windows 图标生成失败。');
  // Package each raster size directly so the ICO retains its 128px frame too.
  const images = sizes.map(size => fs.readFileSync(path.join(windowsOutput, `${size}x${size}.png`)));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[index].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[index].length;
  });
  fs.writeFileSync(path.join(root, 'build/icon.ico'), Buffer.concat([header, ...images]));

  if (!windowsOnly) {
    fs.writeFileSync(path.join(root, 'desktop/assets/brand/app-icon-dark.svg'), source.replace(background, background.replace('#ffffff', '#000000')));
    const foreground = path.join(temp, 'cloud.svg');
    fs.writeFileSync(foreground, source.replace(background, '').replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"'));
    const png = spawnSync(path.join(root, 'node_modules/.bin/tauri'), ['icon', foreground, '--output', temp, '--png', '1024'], { cwd: root, stdio: 'inherit' });
    if (png.status !== 0) throw new Error('原生图标前景生成失败。');
    fs.copyFileSync(path.join(temp, '1024x1024.png'), path.join(root, 'desktop/assets/brand/CodexBei.icon/Assets/cloud.png'));
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
