const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ConfigStore } = require('./config.cjs');
const { parseSetupLink } = require('./deep-link.cjs');
const { TemplateStore } = require('./template-store.cjs');
const { fetchModels } = require('./model-list.cjs');
const { detectInstallations, selectInstallations } = require('./codex-versions.cjs');
const clientVersion = require('../package.json').version;

app.setName('CodexBei');
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'CodexBei'));
if (process.platform === 'win32') app.setAppUserModelId('cn.beiapi.codexbei');

let window;
let store;
let incoming;
let templates;
let installations = [];
let selection = { mode: 'auto' };
let activeFile;
let refreshPromise;
let incomingRevision = 0;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;

function focusApp(url) {
  // Incoming credentials only prefill the form; a link never writes a file.
  if (url) {
    incomingRevision += 1;
    try {
      const connection = parseSetupLink(url);
      if (connection) {
        incoming = { connection };
        store?.plans.clear();
      }
    } catch {
      incoming = { error: '配置链接无效，请从网站重新打开。' };
      store?.plans.clear();
    }
    if (window && !window.isDestroyed()) window.webContents.send('setup:incoming-changed');
  }
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

function handle(channel, operation) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) return { error: '无法验证窗口来源。' };
    try { return { data: await operation(...args) }; }
    catch (error) {
      // Never echo parser input, native error arguments or API keys through IPC/logs.
      const message = error.message;
      return { error: /^[\u4e00-\u9fff]/.test(message) ? message : '操作失败，请检查文件权限、磁盘空间和配置路径。原有备份会保留。' };
    }
  });
}

async function refreshConfiguration(file = activeFile) {
  const work = async () => {
    installations = await detectInstallations();
    const targets = selectInstallations(installations, selection);
    await templates.check(targets);
    const resolved = templates.resolve(targets);
    const state = store.inspect(file);
    return {
      installations, selection, connection: state.connection,
      template: resolved ? { id: resolved.template.id, version: resolved.template.version, digest: resolved.digest } : null,
      updateAvailable: Boolean(resolved && state.connection && state.template?.digest !== resolved.digest),
      cached: Boolean(resolved && (resolved.source !== 'remote' || resolved.offline)),
      needsSelection: !resolved,
    };
  };
  const next = (refreshPromise ?? Promise.resolve()).catch(() => {}).then(work);
  refreshPromise = next;
  try { return await next; } finally { if (refreshPromise === next) refreshPromise = null; }
}

function currentTemplate() {
  const resolved = templates.resolve(selectInstallations(installations, selection));
  if (!resolved) throw new Error('未找到匹配配置，请选择 Codex 版本。');
  return resolved;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, argv) => focusApp(argv.find((arg) => arg.startsWith('codexbei:'))));
  app.on('open-url', (event, url) => { event.preventDefault(); focusApp(url); });
  focusApp(process.argv.find((arg) => arg.startsWith('codexbei:')));
  app.whenReady().then(() => {
    store = new ConfigStore({ backupDir: path.join(app.getPath('userData'), 'backups') });
    templates = new TemplateStore({ directory: path.join(app.getPath('userData'), 'cache'), clientVersion });
    activeFile = store.detect()[0].file;
    const appIcon = path.join(__dirname, 'assets/brand/icon.png');
    if (!app.isPackaged && process.platform === 'darwin') app.dock.setIcon(appIcon);
    if (app.isPackaged) app.setAsDefaultProtocolClient('codexbei');
    window = new BrowserWindow({
      width: 600, height: 594, minWidth: 460, minHeight: 540,
      title: 'CodexBei', backgroundColor: '#151515', show: false, icon: appIcon,
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } } : {}),
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    handle('setup:detect', () => ({ candidates: store.detect(), platform: process.platform }));
    handle('setup:choose', async () => {
      const result = await dialog.showOpenDialog(window, { title: '选择 Codex 配置文件', properties: ['openFile'], filters: [{ name: 'Codex TOML', extensions: ['toml'] }] });
      return result.canceled ? null : store.target(result.filePaths[0]);
    });
    handle('setup:check', async (file, choice) => {
      activeFile = store.target(file);
      if (choice) { selectInstallations(installations, choice); selection = choice; store.plans.clear(); }
      return refreshConfiguration(activeFile);
    });
    handle('setup:inspect', (file) => store.inspect(file));
    handle('setup:models', (file, key, baseUrl) => fetchModels(store.modelCredentials(file, key, baseUrl)));
    handle('setup:prepare', async (file, key, baseUrl, model) => {
      const revision = incomingRevision;
      await refreshConfiguration(file);
      if (revision !== incomingRevision) throw new Error('收到新的配置链接，请重新点击配置。');
      return store.prepare(file, key, baseUrl, model, currentTemplate().template);
    });
    handle('setup:incoming', () => {
      const value = incoming ?? null;
      incoming = undefined;
      return value;
    });
    handle('setup:apply', async (id) => {
      const plan = store.plans.get(id);
      if (!plan) throw new Error('请重新点击配置。');
      await refreshConfiguration(plan.target);
      if (plan.template.digest !== currentTemplate().digest) {
        store.plans.clear();
        throw new Error('推荐配置已更新，请重新点击配置。');
      }
      return { ...store.apply(id), template: plan.template };
    });
    handle('setup:backups', () => store.list());
    handle('setup:restore', async (id) => {
      const state = store.inspectRestore(id);
      const result = await dialog.showMessageBox(window, {
        type: 'question', buttons: ['取消', '还原'], defaultId: 0, cancelId: 0,
        message: '还原配置？',
        detail: `${state.file}\n\n${state.changed ? '将覆盖后续改动，当前配置会自动备份。' : '当前配置会自动备份。'}`,
      });
      if (result.response !== 1) return null;
      return store.restore(id, state.currentHash);
    });
    handle('setup:website', () => shell.openExternal('https://beiapi.cn'));
    handle('setup:close', () => window.close());
    window.once('ready-to-show', () => window.show());
    window.loadFile(path.join(__dirname, 'index.html'));
    // Downloading only updates the cache/UI; all configuration writes remain behind setup:apply.
    const periodicCheck = async () => {
      try {
        const data = await refreshConfiguration();
        if (!window.isDestroyed()) window.webContents.send('setup:templates-changed', data);
      } catch { /* Keep the existing UI and configuration on background failure. */ }
    };
    const timer = setInterval(periodicCheck, 4 * 60 * 60 * 1000);
    timer.unref();
    app.once('before-quit', () => clearInterval(timer));
    window.on('focus', () => {
      if (templates.checkedAt && Date.now() - templates.checkedAt > 5 * 60 * 1000) void periodicCheck();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
