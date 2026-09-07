const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const semver = require('semver');
const { validAppVersion } = require('./app-version.cjs');

async function command(file, args) {
  const { stdout } = await promisify(execFile)(file, args, { timeout: 4000, maxBuffer: 128 * 1024, windowsHide: true, shell: false });
  return stdout.trim();
}

function parseVersion(output) {
  if (typeof output !== 'string') return null;
  const match = /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)(?:\s|$)/.exec(output.trim());
  return match && semver.valid(match[1]) ? match[1] : null;
}

async function detectInstallations({ platform = process.platform, home = os.homedir(), env = process.env, run = command, exists = fs.existsSync } = {}) {
  const filePath = platform === 'win32' ? path.win32 : path.posix;
  const cli = [];
  const desktop = [];
  if (platform === 'win32') {
    try {
      const paths = await run('where.exe', ['codex.exe']);
      cli.push(...paths.split(/\r?\n/).filter(Boolean));
    } catch { /* Try standard install paths below. */ }
    for (const base of [env.APPDATA && filePath.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && filePath.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')].filter(Boolean)) {
      cli.push(filePath.join(base, 'codex.exe'));
      // npm's .cmd shim is not executed through a shell. Probe its package's native binary.
      const vendor = filePath.join(base, 'node_modules', '@openai', 'codex', 'vendor');
      for (const arch of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) cli.push(filePath.join(vendor, arch, 'codex', 'codex.exe'));
      for (const arch of ['codex-win32-x64', 'codex-win32-arm64']) for (const triplet of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
        cli.push(filePath.join(base, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', arch, 'vendor', triplet, 'codex', 'codex.exe'));
      }
    }
    try {
      const packages = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-AppxPackage | Where-Object { $_.Name -in @('OpenAI.Codex','OpenAI.ChatGPT') } | Select-Object InstallLocation,Version) | ConvertTo-Json -Compress"]));
      for (const pkg of [packages].flat().filter(Boolean)) for (const sub of ['app/resources', 'resources']) {
        desktop.push({ executable: filePath.join(pkg.InstallLocation, sub, 'codex.exe'), appVersion: validAppVersion(String(pkg.Version)) ? String(pkg.Version) : null, appDisplayVersion: String(pkg.Version) });
      }
    } catch { /* No app installed, or package metadata is unavailable. */ }
    for (const name of ['Codex', 'ChatGPT']) if (env.LOCALAPPDATA) desktop.push({ executable: filePath.join(env.LOCALAPPDATA, 'Programs', name, 'resources', 'codex.exe'), appVersion: null });
  } else {
    for (const folder of [env.PATH ?? '', '/opt/homebrew/bin', '/usr/local/bin', filePath.join(home, '.local/bin')].flatMap((item) => item.split(filePath.delimiter))) {
      if (folder && filePath.isAbsolute(folder)) cli.push(filePath.join(folder, 'codex'));
    }
    if (platform === 'darwin') {
      let discovered = [];
      try { discovered = (await run('/usr/bin/mdfind', ['kMDItemCFBundleIdentifier == "com.openai.codex"'])).split('\n').filter((item) => filePath.isAbsolute(item) && item.endsWith('.app')); } catch { /* Standard paths still work. */ }
      const bundles = [...new Set([...discovered, ...['/Applications', filePath.join(home, 'Applications')].flatMap((dir) => ['Codex.app', 'ChatGPT.app'].map((name) => filePath.join(dir, name)))])];
      for (const bundle of bundles.slice(0, 20)) {
        if (!exists(filePath.join(bundle, 'Contents/Info.plist'))) continue;
        try {
          const info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', filePath.join(bundle, 'Contents/Info.plist')]));
          if (info.CFBundleIdentifier !== 'com.openai.codex') continue;
          desktop.push({ executable: filePath.join(bundle, 'Contents/Resources/codex'), appVersion: validAppVersion(info.CFBundleShortVersionString) ? info.CFBundleShortVersionString : null, appDisplayVersion: info.CFBundleShortVersionString });
        } catch { /* A broken bundle is not substituted with the CLI version. */ }
      }
    }
  }
  const installations = [];
  const desktopPaths = new Set(desktop.map((item) => item.executable));
  let unknownCli;
  // Preserve PATH precedence for CLI; desktop runtimes are always probed separately.
  for (const executable of [...new Set(cli)].filter((item) => !desktopPaths.has(item) && exists(item))) {
    unknownCli ??= executable;
    try {
      const runtimeVersion = parseVersion(await run(executable, ['--version']));
      if (runtimeVersion) { installations.push({ id: 'cli', kind: 'cli', executable, runtimeVersion }); break; }
    } catch { /* Try the next CLI installation. */ }
  }
  if (!installations.some((item) => item.kind === 'cli') && unknownCli) installations.push({ id: 'cli', kind: 'cli', executable: unknownCli, runtimeVersion: null });
  for (const item of desktop.filter((item, index) => exists(item.executable) && desktop.findIndex((other) => other.executable === item.executable) === index)) {
    let runtimeVersion = null;
    try { runtimeVersion = parseVersion(await run(item.executable, ['--version'])); } catch { /* Keep a detected app with unknown runtime explicit. */ }
    installations.push({ ...item, id: `desktop:${item.executable}`, kind: 'desktop', runtimeVersion });
  }
  return installations;
}

function selectInstallations(installations, selection = { mode: 'auto' }) {
  if (selection.mode === 'auto') return installations;
  if (selection.mode === 'installed') {
    const item = installations.find((item) => item.id === selection.id);
    if (item) return [item];
  }
  if (selection.mode === 'manual' && ['cli', 'desktop'].includes(selection.kind) && semver.valid(selection.runtimeVersion) && (!selection.appVersion || validAppVersion(selection.appVersion))) {
    return [{ kind: selection.kind, runtimeVersion: selection.runtimeVersion, appVersion: selection.appVersion || null }];
  }
  throw new Error('请选择 Codex 版本。');
}

module.exports = { detectInstallations, selectInstallations, parseVersion };
