// Browser tests mock only the IPC boundary; actual file behavior is tested in Rust.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium, webkit } = require('playwright-core');
const root = path.resolve(__dirname, '../dist-react');
const useWebKit = process.env.CODEXBEI_TEST_BROWSER === 'webkit';
const output = path.resolve(__dirname, '../artifacts/tauri-ui', useWebKit ? 'webkit' : '.');
const mocks = fs.readFileSync(require.resolve('@tauri-apps/api/mocks').replace(/\.cjs$/, '.js'), 'utf8').replace(/^export\s*\{[^}]*\};?\s*$/m, '');
async function fixture(options = {}) {
  fs.mkdirSync(output, { recursive: true });
  const server = http.createServer((req, res) => {
    const file = path.join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const browser = await (useWebKit
    ? webkit.launch({ headless: true })
    : chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true }));
  const context = await browser.newContext({ viewport: { width: 600, height: 460 }, colorScheme: 'dark' });
  await context.addInitScript({ content: mocks + `
    mockWindows('main');
    window.fixtureState = { apiKey: ${JSON.stringify(options.savedKey ?? 'sk-saved-fixture-not-real-key')}, hasKey: ${!!(options.savedKey ?? 'sk-saved-fixture-not-real-key')}, modelChannel: 'api', keepOfficialLogin: false, baseUrl: 'https://api.beiapi.cn/v1', model: 'gpt-6-astra', file: '/isolated/config/config.toml', platform: 'macos', testMode: true };
    window.fixtureBackups = [];
    window.fixtureMatching = { installations: [{ id: 'cli', kind: 'cli', runtimeVersion: '0.153.4' }, { id: 'desktop', kind: 'desktop', runtimeVersion: '0.154.0', appVersion: '26.901.51231' }], selection: { mode: 'auto' }, template: { id: 'codex-default', version: '1.0.0', digest: 'fixture' }, latestTemplate: { id: 'codex-default', version: '1.0.0', digest: 'fixture' }, templateUpdateAvailable: false, offline: false, needsSelection: false, modelClientVersion: '0.153.4' };
    window.fixtureCalls = [];
    window.fixtureInitialError = ${JSON.stringify(options.initialError || false)};
    mockIPC(async (cmd, args) => {
      window.fixtureCalls.push(cmd);
      if (cmd === 'plugin:app|version') return '0.1.0';
      if (cmd === 'plugin:updater|check') {
        if (window.fixtureUpdateCheckError) throw 'network';
        return window.fixtureUpdate ? { rid: 42, currentVersion: '0.1.0', version: '0.2.0', body: '改进更新流程', rawJson: {} } : null;
      }
      if (cmd === 'plugin:updater|download') {
        await new Promise(resolve => setTimeout(resolve, window.fixtureUpdateDelay || 30));
        if (window.fixtureUpdateDownloadError) throw 'signature mismatch';
        return 43;
      }
      if (cmd === 'plugin:updater|install') { if (window.fixtureUpdateInstallError) throw 'permission'; return null; }
      if (cmd === 'plugin:resources|close') return null;
      if (cmd === 'plugin:process|restart') { if (window.fixtureUpdateRestartError) throw 'restart'; return null; }
      if (cmd === 'check') {
        if (args.selection && window.fixtureVersionDelay) await new Promise(resolve => setTimeout(resolve, window.fixtureVersionDelay));
        if (args.selection?.mode === 'manual') { if (!/^\\d+\\.\\d+\\.\\d+$/.test(args.selection.runtimeVersion)) throw args.selection.kind === 'cli' ? '请输入有效的 CLI 版本。' : '请输入有效的内核版本及应用版本。'; window.fixtureMatching.modelClientVersion = args.selection.runtimeVersion; }
        if (args.selection) window.fixtureMatching.selection = args.selection;
        return { ...window.fixtureMatching };
      }
      if (cmd === 'update_template') { window.fixtureMatching.template = { id: 'codex-default', version: '1.1.0', digest: 'updated' }; window.fixtureMatching.templateUpdateAvailable = false; return { ...window.fixtureMatching }; }
      if (cmd === 'models') { await new Promise(resolve => setTimeout(resolve, 30)); if (window.fixtureModelsError) throw window.fixtureModelsError; return ['gpt-6-astra', 'slow-model', 'new-model']; }
      if (cmd === 'inspect' && window.fixtureInitialError) throw '配置不是有效的 TOML，请先修复原文件。';
      if (cmd === 'choose') window.fixtureInitialError = false;
      if (cmd === 'inspect' || cmd === 'choose') return { ...window.fixtureState };
      if (cmd === 'preview') {
        const lag = window.fixturePreviewDelay || (args.model === 'slow-model' ? 180 : 0);
        await new Promise(resolve => setTimeout(resolve, lag));
        if (!args.baseUrl.startsWith('https://')) throw '请输入有效的 HTTPS API 地址。';
        return 'model_provider = "' + (args.modelChannel === 'official' ? 'openai' : 'custom') + '"\\nmodel = "' + args.model + '"\\nrequires_openai_auth = ' + args.keepOfficialLogin + '\\nexperimental_bearer_token = "（已隐藏）"' + (window.fixturePreviewExtra || '');
      }
      if (cmd === 'configure') {
        if (window.fixtureConfigureError) throw window.fixtureConfigureError;
        await new Promise(resolve => setTimeout(resolve, window.fixtureConfigureDelay || 80));
        if (args.connection.apiKey === 'invalid') throw '请提供有效的 API 密钥';
        Object.assign(window.fixtureState, { apiKey: args.connection.apiKey, hasKey: true, modelChannel: 'api', baseUrl: args.connection.baseUrl, model: args.connection.model, keepOfficialLogin: args.keepOfficialLogin });
        window.fixtureBackups.push({ id: 'fixture-id', file: window.fixtureState.file, created: '2026-09-08T06:00:00.000Z', kind: 'configure', existed: false });
        return { backupId: 'fixture-id' };
      }
      if (cmd === 'switch_channel') {
        await new Promise(resolve => setTimeout(resolve, window.fixtureChannelDelay || 0));
        if (window.fixtureChannelError) throw window.fixtureChannelError;
        if (args.channel === 'api' && !window.fixtureState.hasKey) throw '请先完成 API 密钥配置。';
        window.fixtureState.modelChannel = args.channel;
        return { changed: true };
      }
      if (cmd === 'incoming') { if (!window.fixtureIncoming) return null; window.fixtureIncoming = false; window.fixtureState.hasKey = true; return {}; }
      if (cmd === 'backups') return [...window.fixtureBackups];
      if (cmd === 'backup_preview') return { ...window.fixtureBackups.find(v => v.id === args.id) };
      if (cmd === 'restore' || cmd === 'delete_backup') { if (window.fixtureDialogError) throw window.fixtureDialogError; return { canceled: true }; }
      if (cmd.startsWith('plugin:window|')) return null;
      throw 'Unexpected command: ' + cmd;
    }, { shouldMockEvents: true });
  ` });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (options.initialError) await page.waitForFunction(() => document.getElementById('configure')?.getAttribute('aria-busy') === 'false' && document.getElementById('status').textContent.includes('TOML'));
  else await page.waitForFunction(() => document.getElementById('key')?.disabled === false && document.getElementById('preview-code')?.textContent);
  } catch (error) { await browser.close(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { page, context, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
test('React: themes, compact layouts, private inputs and configure/history flow', async () => {
  const f = await fixture(); const { page, context } = f;
  try {
    await page.locator('#keep-official-login').check();
    const channel = page.getByRole('radiogroup', { name: '提供商' });
    const apiChannel = channel.getByRole('radio', { name: 'API', exact: true });
    const officialChannel = channel.getByRole('radio', { name: '官方', exact: true });
    assert.equal(await apiChannel.isChecked(), true);
    await officialChannel.click();
    await page.waitForFunction(() => document.querySelector('input[name="model-channel"][value="official"]').checked);
    assert.equal((await page.locator('#status').textContent()).trim(), '切换成功，新对话生效');
    await officialChannel.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('input[name="model-channel"][value="api"]').checked);
    await page.waitForFunction(() => !document.querySelector('main').dataset.channelUpdating);
    for (const scheme of ['dark', 'light']) {
      await page.getByRole('radio', { name: scheme === 'dark' ? '石墨灰' : '雾白', exact: true }).check();
      await page.waitForTimeout(160); // Finish theme color transitions before visual capture.
      for (const width of [600, 460]) {
        await page.setViewportSize({ width, height: 460 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
        const cardSpacing = await page.locator('.config-card').evaluate(el => {
          const card = el.getBoundingClientRect();
          return { top: card.top, bottom: innerHeight - card.bottom, headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom };
        });
        assert.ok(Math.abs(cardSpacing.top - cardSpacing.bottom) <= 1, JSON.stringify(cardSpacing));
        assert.ok(cardSpacing.top >= cardSpacing.headerBottom + 16, JSON.stringify(cardSpacing));
        await page.screenshot({ path: path.join(output, `${scheme}-${width}.png`) });
      }
    }
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await page.getByRole('radio', { name: '跟随系统' }).check();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.setViewportSize({ width: 600, height: 460 });
    await page.locator('#key').fill('sk-react-fixture-not-a-real-key');
    await page.getByRole('button', { name: '显示密钥' }).click(); assert.equal(await page.locator('#key').getAttribute('type'), 'text');
    await page.getByRole('button', { name: '隐藏密钥' }).click();
    await page.locator('#keep-official-login').check();
    await page.locator('#toggle-settings').click();
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('true'));
    assert.ok(!(await page.locator('#preview-code').textContent()).includes('sk-react-fixture'));
    await page.waitForFunction(() => [...document.querySelectorAll('#model option')].some(v => v.value === 'slow-model'));
    await page.locator('#model').selectOption('slow-model');
    await page.locator('#model').selectOption('new-model');
    await page.waitForTimeout(250);
    assert.ok((await page.locator('#preview-code').textContent()).includes('new-model'));
    await page.getByRole('button', { name: '清空 API 地址', exact: true }).click();
    assert.equal(await page.locator('#base-url').inputValue(), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'base-url');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#base-url').fill('https://api.beiapi.cn/v1');
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    await page.screenshot({ path: path.join(output, 'settings.png'), fullPage: true });
    await page.locator('#toggle-settings').click();
    await page.locator('#key').fill('invalid'); await page.locator('#apply').click();
    await page.waitForFunction(() => document.getElementById('key-help').textContent.includes('有效'));
    await page.screenshot({ path: path.join(output, 'error.png') });
    await page.locator('#key').fill('sk-react-fixture-not-a-real-key'); await page.locator('#apply').click();
    await page.locator('#success-title').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'success-title');
    assert.equal(await page.locator('#key').count(), 0);
    await page.screenshot({ path: path.join(output, 'success.png') });
    await page.locator('#done').click(); assert.equal(await page.locator('#key').inputValue(), 'sk-react-fixture-not-a-real-key');
    await page.locator('#open-history').click(); await page.getByRole('button', { name: '查看', exact: true }).click();
    await page.locator('#backup-preview[open]').waitFor();
    assert.ok((await page.locator('#backup-preview').textContent()).includes('文件不存在'));
    await page.getByRole('button', { name: '还原此配置' }).click();
    assert.equal(await page.locator('#backup-preview[open]').count(), 1);
    await page.screenshot({ path: path.join(output, 'backup.png') });
    await page.keyboard.press('Escape'); await page.locator('#back-to-config').click();
    assert.equal(await page.locator('#key').inputValue(), 'sk-react-fixture-not-a-real-key');
    assert.equal(await page.locator('#keep-official-login').isChecked(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: saved keys load masked, clearing stays empty, and gateway edits do not reuse them', async () => {
  const f = await fixture(); const { page } = f;
  try {
    assert.equal(await page.locator('#key').inputValue(), 'sk-saved-fixture-not-real-key');
    assert.equal(await page.locator('#key').getAttribute('type'), 'password');
    assert.equal(await page.locator('#key').getAttribute('placeholder'), null);
    await page.getByRole('button', { name: '清空输入的密钥' }).click();
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#toggle-settings').click();
    await page.waitForFunction(() => document.getElementById('models-help').textContent.includes('填写密钥'));
    await page.reload();
    await page.waitForFunction(() => document.getElementById('key').value.length > 0);
    await page.locator('#toggle-settings').click();
    await page.locator('#base-url').fill('https://another.example/v1');
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
  const empty = await fixture({ savedKey: '' });
  try {
    assert.equal(await empty.page.locator('#key').inputValue(), '');
    assert.equal(await empty.page.locator('#apply').isDisabled(), true);
  } finally { await empty.close(); }
});

test('React: manual version matching blocks writes until valid, template activation updates preview', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    assert.equal(await page.locator('#update-template').isDisabled(), true);
    assert.match(await page.locator('#preview-version').textContent(), /当前 v1.0.0 · 最新 v1.0.0/);
    await page.evaluate(() => {
      window.fixtureMatching.latestTemplate = { id: 'codex-default', version: '1.1.0', digest: 'updated' };
      window.fixtureMatching.templateUpdateAvailable = true;
    });
    await page.locator('#change-version').click();
    assert.match(await page.locator('#installation option[value="desktop"]').textContent(), /桌面版 26.901.51231 · 内核 0.154.0/);
    await page.locator('#installation').selectOption('manual');
    await page.locator('#runtime-version').fill('invalid');
    await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('有效'));
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#runtime-version').fill('0.153.9');
    await page.locator('#runtime-version').press('Enter');
    await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('已匹配'));
    await page.getByRole('button', { name: '关闭版本选择' }).click();
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await page.locator('.template-update-dot').count(), 1);
    await page.locator('#update-template').click();
    await page.waitForFunction(() => document.querySelector('#preview-version').textContent.includes('当前 v1.1.0'));
    assert.equal(await page.locator('#update-template').isDisabled(), true);
    assert.equal(await page.locator('.template-update-dot').count(), 0);
    await page.locator('#change-version').click();
    await page.evaluate(async () => { window.fixtureIncoming = true; await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'incoming-changed', payload: null }); });
    await page.locator('#success-title').waitFor();
    assert.equal(await page.locator('#version-choice[open]').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: malformed initial configuration retains its error and can recover through file selection', async () => {
  const f = await fixture({ initialError: true }); const { page } = f;
  try {
    await page.waitForTimeout(150);
    assert.ok((await page.locator('#status').textContent()).includes('TOML'));
    await page.locator('#toggle-settings').click();
    await page.locator('#choose').click();
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: login toggles preserve scroll and historical TOML stays readable in small windows', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#key').fill('sk-react-fixture-not-a-real-key');
    await page.evaluate(() => {
      window.fixturePreviewExtra = '\n' + Array.from({ length: 35 }, (_, i) => `setting_${i} = true`).join('\n');
      window.fixturePreviewDelay = 180;
    });
    await page.locator('#toggle-settings').click();
    await page.locator('#keep-official-login').check();
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    await page.waitForFunction(() => [...document.querySelectorAll('#model option')].some(v => v.value === 'new-model'));
    assert.match(await page.locator('#version-info').textContent(), /CLI · 0.153.4.*桌面版 26.901.51231 · 内核 0.154.0/);
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 460 });
      await page.locator('#keep-official-login').scrollIntoViewIfNeeded();
      const region = await page.evaluate(() => {
        const content = document.querySelector('.content-scroll');
        const header = document.querySelector('.app-header').getBoundingClientRect();
        return { top: content.getBoundingClientRect().top, headerBottom: header.bottom, headerTop: header.top, documentScroll: scrollY, contentScroll: content.scrollTop };
      });
      assert.equal(region.top, region.headerBottom);
      assert.equal(region.headerTop, 0);
      assert.equal(region.documentScroll, 0);
      assert.ok(region.contentScroll > 0);
      for (const checked of [false, true, false, true]) {
        const before = await page.evaluate(() => ({ y: document.querySelector('.content-scroll').scrollTop, height: document.getElementById('preview-code').getBoundingClientRect().height }));
        await page.locator('#keep-official-login').setChecked(checked);
        await page.waitForTimeout(60);
        const pending = await page.evaluate(() => ({ y: document.querySelector('.content-scroll').scrollTop, height: document.getElementById('preview-code').getBoundingClientRect().height }));
        assert.equal(pending.height, before.height);
        assert.ok(Math.abs(pending.y - before.y) <= 1, `scroll moved ${before.y} -> ${pending.y}`);
        await page.waitForFunction(() => !document.getElementById('apply').disabled);
        assert.ok(Math.abs(await page.evaluate(() => document.querySelector('.content-scroll').scrollTop) - before.y) <= 1);
      }
    }
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overscrollBehaviorY), 'none');
    await page.evaluate(() => {
      window.fixtureBackups = [{ id: 'readable', file: '/isolated/config/config.toml', created: '2026-09-08T06:00:00Z', kind: 'configure', existed: true, keepOfficialLogin: true, baseUrl: 'https://example.com/v1', content: 'model = "gpt-6-astra"\n[model_providers.custom]\nbase_url = "https://example.com/v1"\nrequires_openai_auth = true\nexperimental_bearer_token = "（已隐藏）"\n' + Array.from({ length: 40 }, (_, i) => `setting_${i} = true`).join('\n') }];
    });
    await page.locator('#open-history').click();
    assert.equal(await page.locator('.backup-login-badge').textContent(), '保留官方登录');
    assert.equal(await page.locator('.backup-detail').textContent(), 'https://example.com/v1');
    await page.getByRole('button', { name: '查看', exact: true }).click();
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 460 });
      const dimensions = await page.evaluate(() => {
        const pre = document.getElementById('backup-preview-code');
        const footer = document.querySelector('.backup-preview-footer').getBoundingClientRect();
        const dialog = document.getElementById('backup-preview').getBoundingClientRect();
        return { height: pre.clientHeight, scrollable: pre.scrollHeight > pre.clientHeight, footerBottom: footer.bottom, dialogBottom: dialog.bottom, viewport: innerHeight };
      });
      assert.ok(dimensions.height >= 120, JSON.stringify(dimensions));
      assert.ok(dimensions.scrollable);
      assert.ok(dimensions.footerBottom <= dimensions.dialogBottom && dimensions.dialogBottom <= dimensions.viewport);
      assert.equal(await page.locator('.version-dialog-close:focus-visible').count(), 0);
      await page.screenshot({ path: path.join(output, `backup-readable-${width}.png`) });
    }
    await page.locator('#backup-preview-code').hover();
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.getElementById('backup-preview-code').scrollTop > 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#backup-preview[open]').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: configuration preview scrolls internally and chains to its parent at both edges', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#key').fill('sk-react-fixture-not-a-real-key');
    await page.evaluate(() => {
      window.fixturePreviewExtra = '\n' + Array.from({ length: 40 }, (_, i) => `setting_${i} = true`).join('\n');
    });
    await page.locator('#toggle-settings').click();
    await page.locator('#keep-official-login').check();
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    await page.waitForFunction(() => [...document.querySelectorAll('#model option')].some(v => v.value === 'new-model'));
    const position = async edge => page.evaluate(edge => {
      const outer = document.querySelector('.content-scroll');
      const pre = document.getElementById('preview-code');
      const offset = pre.getBoundingClientRect().top - outer.getBoundingClientRect().top + outer.scrollTop;
      const padding = parseFloat(getComputedStyle(outer).scrollPaddingBottom) || 0;
      const inset = Math.max(0, Math.min(130, outer.clientHeight - pre.getBoundingClientRect().height - padding - 8));
      outer.scrollTop = offset - inset;
      pre.scrollTop = edge === 'bottom' ? pre.scrollHeight : edge === 'middle' ? 100 : 0;
      return { outer: outer.scrollTop, inner: pre.scrollTop };
    }, edge);
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 460 });
      const middle = await position('middle');
      await page.locator('#preview-code').hover();
      await page.mouse.wheel(0, 60);
      await page.waitForFunction(y => document.getElementById('preview-code').scrollTop > y, middle.inner);
      assert.equal(await page.locator('.content-scroll').evaluate(el => el.scrollTop), middle.outer);
      const bottom = await position('bottom');
      await page.locator('#preview-code').hover();
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(y => document.querySelector('.content-scroll').scrollTop > y, bottom.outer);
      const top = await position('top');
      await page.locator('#preview-code').hover();
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(y => document.querySelector('.content-scroll').scrollTop < y, top.outer);
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal(await page.locator('.toolbar').evaluate(el => el.getBoundingClientRect().top), 0);
    }
    await page.evaluate(() => { window.fixturePreviewExtra = ''; });
    await page.locator('#keep-official-login').uncheck();
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await page.locator('#preview-code').evaluate(el => el.scrollHeight <= el.clientHeight), true);
    const short = await position('top');
    await page.locator('#preview-code').hover();
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(y => document.querySelector('.content-scroll').scrollTop < y, short.outer);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: version switching keeps the background layout stable until the dialog closes', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    await page.locator('#change-version').click();
    await page.evaluate(() => { window.fixtureVersionDelay = 180; });
    const layout = () => page.evaluate(() => ({
      scroll: document.querySelector('.content-scroll').scrollTop,
      height: document.querySelector('main').getBoundingClientRect().height,
      settingsTop: document.getElementById('settings').getBoundingClientRect().top,
      preview: document.getElementById('preview-code').textContent,
      selection: document.querySelector('.selected-version')?.textContent || '',
    }));
    const before = await layout();
    for (const selection of ['cli', 'desktop']) {
      await page.locator('#installation').selectOption(selection);
      await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('正在匹配'));
      assert.deepEqual(await layout(), before);
      await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('已匹配'));
      assert.deepEqual(await layout(), before);
    }
    await page.getByRole('button', { name: '关闭版本选择' }).click();
    await page.waitForFunction(() => document.querySelector('.selected-version')?.textContent.includes('桌面版'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: reserved feedback slots keep fields and dialogs stable when errors appear and clear', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    await page.waitForFunction(() => [...document.querySelectorAll('#model option')].some(v => v.value === 'new-model'));
    const layout = () => page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, height: r.height }; };
      return ['.config-card', '#key', '#model', '#base-url', '#target', '#status'].map(rect);
    });
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 560 });
      const before = await layout();
      await page.evaluate(() => { window.fixtureModelsError = '无法获取模型，请检查密钥及访问权限。'; document.getElementById('refresh-models').click(); });
      await page.waitForFunction(() => document.getElementById('key-help').textContent.includes('无法获取模型'));
      assert.deepEqual(await layout(), before);
      await page.evaluate(() => { window.fixtureModelsError = ''; document.getElementById('refresh-models').click(); });
      await page.waitForFunction(() => !document.getElementById('models-help').textContent && !document.getElementById('refresh-models').disabled);
      assert.deepEqual(await layout(), before);
    }
    await page.locator('#toggle-settings').click();
    await page.locator('#key').fill('invalid');
    const beforeError = await layout();
    await page.locator('#apply').click();
    await page.waitForFunction(() => document.getElementById('key-help').textContent.includes('有效'));
    assert.deepEqual(await layout(), beforeError);
    assert.equal(await page.locator('#status').textContent(), '');
    assert.equal(await page.locator('#key').getAttribute('aria-invalid'), 'true');
    const keyPlacement = await page.evaluate(() => {
      const key = document.getElementById('key').getBoundingClientRect();
      const help = document.getElementById('key-help').getBoundingClientRect();
      return { gap: help.top - key.bottom, height: help.height };
    });
    assert.equal(keyPlacement.height, 18);
    assert.ok(keyPlacement.gap >= 0 && keyPlacement.gap <= 6);
    await page.locator('#key').fill('sk-edited-fixture');
    assert.equal(await page.locator('#key').getAttribute('aria-invalid'), 'false');
    const globalError = '验证 API 密钥时网络连接失败，请稍后重试。';
    await page.evaluate(message => { window.fixtureConfigureError = message; }, globalError);
    await page.locator('#apply').click();
    await page.waitForFunction(message => document.getElementById('status').textContent === message, globalError);
    assert.ok(!(await page.locator('#key-help').textContent()).includes('网络'));
    assert.deepEqual(await layout(), beforeError);
    await page.evaluate(() => {
      window.fixtureBackups = [{ id: 'stable', file: '/isolated/config/config.toml', created: '2026-09-08T06:00:00Z', kind: 'configure', existed: true, baseUrl: 'https://example.com/v1', keepOfficialLogin: false, content: 'model = "gpt-6-astra"\n'.repeat(40) }];
      window.fixtureDialogError = '配置已改变，请刷新后重试。';
    });
    await page.locator('#open-history').click();
    await page.getByRole('button', { name: '查看', exact: true }).click();
    const dialogLayout = () => page.evaluate(() => ['#backup-preview', '#backup-preview-code', '.backup-preview-footer'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, height: r.height }; }));
    const beforeDialogError = await dialogLayout();
    await page.getByRole('button', { name: '还原此配置' }).click();
    await page.waitForFunction(() => document.getElementById('backup-preview-status').textContent.includes('刷新'));
    assert.deepEqual(await dialogLayout(), beforeDialogError);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('updater: manual checks reserve feedback space and failed signature never enables install', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.getByRole('button', { name: 'CodexBei 软件更新' }).click();
    const before = await page.locator('#software-update').boundingBox();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.software-update-status').textContent === '已是最新版本。');
    await page.evaluate(() => window.fixtureUpdateCheckError = true);
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.software-update-status').textContent.includes('无法检查更新'));
    assert.deepEqual(await page.locator('#software-update').boundingBox(), before);
    await page.evaluate(() => { window.fixtureUpdateCheckError = false; window.fixtureUpdate = true; window.fixtureUpdateDownloadError = true; });
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.software-update-status').textContent.includes('校验失败'));
    assert.equal(await page.getByRole('button', { name: '重启更新', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('plugin:updater|install')), false);
    assert.deepEqual(await page.locator('#software-update').boundingBox(), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('updater: download survives page navigation; install waits for configuration, then requires a click', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.evaluate(() => { window.fixtureUpdate = true; window.fixtureUpdateDelay = 200; });
    const before = await page.locator('.config-card').boundingBox();
    await page.getByRole('button', { name: 'CodexBei 软件更新' }).click();
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('button', { name: '关闭软件更新' }).click();
    await page.locator('#open-history').click();
    await page.locator('#back-to-config').click();
    await page.waitForFunction(() => !!document.querySelector('.software-update-dot'));
    assert.deepEqual(await page.locator('.config-card').boundingBox(), before);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('plugin:updater|install')), false);
    await page.evaluate(() => window.fixtureConfigureDelay = 900);
    await page.locator('#apply').click();
    await page.getByRole('button', { name: 'CodexBei 软件更新' }).click();
    assert.equal(await page.getByRole('button', { name: '重启更新', exact: true }).isDisabled(), true);
    await page.waitForFunction(() => !document.querySelector('.software-update-actions button').disabled);
    await page.evaluate(() => window.fixtureUpdateInstallError = true);
    await page.getByRole('button', { name: '重启更新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.software-update-status').textContent.includes('安装失败'));
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('plugin:process|restart')), false);
    await page.evaluate(() => { window.fixtureUpdateInstallError = false; window.fixtureUpdateRestartError = true; });
    await page.getByRole('button', { name: '重启更新', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.software-update-status').textContent.includes('更新已安装'));
    const installs = await page.evaluate(() => window.fixtureCalls.filter(c => c === 'plugin:updater|install').length);
    await page.getByRole('button', { name: '重启更新', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.software-update-actions button').disabled);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(c => c === 'plugin:updater|install').length), installs);
    await page.screenshot({ path: path.join(output, 'software-update.png') });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('updater: startup automatically checks and downloads without opening a dialog', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.evaluate(() => window.fixtureUpdate = true);
    await page.waitForFunction(() => !!document.querySelector('.software-update-dot'), { timeout: 10000 });
    assert.equal(await page.locator('#software-update').evaluate(el => el.open), false);
    const calls = await page.evaluate(() => window.fixtureCalls);
    assert.equal(calls.filter(c => c === 'plugin:updater|check').length, 1);
    assert.ok(calls.includes('plugin:updater|download'));
    assert.ok(!calls.includes('plugin:updater|install'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: channel routing refreshes preview without fading the form or discarding edits', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    await page.locator('#key').fill('sk-unsaved-fixture');
    await page.locator('#keep-official-login').check();
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('true'));
    for (const theme of ['雾白', '石墨灰']) {
      await page.getByRole('radio', { name: theme, exact: true }).check();
      await page.waitForTimeout(160);
      await page.evaluate(() => { window.fixtureChannelDelay = 400; window.fixturePreviewDelay = 200; });
      const appearance = () => page.evaluate(() => ['.config-card', '#key', '.login-option', '#apply', '#open-history'].map(selector => {
        const el = document.querySelector(selector), style = getComputedStyle(el);
        return [selector, style.backgroundColor, style.opacity, selector === '#apply' ? el.textContent : ''];
      }));
      const before = await appearance();
      await page.getByRole('radio', { name: '官方', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('main').dataset.channelUpdating === 'true');
      assert.deepEqual(await appearance(), before);
      assert.equal(await page.locator('#apply').isDisabled(), true);
      await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('model_provider = "openai"') && !document.querySelector('main').dataset.channelUpdating);
      assert.equal(await page.locator('#key').inputValue(), 'sk-unsaved-fixture');
      assert.equal(await page.locator('#keep-official-login').isChecked(), true);
      await page.getByRole('radio', { name: 'API', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('model_provider = "custom"') && !document.querySelector('main').dataset.channelUpdating);
    }
    await page.evaluate(() => { window.fixtureChannelError = '切换失败，请重试。'; });
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('切换失败'));
    assert.equal(await page.getByRole('radio', { name: 'API', exact: true }).isChecked(), true);
    assert.ok((await page.locator('#preview-code').textContent()).includes('model_provider = "custom"'));
    assert.equal(await page.locator('#apply').isDisabled(), false);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('configure')), false);
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: login checkbox gates providers and its pixels stay stable during channel writes', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const checkbox = page.locator('#keep-official-login');
    for (const theme of ['雾白', '石墨灰']) {
      await page.getByRole('radio', { name: theme, exact: true }).check();
      await checkbox.uncheck();
      const providers = page.getByRole('radiogroup', { name: '提供商' });
      assert.equal(await providers.getAttribute('title'), null);
      assert.equal(await providers.getAttribute('aria-disabled'), 'true');
      assert.equal(await providers.getByRole('radio', { name: 'API', exact: true }).isDisabled(), true);
      assert.equal(await providers.getByRole('radio', { name: '官方', exact: true }).isDisabled(), true);
      await providers.hover();
      const tooltip = page.getByRole('tooltip');
      assert.equal(await tooltip.isVisible(), true);
      assert.equal(await tooltip.textContent(), '请先打开保留官方登录');
      await tooltip.hover();
      assert.equal(await tooltip.isVisible(), true);
      await page.screenshot({ path: path.join(output, `provider-tooltip-${theme === '雾白' ? 'light' : 'dark'}.png`) });
      await page.keyboard.press('Escape');
      // Keyboard dismissal is checked with focus on the disabled group.
      await providers.focus();
      assert.equal(await tooltip.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await tooltip.isVisible(), false);
      await page.locator('.channel-segment').last().click({ force: true });
      assert.equal(await providers.getByRole('radio', { name: 'API', exact: true }).isChecked(), true);
      for (const checked of [true]) {
        await checkbox.setChecked(checked);
        assert.equal(await providers.getAttribute('aria-disabled'), 'false');
        assert.equal(await providers.getByRole('radio', { name: '官方', exact: true }).isDisabled(), false);
        await providers.hover();
        assert.equal(await page.locator('#provider-tooltip').count(), 0);
        await page.getByRole('radio', { name: 'API', exact: true }).focus();
        await page.waitForFunction(() => !document.querySelector('main').dataset.channelUpdating && !document.getElementById('apply').disabled);
        await page.waitForTimeout(160);
        const before = await checkbox.screenshot();
        await page.evaluate(() => { window.fixtureChannelDelay = 1200; });
        await page.getByRole('radio', { name: '官方', exact: true }).click();
        await page.waitForFunction(() => document.getElementById('keep-official-login').disabled);
        const during = await checkbox.screenshot();
        assert.deepEqual(during, before, `${theme}, checked=${checked}: checkbox changed while disabled`);
        await page.waitForFunction(() => !document.querySelector('main').dataset.channelUpdating && !document.getElementById('keep-official-login').disabled);
        assert.equal(await checkbox.isChecked(), checked);
        assert.deepEqual(await checkbox.screenshot(), before);
        await page.evaluate(() => { window.fixtureChannelDelay = 0; });
        await page.getByRole('radio', { name: 'API', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('input[name="model-channel"][value="api"]').checked && !document.querySelector('main').dataset.channelUpdating);
      }
    }
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: provider tooltip leaves no painted shadow after pointer exit', async () => {
  const f = await fixture(); const { page } = f;
  try {
    for (const theme of ['雾白', '石墨灰']) {
      await page.getByRole('radio', { name: theme, exact: true }).check();
      for (const width of [600, 460]) {
        await page.setViewportSize({ width, height: 460 });
        await page.mouse.move(10, 100);
        await page.waitForTimeout(160);
        const clip = await page.locator('#model-channel').evaluate(el => {
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.floor(r.left) - 100), y = Math.ceil(r.bottom) + 4;
          return { x, y, width: Math.min(300, innerWidth - x), height: Math.min(80, innerHeight - y) };
        });
        const before = await page.screenshot({ clip });
        for (let i = 0; i < 3; i++) {
          await page.locator('#model-channel').hover();
          assert.equal(await page.getByRole('tooltip').isVisible(), true);
          await page.getByRole('tooltip').hover();
          await page.mouse.move(10, 100);
          assert.equal(await page.getByRole('tooltip').isVisible(), false);
          await page.waitForTimeout(160);
          assert.equal(await page.locator('#provider-tooltip').count(), 0);
          const after = await page.screenshot({ clip });
          if (!after.equals(before)) {
            fs.writeFileSync(path.join(output, 'tooltip-shadow-before.png'), before);
            fs.writeFileSync(path.join(output, 'tooltip-shadow-after.png'), after);
          }
          assert.ok(after.equals(before), `${theme}/${width}: tooltip left painted pixels after hiding`);
        }
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: provider selection slides between options and respects reduced motion', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#keep-official-login').check();
    for (const [channel, destination] of [['official', 44], ['api', 0]]) {
      const positions = await page.evaluate(async channel => {
        document.querySelector(`input[name="model-channel"][value="${channel}"]`).click();
        const samples = [];
        const started = performance.now();
        while (performance.now() - started < 450) {
          await new Promise(requestAnimationFrame);
          samples.push(new DOMMatrixReadOnly(getComputedStyle(document.getElementById('model-channel'), '::before').transform).m41);
        }
        return samples;
      }, channel);
      assert.ok(positions.some(x => x > 0 && x < 44), 'selection should pass through intermediate positions');
      assert.equal(positions.at(-1), destination);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#model-channel').evaluate(el => getComputedStyle(el, '::before').transitionDuration), '0s');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: login preference refresh keeps apply button pixels stable while blocking stale submission', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const apply = page.locator('#apply'), checkbox = page.locator('#keep-official-login');
    for (const theme of ['雾白', '石墨灰']) {
      await page.getByRole('radio', { name: theme, exact: true }).check();
      await page.waitForTimeout(160);
      const before = await apply.screenshot();
      await page.evaluate(() => { window.fixturePreviewDelay = 600; });
      for (const checked of [true, false, true, false]) {
        await checkbox.setChecked(checked);
        assert.equal(await apply.isDisabled(), true);
        assert.ok((await apply.screenshot()).equals(before), 'preview refresh must not fade the apply button');
      }
      await apply.evaluate(el => el.click());
      assert.equal(await page.evaluate(() => window.fixtureCalls.includes('configure')), false);
      await page.waitForFunction(() => !document.getElementById('apply').disabled);
      assert.ok((await apply.screenshot()).equals(before));
      assert.ok((await page.locator('#preview-code').textContent()).includes('requires_openai_auth = false'));
      await page.locator('#key').fill('');
      await checkbox.check();
      assert.equal(await apply.isDisabled(), true);
      assert.equal(await apply.evaluate(el => getComputedStyle(el).opacity), '0.45');
      await checkbox.uncheck();
      await page.locator('#key').fill('sk-valid-fixture');
      await page.waitForFunction(() => !document.getElementById('apply').disabled);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: success notice expires after latest switch and never dismisses errors', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#keep-official-login').check();
    const notice = '切换成功，新对话生效';
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    await page.waitForFunction(notice => document.getElementById('status').textContent === notice, notice);
    const cardBefore = await page.locator('.config-card').boundingBox();
    await page.waitForTimeout(2000);
    await page.getByRole('radio', { name: 'API', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name="model-channel"][value="api"]').checked && !document.querySelector('main').dataset.channelUpdating);
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#status').textContent(), notice);
    await page.waitForFunction(() => document.getElementById('status').textContent === '', null, { timeout: 4000 });
    assert.deepEqual(await page.locator('.config-card').boundingBox(), cardBefore);
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    await page.waitForFunction(notice => document.getElementById('status').textContent === notice, notice);
    await page.evaluate(() => { window.fixtureChannelError = '切换失败，请重试。'; });
    await page.getByRole('radio', { name: 'API', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('切换失败'));
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('#status').textContent(), '切换失败，请重试。');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
