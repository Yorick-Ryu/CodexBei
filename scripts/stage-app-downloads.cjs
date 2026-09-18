// Stage public binaries only; retain earlier versions and reject changed files.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { prepare } = require('./prepare-app-release.cjs');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function stage(source, destination) {
  const release = prepare(source, 'https://codexbei.beiapi.cn/downloads/', '');
  if (Object.keys(release.platforms).length !== 4) throw Error('All four signed platforms are required');
  const version = release.version;
  const installers = [
    [`CodexBei_${version}_aarch64.dmg`, 'Mac · Apple 芯片', '适用于 M 系列芯片'],
    [`CodexBei_${version}_x64.dmg`, 'Mac · Intel', '适用于 Intel 处理器'],
    [`CodexBei_${version}_x64-setup.exe`, 'Windows · x64', '适用于大多数 Windows 电脑'],
    [`CodexBei_${version}_arm64-setup.exe`, 'Windows · ARM64', '适用于 ARM 处理器'],
  ];
  const names = new Set(installers.map(([name]) => name));
  for (const artifact of Object.values(release.platforms)) {
    const name = decodeURIComponent(new URL(artifact.url).pathname.split('/').pop());
    names.add(name); names.add(name + '.sig');
  }
  const checksums = new Map(fs.readFileSync(path.join(source, 'SHA256SUMS'), 'utf8').trim().split('\n')
    .map(line => { const match = line.match(/^([a-f0-9]{64})  (.+)$/); if (!match) throw Error('Invalid checksums'); return [match[2], match[1]]; }));
  const downloads = path.join(destination, 'downloads');
  const directory = path.join(downloads, version);
  const files = [...names].sort().map(name => {
    const file = path.join(source, name);
    if (!fs.lstatSync(file).isFile()) throw Error('Expected regular release file');
    const bytes = fs.readFileSync(file);
    if (hash(bytes) !== checksums.get(name)) throw Error(`Release checksum mismatch: ${name}`);
    const target = path.join(directory, name);
    if (fs.existsSync(target) && hash(fs.readFileSync(target)) !== hash(bytes)) throw Error(`Refusing to replace published version: ${name}`);
    return { name, bytes, target };
  });
  fs.mkdirSync(directory, { recursive: true });
  for (const { bytes, target } of files) if (!fs.existsSync(target)) fs.writeFileSync(target, bytes, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'SHA256SUMS'), files.map(({ name, bytes }) => `${hash(bytes)}  ${name}\n`).join(''));
  const templateRoot = path.join(__dirname, '../remote/download-page');
  const assets = path.join(destination, 'download-assets');
  fs.mkdirSync(assets, { recursive: true });
  const publishAsset = name => {
    const bytes = fs.readFileSync(path.join(templateRoot, name));
    const extension = path.extname(name);
    const target = `${path.basename(name, extension)}.${hash(bytes).slice(0, 12)}${extension}`;
    fs.writeFileSync(path.join(assets, target), bytes);
    return `/download-assets/${target}`;
  };
  const svg = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    .replace(/<\?xml[^>]*>\s*/g, '').replace(/role="img"|aria-labelledby="[^"]*"/g, '');
  const favicon = fs.readFileSync(path.join(__dirname, '../remote/download-icons/favicon.ico'));
  fs.writeFileSync(path.join(destination, 'favicon.ico'), favicon);
  const values = {
    VERSION: version,
    FAVICON_URL: `/favicon.ico?v=${hash(favicon).slice(0, 12)}`,
    SCRIPT_URL: publishAsset('app.js'), STYLE_URL: publishAsset('style.css'),
    BRAND_ICON: svg('desktop/assets/brand/codexbei.svg'),
    APPLE_ICON: svg('remote/download-icons/apple.svg'),
    WINDOWS_ICON: svg('remote/download-icons/windows.svg'),
  };
  const redirects = [];
  for (const [index, key] of ['MAC_APPLE', 'MAC_INTEL', 'WIN_X64', 'WIN_ARM'].entries()) {
    const name = installers[index][0];
    const latestUrl = `/downloads/latest/${name.replace(`_${version}_`, '_')}`;
    values[key + '_URL'] = latestUrl;
    redirects.push(`${latestUrl} /downloads/${version}/${name} 302`);
    values[key + '_SIZE'] = `${(fs.statSync(path.join(directory, name)).size / 1024 / 1024).toFixed(1)} MB`;
  }
  const html = fs.readFileSync(path.join(templateRoot, 'index.html'), 'utf8').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
    if (!(name in values)) throw Error(`Unknown download page placeholder: ${name}`);
    return values[name];
  });
  fs.writeFileSync(path.join(downloads, 'index.html'), html);
  fs.writeFileSync(path.join(destination, 'index.html'), html);
  // Rebuild temporary redirects with every release so shared links follow the published version.
  fs.writeFileSync(path.join(destination, '_redirects'), redirects.join('\n') + '\n');
  fs.writeFileSync(path.join(destination, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n/downloads/${version}/*\n  Cache-Control: public, max-age=31536000, immutable\n`);
  console.log(`Staged ${files.length} verified public files for ${version}; previous versions retained.`);
}
if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw Error('Usage: node scripts/stage-app-downloads.cjs <release-directory> <assets-directory>');
    stage(...process.argv.slice(2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { stage };
