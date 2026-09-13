const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const result = spawnSync(path.join(root, 'node_modules/.bin/tauri'), ['icon', 'desktop/assets/brand/app-icon.svg', '--output', 'src-tauri/icons'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
fs.copyFileSync(path.join(root, 'src-tauri/icons/icon.icns'), path.join(root, 'build/icon.icns'));
fs.copyFileSync(path.join(root, 'src-tauri/icons/icon.ico'), path.join(root, 'build/icon.ico'));
