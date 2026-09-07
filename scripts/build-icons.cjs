const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons');

async function main() {
  const root = path.resolve(__dirname, '..');
  const inputFile = path.join(root, 'src/assets/brand/codexbei.svg');
  for (const outputFormat of ['icns', 'ico']) {
    await runIconsTool({ inputFile, outputFormat, outDir: path.join(root, 'build') });
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'codexbei-icon-render-'));
  try {
    await runIconsTool({ inputFile, outputFormat: 'set', outDir: temporary });
    await fs.copyFile(path.join(temporary, '512x512.png'), path.join(root, 'src/assets/brand/icon.png'));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log('Generated transparent cloud + 北 icons for macOS, Windows and the app window.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
