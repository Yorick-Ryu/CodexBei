const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runIconsTool } = require('app-builder-lib/out/toolsets/icons');

async function main() {
  const root = path.resolve(__dirname, '..');
  const brand = await fs.readFile(path.join(root, 'src/assets/brand/codexbei.svg'), 'utf8');
  const artwork = brand.replace(/<svg[^>]*>/, '').replace('</svg>', '');
  const inputFile = path.join(root, 'src/assets/brand/app-icon.svg');
  await fs.writeFile(inputFile, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="cloud-shadow" x="-20%" y="-20%" width="140%" height="145%"><feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#2360ce" flood-opacity=".18"/></filter></defs>
  <rect x="100" y="100" width="824" height="824" rx="188" fill="#ffffff"/>
  <g transform="translate(153.6 153.6) scale(.7)" filter="url(#cloud-shadow)">${artwork}</g>
</svg>
`);
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
  console.log('Generated white-tile blue-cloud + 北 icons for macOS, Windows and the app window.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
