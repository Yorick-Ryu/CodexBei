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
    window.fixtureState = { apiKey: ${JSON.stringify(options.savedKey ?? 'sk-saved-fixture-not-real-key')}, hasKey: ${!!(options.savedKey ?? 'sk-saved-fixture-not-real-key')}, modelChannel: ${JSON.stringify(options.modelChannel || 'api')}, keepOfficialLogin: ${!!options.keepOfficialLogin}, baseUrl: ${JSON.stringify(options.baseUrl || 'https://api.beiapi.cn/v1')}, model: 'gpt-6-astra', file: '/isolated/config/config.toml', platform: ${JSON.stringify(options.platform || 'macos')}, testMode: true };
    const configurationChannel = args => args.modelChannel ?? (window.fixtureState.hasKey && window.fixtureState.baseUrl ? window.fixtureState.modelChannel : 'api');
    window.fixtureState.serviceTier = ${JSON.stringify(options.serviceTier ?? null)};
    const configuredTier = args => args.speed === 'fast' ? 'fast' : args.speed === 'standard' ? 'default' : window.fixtureState.serviceTier;
    window.fixtureBackups = [];
    window.fixtureClaude = { apiKey: 'sk-claude-fixture-not-real', hasKey: true, baseUrl: 'https://api.beiapi.cn', model: 'claude-sonnet-test', file: '/isolated/claude/settings.json', platform: 'macos', modelChannel: 'api', keepOfficialLogin: false, testMode: true };
    window.fixtureClaudeBackups = [];
    window.fixtureClaudeCalls = [];
    window.fixtureMatching = { installations: [{ id: 'cli', kind: 'cli', runtimeVersion: '0.153.4' }, { id: 'desktop', kind: 'desktop', runtimeVersion: '0.154.0', appVersion: '26.901.51231' }], selection: { mode: 'installed', id: 'desktop' }, template: { id: 'codex-default', version: '1.0.0', digest: 'fixture' }, latestTemplate: { id: 'codex-default', version: '1.0.0', digest: 'fixture' }, templateUpdateAvailable: false, offline: false, needsSelection: false, modelClientVersion: '0.154.0' };
    if (${!!options.longVersions}) { Object.assign(window.fixtureMatching.installations[1], { runtimeVersion: '0.162.0-alpha.17.2', appVersion: '26.1007.21159' }); window.fixtureMatching.modelClientVersion = '0.162.0-alpha.17.2'; }
    window.fixtureCalls = [];
    window.fixtureModelsError = ${JSON.stringify(options.modelsError || '')};
    window.fixtureModelsDelay = ${options.modelsDelay ?? 30};
    window.fixtureModels = ${JSON.stringify(options.models ?? ['gpt-6-astra', 'slow-model', 'new-model'])};
    window.fixtureQuotaDelay = ${options.quotaDelay || 0};
    window.fixtureQuotaError = ${JSON.stringify(options.quotaError || '')};
    window.fixtureEmptyQuota = ${!!options.emptyQuota};
    window.fixtureOfficialLogin = ${options.officialLogin !== false};
    if (${!!options.cliOnly}) { window.fixtureMatching.installations = window.fixtureMatching.installations.filter(item => item.kind === 'cli'); window.fixtureMatching.selection = { mode: 'installed', id: 'cli' }; window.fixtureMatching.modelClientVersion = '0.153.4'; }
    if (${!!options.noInstallations}) window.fixtureMatching.installations = [];
    window.fixtureInitialError = ${JSON.stringify(options.initialError || false)};
    mockIPC(async (cmd, args) => {
      window.fixtureCalls.push(cmd);
      if (cmd === 'check' && window.fixtureHoldCheck) await new Promise(resolve => { window.fixtureReleaseCheck = resolve; });
      if (cmd === 'incoming_tool') return window.fixtureIncomingTool || null;
      if (args?.tool === 'claude') {
        window.fixtureClaudeCalls.push({ cmd, args });
        if (cmd === 'open_claude_installer') return null;
        if (cmd === 'inspect' || cmd === 'choose') return {...window.fixtureClaude};
        if (cmd === 'check') return {installations: [], selection: {mode: 'auto'}, template: {id: 'claude-builtin', version:'1.0.0',digest:'claude-v1'},latestTemplate:null,templateUpdateAvailable:false,offline:false,needsSelection:false,modelClientVersion:'claude'};
        if (cmd === 'preview') return JSON.stringify({env:{ANTHROPIC_BASE_URL:args.baseUrl,ANTHROPIC_MODEL:args.model,ANTHROPIC_AUTH_TOKEN:'（已隐藏）',ANTHROPIC_DEFAULT_OPUS_MODEL:args.mapping?.opus || args.model}},null,2);
        if (cmd === 'models') return ['claude-sonnet-test', 'claude-opus-test'];
        if (cmd === 'configure') { Object.assign(window.fixtureClaude, args.connection, {mapping:args.mapping}); window.fixtureClaudeBackups.push({id:'claude-backup',file:window.fixtureClaude.file,created:'2026-09-24T06:00:00.000Z',kind:'configure',existed:false}); return {}; }
        if (cmd === 'incoming') { if (window.fixtureIncomingTool !== 'claude') return null; window.fixtureIncomingTool = null; return {}; }
        if (cmd === 'backups') return [...window.fixtureClaudeBackups];
        if (cmd === 'backup_preview') return {...window.fixtureClaudeBackups[0], content:'hidden'};
        if (cmd === 'restore' || cmd === 'delete_backup') return {canceled:true};
        if (cmd === 'open_config_file') {window.fixtureOpenedFile = window.fixtureClaude.file; return null;}
      }
      if (cmd === 'refresh_catalog') {
        if (window.fixtureCatalogError) throw '模型获取失败，已保留原样';
        return { changed: !!window.fixtureCatalogChanged, native: !!window.fixtureCatalogNative };
      }
      if (cmd === 'plugin:app|version') return '0.1.0';
      if (cmd === 'plugin:updater|check') {
        if (window.fixtureUpdateCheckError) throw 'network';
        return window.fixtureUpdate ? { rid: 42, currentVersion: '0.1.0', version: '0.2.0', body: '改进更新流程', rawJson: {} } : null;
      }
      if (cmd === 'plugin:updater|download') {
        if (window.fixtureManualProgress) {
          window.fixtureProgressEvent = message => args.onEvent.onmessage(message);
          await new Promise(resolve => { window.fixtureFinishDownload = resolve; });
          return 43;
        }
        await new Promise(resolve => setTimeout(resolve, window.fixtureUpdateDelay || 30));
        if (window.fixtureUpdateDownloadError) throw 'signature mismatch';
        return 43;
      }
      if (cmd === 'plugin:updater|install') { if (window.fixtureUpdateInstallError) throw 'permission'; return null; }
      if (cmd === 'plugin:resources|close') return null;
      if (cmd === 'plugin:process|restart') { if (window.fixtureUpdateRestartError) throw 'restart'; return null; }
      if (cmd === 'windows_diagnostics') {
        await new Promise(resolve => setTimeout(resolve, window.fixtureDiagnosticDelay || 80));
        if (window.fixtureDiagnosticError) throw '排查未完成';
        return { schemaVersion: 1, hasDotEnvProxy: true, configurations: [{ source: '当前配置', content: 'model = "gpt-5.6-sol"' }], checks: [{ name: 'Codex .env', status: 'warning', detail: 'HTTPS_PROXY=http://127.0.0.1:7890; port=7890; tcp=UNREACHABLE' }, { name: '直连 HTTPS', status: 'ok', detail: 'GET https://api.beiapi.cn/v1/models; auth=NONE; HTTP 401; curl_exit=0; total=0.58s' }] };
      }
      if (cmd === 'check') {
        (window.fixtureCheckForces ||= []).push(args.force);
        if (args.selection && window.fixtureVersionDelay) await new Promise(resolve => setTimeout(resolve, window.fixtureVersionDelay));
        if (args.selection?.mode === 'manual') { if (!/^\\d+\\.\\d+\\.\\d+$/.test(args.selection.runtimeVersion)) throw args.selection.kind === 'cli' ? '请输入有效的 Codex CLI 版本。' : '请输入有效的内核版本及应用版本。'; window.fixtureMatching.modelClientVersion = args.selection.runtimeVersion; }
        if (args.selection) window.fixtureMatching.selection = args.selection;
        return { ...window.fixtureMatching };
      }
      if (cmd === 'update_template') { window.fixtureMatching.template = { id: 'codex-default', version: '1.1.0', digest: 'updated' }; window.fixtureMatching.templateUpdateAvailable = false; return { ...window.fixtureMatching }; }
      if (cmd === 'models') { await new Promise(resolve => setTimeout(resolve, window.fixtureModelsDelay)); if (window.fixtureModelsError) throw window.fixtureModelsError; return window.fixtureModels; }
      if (cmd === 'inspect' && window.fixtureInitialError) throw '配置不是有效的 TOML，请先修复原文件。';
      if (cmd === 'choose') window.fixtureInitialError = false;
      if (cmd === 'open_chatgpt_installer') { window.fixtureInstallerArgs = args; return null; }
      if (cmd === 'open_config_file') {
        if (window.fixtureOpenConfigError) throw window.fixtureOpenConfigError;
        window.fixtureOpenedFile = window.fixtureState.file;
        return null;
      }
      if (cmd === 'open_wallet') { window.fixtureWalletOpened = true; return null; }
      if (cmd === 'quota') {
        if (args.channel !== 'api') throw new Error('Official quota must not be queried');
        window.fixtureQuotaRequests = (window.fixtureQuotaRequests || 0) + 1;
        if (window.fixtureQuotaDelay) await new Promise(resolve => setTimeout(resolve, window.fixtureQuotaDelay));
        if (window.fixtureQuotaError) throw window.fixtureQuotaError;
        if (window.fixtureEmptyQuota) return {channel:'api',rows:[],groups:[]};
        return args.channel === 'official' ? { channel: 'official', planType: 'plus', rows: [{ label:'5 小时额度',value:'剩余 75%',remaining:window.fixtureOfficialRemaining ?? 75,resetAt:1790711528 },{ label:'每周额度',value:'剩余 67%',remaining:67,resetAt:1791048107 }] } : { channel:'api',rows:[{label:'余额',value:args.tool === 'claude' ? '$64.25' : '$128.50'},{label:'密钥余额',value:'不限额'}],groups:window.fixtureNoPlans ? [] : [
          {id:1,title:'Plus 月卡',expiresAt:1793286000,rows:[{label:'5 小时额度',value:'$24.00 / $30.00',remaining:80,resetAt:1790711528},{label:'每周额度',value:'$180.00 / $240.00',remaining:75,resetAt:1791048107}]},
          {id:2,title:'Ultra 月卡',expiresAt:1793286000,rows:[{label:'5 小时额度',value:'$120.00 / $150.00',remaining:80,resetAt:1790711528},{label:'每周额度',value:'$960.00 / $1200.00',remaining:80,resetAt:1791048107}]}
        ]};
      }
      if (cmd === 'inspect' || cmd === 'choose') return { ...window.fixtureState, hasOfficialCredentials: window.fixtureOfficialLogin };
      if (cmd === 'has_official_login') {
        if (window.fixtureOfficialLoginDelay) await new Promise(resolve => setTimeout(resolve, window.fixtureOfficialLoginDelay));
        if (window.fixtureOfficialLoginError) throw '无法检测官方登录状态，请重试。';
        return window.fixtureOfficialLogin;
      }
      if (cmd === 'preview') {
        window.fixturePreviewSpeed = args.speed;
        window.fixturePreviewChannel = args.modelChannel ?? null;
        window.fixturePreviewTransport = window.fixtureState.supportsWebsockets;
        const lag = window.fixturePreviewDelay || (args.model === 'slow-model' ? 180 : 0);
        await new Promise(resolve => setTimeout(resolve, lag));
        if (!args.baseUrl.startsWith('https://')) throw '请输入有效的 HTTPS API 地址。';
        const tier = configuredTier(args);
        const speedPreview = tier == null ? '' : String.fromCharCode(10) + 'service_tier = "' + tier + '"';
        return 'model_provider = "' + (configurationChannel(args) === 'official' ? 'openai' : 'custom') + '"\\nmodel = "' + args.model + '"\\nrequires_openai_auth = ' + args.keepOfficialLogin + '\\nexperimental_bearer_token = "（已隐藏）"' + speedPreview + (window.fixturePreviewExtra || '');
      }
      if (cmd === 'configure') {
        window.fixtureConfigureSpeed = args.speed;
        window.fixtureConfigureChannel = args.modelChannel ?? null;
        if (window.fixtureConfigureError) throw window.fixtureConfigureError;
        await new Promise(resolve => setTimeout(resolve, window.fixtureConfigureDelay || 80));
        if (args.connection.apiKey === 'invalid') throw '请提供有效的 API 密钥';
        Object.assign(window.fixtureState, { apiKey: args.connection.apiKey, hasKey: true, modelChannel: configurationChannel(args), baseUrl: args.connection.baseUrl, model: args.connection.model, serviceTier: configuredTier(args), keepOfficialLogin: args.keepOfficialLogin });
        window.fixtureBackups.push({ id: 'fixture-id', file: window.fixtureState.file, created: '2026-09-08T06:00:00.000Z', kind: 'configure', existed: false });
        return { backupId: 'fixture-id' };
      }
      if (cmd === 'switch_speed') {
        await new Promise(resolve => setTimeout(resolve, window.fixtureSpeedDelay || 0));
        if (window.fixtureSpeedError) throw window.fixtureSpeedError;
        window.fixtureState.serviceTier = configuredTier(args);
        window.fixtureSpeedSwitch = args.speed;
        return { changed: true };
      }
      if (cmd === 'switch_transport') {
        await new Promise(resolve => setTimeout(resolve, window.fixtureTransportDelay || 0));
        if (window.fixtureTransportError) throw window.fixtureTransportError;
        window.fixtureState.supportsWebsockets = args.supportsWebsockets;
        return { changed: true };
      }
      if (cmd === 'switch_channel') {
        await new Promise(resolve => setTimeout(resolve, window.fixtureChannelDelay || 0));
        if (window.fixtureChannelError) throw window.fixtureChannelError;
        if (args.channel === 'api' && !window.fixtureState.hasKey) throw '请先完成 API 密钥配置。';
        window.fixtureState.modelChannel = args.channel;
        return { changed: true };
      }
      if (cmd === 'incoming') { if (!window.fixtureIncoming) return null; window.fixtureIncoming = false; window.fixtureState.hasKey = true; window.fixtureState.modelChannel = 'api'; return {}; }
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
  if (options.noInstallations) await page.getByRole('button', { name: '微软商店下载', exact: true }).waitFor();
  else if (options.initialError) await page.waitForFunction(() => document.getElementById('configure')?.getAttribute('aria-busy') === 'false' && document.getElementById('status').textContent.includes('TOML'));
  else await page.waitForFunction(() => document.getElementById('key')?.disabled === false && document.getElementById('preview-code')?.textContent);
  } catch (error) { await browser.close(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { page, context, errors, close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}
test('React: speed switches immediately and remains saved through tabs and configure', async () => {
  const f = await fixture(); const { page } = f;
  try {
    assert.equal(await page.locator('#speed').isVisible(), true);
    assert.equal(await page.locator('#settings').getAttribute('data-expanded'), 'false');
    assert.equal(await page.locator('#speed').evaluate(el => el.closest('.action-options').querySelector('.transport-option').nextElementSibling.contains(el)), true);
    assert.equal(await page.locator('#speed').getAttribute('data-channel'), 'standard');
    assert.deepEqual(await page.locator('#speed .channel-segment span').allTextContents(), ['标准', 'Fast']);
    assert.deepEqual(await page.locator('#speed').evaluate(el => { return [el.getBoundingClientRect().height, getComputedStyle(el).borderRadius]; }), await page.locator('#transport-protocol').evaluate(el => [el.getBoundingClientRect().height, getComputedStyle(el).borderRadius]));
    await page.locator('#speed .channel-segment:has(input[value=fast]) span').click();
    await page.waitForFunction(() => window.fixturePreviewSpeed === 'fast' && document.getElementById('preview-code').textContent.includes('service_tier = "fast"'));
    assert.equal(await page.evaluate(() => window.fixtureState.serviceTier), 'fast');
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    assert.equal(await page.evaluate(() => window.fixtureConfigureSpeed), undefined);
    await page.locator('#speed').scrollIntoViewIfNeeded();
    await page.mouse.move(10, 10);
    await page.locator('#speed').hover();
    assert.equal(await page.locator('#speed-tooltip').textContent(), '速度');
    await page.locator('#claude-tab').click();
    assert.equal(await page.locator('#speed').count(), 0);
    await page.locator('#codex-tab').click();
    await page.waitForFunction(() => document.getElementById('speed')?.dataset.channel === 'fast');
    for (const scheme of ['dark', 'light']) {
      await chooseTheme(page, scheme === 'dark' ? '石墨灰' : '雾白');
      for (const width of [600, 460]) {
        await page.setViewportSize({ width, height: 460 });
        await page.locator('#speed').scrollIntoViewIfNeeded();
        await page.waitForTimeout(180);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        const rect = await page.locator('#speed').boundingBox();
        assert.ok(rect.x >= 0 && rect.x + rect.width <= width);
        assert.equal(await page.locator('#apply').isVisible(), true);
        await page.screenshot({ path: path.join(output, `speed-${scheme}-${width}.png`) });
      }
    }
    for (const [speed, tier] of [['fast', 'fast'], ['standard', 'default']]) {
      await page.locator('#speed .channel-segment:has(input[value=' + speed + ']) span').click();
      await page.waitForFunction(speed => window.fixturePreviewSpeed === speed && document.getElementById('configure').getAttribute('aria-busy') === 'false', speed);
      await page.locator('#apply').click();
      await page.locator('#success-title').waitFor();
      assert.equal(await page.evaluate(() => window.fixtureConfigureSpeed), speed);
      assert.equal(await page.evaluate(() => window.fixtureState.serviceTier), tier);
      await page.locator('#done').click();
      assert.equal(await page.locator('#speed').getAttribute('data-channel'), speed);
    }
    assert.equal(await page.evaluate(() => window.fixtureClaudeCalls.some(({args}) => Object.hasOwn(args, 'speed'))), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('React: speed failures retain selection and unsaved edits while pending changes block writes', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#key').fill('sk-speed-unsaved-fixture');
    await page.evaluate(() => { window.fixtureSpeedDelay = 200; window.fixtureSpeedError = '速度保存失败'; });
    await page.locator('#speed .channel-segment:has(input[value=fast]) span').click();
    await page.waitForFunction(() => document.getElementById('speed').getAttribute('aria-busy') === 'true');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('速度保存失败'));
    assert.equal(await page.locator('#speed').getAttribute('data-channel'), 'standard');
    assert.equal(await page.locator('#key').inputValue(), 'sk-speed-unsaved-fixture');
    await page.evaluate(() => { window.fixtureSpeedError = ''; });
    await page.locator('#speed .channel-segment:has(input[value=fast]) span').click();
    await page.waitForFunction(() => document.getElementById('speed').dataset.channel === 'fast' && !document.getElementById('apply').disabled);
    assert.equal(await page.locator('#key').inputValue(), 'sk-speed-unsaved-fixture');
    assert.equal(await page.evaluate(() => window.fixtureState.apiKey), 'sk-saved-fixture-not-real-key');
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    await page.locator('#speed input[value=fast]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.getElementById('speed').dataset.channel === 'standard');
    assert.equal(await page.evaluate(() => window.fixtureState.serviceTier), 'default');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('React: speed reads legacy Fast and preserves an unrecognized current tier', async () => {
  for (const [tier, selection] of [['priority', 'fast'], ['ultrafast', null]]) {
    const f = await fixture({ serviceTier: tier }); const { page } = f;
    try {
      assert.equal(await page.locator('#speed').getAttribute('data-channel'), selection);
      if (!selection) {
        assert.equal(await page.locator('#speed input:checked').count(), 0);
        await page.locator('#speed').scrollIntoViewIfNeeded();
        await page.mouse.move(10, 10);
        await page.locator('#speed').hover();
        assert.equal(await page.locator('#speed-tooltip').textContent(), '速度');
        await page.locator('#apply').click();
        await page.locator('#success-title').waitFor();
        assert.equal(await page.evaluate(() => window.fixtureState.serviceTier), 'ultrafast');
      }
    } finally { await f.close(); }
  }
});
test('React: first API setup and existing official setup share preview and save decisions', async () => {
  for (const configured of [false, true]) {
    const f = await fixture({ savedKey: configured ? 'sk-saved-fixture-not-real-key' : '', modelChannel: 'official', keepOfficialLogin: true });
    const { page } = f;
    try {
      if (!configured) await page.locator('#key').fill('sk-first-setup-fixture');
      const provider = configured ? 'openai' : 'custom';
      await page.waitForFunction(provider => document.getElementById('preview-code').textContent.includes('model_provider = "' + provider + '"'), provider);
      assert.equal(await page.evaluate(() => window.fixturePreviewChannel), null);
      await page.locator('#apply').click();
      await page.getByRole('heading', { name: '配置完成' }).waitFor();
      assert.equal(await page.evaluate(() => window.fixtureConfigureChannel), null);
      assert.equal(await page.evaluate(() => window.fixtureState.modelChannel), configured ? 'official' : 'api');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('React: explicit official choice survives tab changes and one-click configuration', async () => {
  for (const savedKey of ['', 'sk-saved-fixture-not-real-key']) {
    const f = await fixture({ savedKey, keepOfficialLogin: true }); const { page } = f;
    try {
      await page.locator('#key').fill('sk-edited-setup-fixture');
      await page.getByRole('radio', { name: '官方', exact: true }).click();
      await page.waitForFunction(() => window.fixturePreviewChannel === 'official' && !document.querySelector('#apply').disabled);
      await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
      await page.getByRole('tab', { name: 'ChatGPT', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#apply').disabled);
      await page.locator('#apply').click();
      await page.getByRole('heading', { name: '配置完成' }).waitFor();
      assert.equal(await page.evaluate(() => window.fixtureConfigureChannel), 'official');
      assert.equal(await page.evaluate(() => window.fixtureState.modelChannel), 'official');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('React: website setup activates API and clears an earlier explicit official choice', async () => {
  const f = await fixture({ keepOfficialLogin: true }); const { page } = f;
  try {
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    await page.waitForFunction(() => window.fixturePreviewChannel === 'official' && !document.querySelector('#apply').disabled);
    await page.evaluate(async () => {
      window.fixtureIncoming = true;
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'incoming-changed', payload: null });
    });
    await page.getByRole('heading', { name: '配置完成' }).waitFor();
    await page.locator('#done').click();
    assert.equal(await page.getByRole('radio', { name: 'API', exact: true }).isChecked(), true);
    await page.locator('#apply').click();
    await page.getByRole('heading', { name: '配置完成' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureConfigureChannel), null);
    assert.equal(await page.evaluate(() => window.fixtureState.modelChannel), 'api');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: missing official login requires confirmation and cancel keeps the preference off', async () => {
  const f = await fixture({ officialLogin: false }); const { page } = f;
  try {
    const checkbox = page.locator('#keep-official-login');
    const dialog = page.getByRole('dialog', { name: '开启保留官方登录' });
    const saved = await page.evaluate(() => JSON.stringify(window.fixtureState));
    assert.equal(await checkbox.isChecked(), false);
    for (const [theme, width] of [['雾白', 600], ['石墨灰', 460]]) {
      await chooseTheme(page, theme);
      await page.setViewportSize({ width, height: 460 });
      await checkbox.click();
      await dialog.waitFor();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await page.getByRole('radio', { name: '官方', exact: true }).isDisabled(), false);
      assert.equal(await dialog.getAttribute('class'), 'modal modal--default');
      assert.ok((await dialog.textContent()).includes('当前未检测到官方账号'));
      const box = await dialog.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 460);
      await page.screenshot({ path: path.join(output, `official-login-confirm-${width}.png`) });
      await dialog.getByRole('button', { name: '保持关闭', exact: true }).click();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await checkbox.evaluate(el => document.activeElement === el), true);
    }
    for (const dismiss of ['Escape', 'close']) {
      await checkbox.click();
      await dialog.waitFor();
      if (dismiss === 'Escape') await page.keyboard.press('Escape');
      else await dialog.getByRole('button', { name: '关闭开启保留官方登录', exact: true }).click();
      assert.equal(await checkbox.isChecked(), false);
      assert.equal(await dialog.isVisible(), false);
    }
    await checkbox.click();
    await dialog.getByRole('button', { name: '仍要开启', exact: true }).click();
    assert.equal(await checkbox.isChecked(), true);
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('requires_openai_auth = true'));
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixtureState)), saved);
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(cmd => ['configure', 'switch_channel'].includes(cmd))), false);
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    // Turning off needs no check; every new enable checks the file again.
    await checkbox.uncheck();
    await page.evaluate(() => { window.fixtureOfficialLogin = true; });
    await checkbox.click();
    await page.waitForFunction(() => document.getElementById('keep-official-login').checked);
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(cmd => cmd === 'has_official_login').length), 6);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: official login check waits before enabling and failures keep it off', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const checkbox = page.locator('#keep-official-login');
    await page.evaluate(() => { window.fixtureOfficialLoginDelay = 500; });
    await checkbox.click();
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await checkbox.isDisabled(), true);
    await page.waitForFunction(() => document.getElementById('keep-official-login').checked && !document.getElementById('keep-official-login').disabled);
    assert.equal(await page.locator('#official-login-confirm').isVisible(), false);
    await checkbox.uncheck();
    await page.evaluate(() => { window.fixtureOfficialLoginDelay = 0; window.fixtureOfficialLoginError = true; });
    await checkbox.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('无法检测官方登录状态'));
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await page.locator('#official-login-confirm').isVisible(), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: transport switches immediately without backups and preserves drafts on failure', async () => {
  const { page, errors, close } = await fixture();
  try {
    const http = page.getByRole('radio', { name: 'HTTP', exact: true });
    const ws = page.getByRole('radio', { name: 'WS', exact: true });
    assert.equal(await page.locator('#keep-official-login').isChecked(), false);
    assert.equal(await http.isChecked(), true);
    await page.locator('#key').fill('sk-unsaved-fixture-draft');
    await page.evaluate(() => { window.fixtureTransportDelay = 200; });
    await ws.click();
    await page.waitForFunction(() => document.getElementById('transport-protocol').getAttribute('aria-busy') === 'true');
    assert.equal(await http.isDisabled(), true);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('切换成功，新对话生效') && !document.getElementById('key').disabled && window.fixturePreviewTransport === true);
    assert.equal(await ws.isChecked(), true);
    assert.equal(await page.locator('#key').inputValue(), 'sk-unsaved-fixture-draft');
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('configure')), false);
    await page.evaluate(() => { window.fixtureTransportError = '模拟协议写入失败'; });
    await http.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('模拟协议写入失败') && !document.getElementById('key').disabled);
    assert.equal(await ws.isChecked(), true);
    assert.equal(await page.locator('#key').inputValue(), 'sk-unsaved-fixture-draft');
    await page.evaluate(() => { window.fixtureTransportError = null; });
    await http.click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('切换成功，新对话生效') && !document.getElementById('key').disabled && window.fixturePreviewTransport === false);
    assert.equal(await http.isChecked(), true);
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 520 });
      await page.locator('#transport-protocol').scrollIntoViewIfNeeded();
      const layout = await page.locator('.action-row').evaluate(row => {
        const a = row.querySelector('.action-options').getBoundingClientRect();
        const b = row.querySelector('#apply').getBoundingClientRect();
        const protocol = row.querySelector('#transport-protocol').getBoundingClientRect();
        return { noOverlap: a.right <= b.left || a.top >= b.bottom || a.bottom <= b.top, inWindow: protocol.left >= 0 && protocol.right <= innerWidth };
      });
      assert.deepEqual(layout, { noOverlap: true, inWindow: true });
      // Let resize/scroll handlers settle before entering the tooltip target.
      await page.mouse.move(0, 0);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('#transport-protocol').hover();
      assert.equal(await page.getByRole('tooltip').textContent(), '传输协议');
      await page.screenshot({ path: path.join(output, 'transport-' + width + '.png') });
      await page.mouse.move(10, 100);
      assert.equal(await page.getByRole('tooltip').isVisible(), false);
    }
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

async function chooseTheme(page, label) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('radio', { name: label, exact: true }).check();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
}
async function openHistory(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '历史备份', exact: true }).click();
}
async function openUpdater(page) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
}

async function chooseSetting(page, selector, value) {
  await page.locator(selector === '#model' ? '#model-toggle' : selector).click();
  await page.getByTestId(`select-option-${value}`).click();
}

async function waitForSettingOption(page, selector, value) {
  await page.locator(selector === '#model' ? '#model-toggle' : selector).click();
  await page.getByTestId(`select-option-${value}`).waitFor();
  await (selector === '#model' ? page.locator('#model') : page.getByRole('listbox')).press('Escape');
}

test('React: custom selects support keyboard choice and Escape inside the version dialog', async () => {
  const f = await fixture({ longVersions: true }); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    await waitForSettingOption(page, '#model', 'new-model');
    await page.locator('#model-toggle').click();
    assert.equal(await page.getByTestId('select-option-gpt-6-astra').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('.model-control').evaluate(element => {
      const chevron = element.querySelector('svg').getBoundingClientRect();
      return element.getBoundingClientRect().right - chevron.right <= 12;
    }), true);
    await page.locator('#model').press('ArrowDown');
    await page.locator('#model').press('ArrowDown');
    await page.locator('#model').press('Enter');
    assert.equal(await page.locator('#model').getAttribute('data-value'), 'new-model');
    await page.locator('#model-toggle').click();
    await page.screenshot({ path: path.join(output, 'model-dropdown.png') });
    await page.locator('#model').press('Escape');
    assert.equal(await page.getByRole('listbox').count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'model');
    const selected = '桌面版 26.1007.21159 · 内核 0.162.0-alpha.17.2';
    assert.equal(await page.locator('#version-info').textContent(), selected);
    assert.equal(await page.locator('.selected-version').count(), 0);
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 460 });
      await page.locator('#version-info').scrollIntoViewIfNeeded();
      const row = await page.locator('.version-row').evaluate(element => {
        const label = element.querySelector('#version-info');
        const button = element.querySelector('#change-version');
        const rect = node => node.getBoundingClientRect();
        return { height: rect(element).height, labelHeight: rect(label).height, buttonHeight: rect(button).height,
          labelRight: rect(label).right, buttonLeft: rect(button).left, buttonRight: rect(button).right,
          rowRight: rect(element).right, labelFits: label.scrollWidth <= label.clientWidth };
      });
      assert.equal(row.height, Math.max(row.labelHeight, row.buttonHeight));
      assert.ok(row.labelRight <= row.buttonLeft && row.buttonRight <= row.rowRight);
      if (width === 600) assert.equal(row.labelFits, true);
    }
    await page.locator('#change-version').click();
    await page.locator('#installation').click();
    assert.equal(await page.getByRole('listbox').evaluate(element => element.closest('dialog')?.id), 'version-choice');
    assert.equal(await page.getByRole('listbox').evaluate(element => {
      const menu = element.getBoundingClientRect();
      const last = element.lastElementChild.getBoundingClientRect();
      return menu.bottom <= innerHeight - 8 && last.bottom <= menu.bottom;
    }), true);
    await page.screenshot({ path: path.join(output, 'version-dropdown.png') });
    await page.getByRole('listbox').press('Escape');
    assert.equal(await page.getByRole('listbox').count(), 0);
    assert.equal(await page.locator('#version-choice[open]').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'installation');
    await page.locator('#installation').press('Escape');
    assert.equal(await page.locator('#version-choice[open]').count(), 0);
    assert.equal(await page.locator('#version-info').textContent(), selected);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('configure')), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: startup and model refresh never write configuration', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const before = await page.evaluate(() => JSON.stringify(window.fixtureState));
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('refresh_catalog')), false);
    await page.locator('.settings-toggle').click();
    await waitForSettingOption(page, '#model', 'new-model');
    const count = await page.evaluate(() => window.fixtureCalls.filter(v => v === 'models').length);
    await page.locator('#refresh-models').click();
    await page.waitForFunction(count => window.fixtureCalls.filter(v => v === 'models').length > count, count);
    await chooseSetting(page, '#model', 'new-model');
    await page.waitForFunction(() => !document.querySelector('#apply').disabled);
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixtureState)), before);
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    assert.equal(await page.evaluate(() => window.fixtureCalls.some(v => ['refresh_catalog', 'configure', 'restore', 'switch_channel'].includes(v))), false);
    await page.locator('#apply').click();
    await page.waitForFunction(() => window.fixtureState.model === 'new-model');
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 1);
  } finally { await f.close(); }
});

test('React: model refresh errors preserve the saved configuration', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const before = await page.evaluate(() => JSON.stringify(window.fixtureState));
    await page.locator('.settings-toggle').click();
    await waitForSettingOption(page, '#model', 'new-model');
    await page.evaluate(() => { window.fixtureModelsError = '无法获取模型，请检查权限。'; });
    await page.locator('#refresh-models').click();
    await page.waitForFunction(() => document.querySelector('#models-help').textContent.includes('无法获取模型'));
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixtureState)), before);
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
  } finally { await f.close(); }
});

for (const scenario of [
  { name: 'unauthorized', modelsError: '无法获取模型，请检查密钥及访问权限。' },
  { name: 'offline', modelsError: '模型列表获取失败，请稍后重试。' },
  { name: 'empty', models: [] },
  { name: 'loading', modelsDelay: 30_000 },
]) {
  test(`React: editable model configures successfully with ${scenario.name} discovery`, async () => {
    const f = await fixture(scenario); const { page } = f;
    page.setDefaultTimeout(8000);
    try {
      await page.locator('#toggle-settings').click();
      if (scenario.name === 'loading') await page.waitForFunction(() => window.fixtureCalls.includes('models'));
      else await page.waitForFunction(() => document.getElementById('models-help').textContent.includes('不影响一键配置'));
      assert.equal(await page.locator('#key').getAttribute('aria-invalid'), 'false');
      await page.locator('#model').fill('my-custom-model');
      await page.locator('#model').press('Tab');
      assert.equal(await page.locator('#model').inputValue(), 'my-custom-model');
      await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('my-custom-model') && !document.getElementById('apply').disabled);
      await page.locator('#model').fill('');
      assert.equal(await page.locator('#apply').isDisabled(), true);
      await page.locator('#model').fill('my-custom-model');
      await page.waitForFunction(() => !document.getElementById('apply').disabled);
      await page.locator('#apply').click();
      await page.getByRole('heading', { name: '配置完成' }).waitFor();
      assert.equal(await page.evaluate(() => window.fixtureState.model), 'my-custom-model');
      assert.equal(await page.evaluate(() => window.fixtureBackups.length), 1);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

test('React: optional desktop notice closes without moving the form and yields to errors', async () => {
  const f = await fixture({ cliOnly: true }); const { page } = f;
  const geometry = () => page.locator('#configure, #key, #apply').evaluateAll(elements => elements.map(el => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));
  try {
    for (const scheme of ['dark', 'light']) {
      await chooseTheme(page, scheme === 'dark' ? '石墨灰' : '雾白');
      for (const width of [600, 460]) {
        await page.setViewportSize({ width, height: 460 });
        assert.ok((await page.locator('#status').textContent()).includes('Codex CLI 可正常配置'));
        const row = await page.locator('#status > span').evaluate(el => {
          const text = el.firstElementChild.getBoundingClientRect();
          const link = el.querySelector('button').getBoundingClientRect();
          return { textTop: text.top, linkTop: link.top };
        });
        assert.ok(Math.abs(row.textTop - row.linkTop) < 3, JSON.stringify(row));
        await page.screenshot({ path: path.join(output, `install-notice-${scheme}-${width}.png`) });
      }
    }
    await page.locator('#keep-official-login').check();
    await page.evaluate(() => { window.fixtureChannelError = '模拟通道切换失败'; });
    const before = await geometry();
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('模拟通道切换失败'));
    assert.equal(await page.locator('#status').getAttribute('role'), 'alert');
    assert.equal(await page.locator('#status').getByRole('button', { name: '下载桌面版' }).count(), 0);
    assert.deepEqual(await geometry(), before);
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    assert.ok((await page.locator('#status').textContent()).includes('Codex CLI 可正常配置'));
    assert.deepEqual(await geometry(), before);
    await page.getByRole('button', { name: '关闭提示', exact: true }).click();
    assert.equal(await page.locator('.status-region').isVisible(), false);
    assert.deepEqual(await geometry(), before);
    assert.equal(await page.locator('#apply').isEnabled(), true);
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('key').disabled);
    assert.equal(await page.locator('.status-region').isVisible(), false);
    await page.locator('#toggle-settings').click();
    assert.equal(await page.getByRole('button', { name: '下载桌面版', exact: true }).isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

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
      await chooseTheme(page, scheme === 'dark' ? '石墨灰' : '雾白');
      await page.waitForTimeout(160); // Finish theme color transitions before visual capture.
      for (const width of [600, 460]) {
        await page.setViewportSize({ width, height: 460 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true);
        const cardSpacing = await page.locator('.config-card').evaluate(el => {
          const card = el.closest("section").getBoundingClientRect();
          return { top: card.top, bottom: innerHeight - card.bottom, headerBottom: document.querySelector('.app-header').getBoundingClientRect().bottom };
        });
        // The complete panel includes the quota card; it stays below the header.
        assert.equal(await page.locator(".quota-panel").evaluate(el => el.scrollHeight <= el.clientHeight), true);
        assert.ok(cardSpacing.top >= cardSpacing.headerBottom + 16, JSON.stringify(cardSpacing));
        await page.screenshot({ path: path.join(output, `${scheme}-${width}.png`) });
      }
    }
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await chooseTheme(page, '跟随系统');
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
    await waitForSettingOption(page, '#model', 'slow-model');
    await chooseSetting(page, '#model', 'slow-model');
    await chooseSetting(page, '#model', 'new-model');
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
    await openHistory(page); await page.getByRole('button', { name: '查看', exact: true }).click();
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
    assert.equal(await page.locator('#installation').getAttribute('data-value'), 'desktop');
    await page.locator('#installation').click();
    assert.equal(await page.getByTestId('select-option-auto').count(), 0);
    assert.match(await page.getByTestId('select-option-desktop').textContent(), /桌面版 26.901.51231 · 内核 0.154.0/);
    await page.getByTestId('select-option-manual').click();
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
    await waitForSettingOption(page, '#model', 'new-model');
    assert.equal(await page.locator('#version-info').textContent(), '桌面版 26.901.51231 · 内核 0.154.0');
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
    await openHistory(page);
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
      assert.ok(dimensions.footerBottom <= dimensions.dialogBottom && dimensions.dialogBottom <= dimensions.viewport, JSON.stringify(dimensions));
      assert.equal(await page.locator('.modal-close:focus-visible').count(), 0);
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
    await waitForSettingOption(page, '#model', 'new-model');
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
      // Start a new wheel gesture after moving the scroll position directly.
      await page.waitForTimeout(400);
      await page.mouse.wheel(0, 100);
      // A fractional bottom pixel may consume the first gesture in Chromium.
      await page.waitForTimeout(400);
      await page.mouse.wheel(0, 100);
      await page.waitForFunction(y => document.querySelector('.content-scroll').scrollTop > y, bottom.outer);
      const top = await position('top');
      await page.locator('#preview-code').hover();
      await page.waitForTimeout(400);
      await page.mouse.wheel(0, -100);
      await page.waitForFunction(y => document.querySelector('.content-scroll').scrollTop < y, top.outer);
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal(await page.locator('.app-header').evaluate(el => el.getBoundingClientRect().top), 0);
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
    await page.locator('#settings').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    await page.locator('#change-version').click();
    await page.evaluate(() => { window.fixtureVersionDelay = 180; });
    const layout = () => page.evaluate(() => ({
      scroll: document.querySelector('.content-scroll').scrollTop,
      height: document.querySelector('main').getBoundingClientRect().height,
      settingsTop: document.getElementById('settings').getBoundingClientRect().top,
      preview: document.getElementById('preview-code').textContent,
      selection: document.querySelector('#version-info')?.textContent || '',
    }));
    const before = await layout();
    for (const selection of ['cli', 'desktop']) {
      await chooseSetting(page, '#installation', selection);
      await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('正在匹配'));
      assert.deepEqual(await layout(), before);
      await page.waitForFunction(() => document.getElementById('version-status').textContent.includes('已匹配'));
      assert.deepEqual(await layout(), before);
    }
    await page.getByRole('button', { name: '关闭版本选择' }).click();
    await page.waitForFunction(() => document.querySelector('#version-info')?.textContent.includes('桌面版'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: reserved feedback slots keep fields and dialogs stable when errors appear and clear', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    await waitForSettingOption(page, '#model', 'new-model');
    const layout = () => page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, height: r.height }; };
      return ['.config-card', '#key', '#model', '#base-url', '#target'].map(rect);
    });
    for (const width of [600, 460]) {
      await page.setViewportSize({ width, height: 560 });
      const before = await layout();
      await page.evaluate(() => { window.fixtureModelsError = '无法获取模型，请检查密钥及访问权限。'; document.getElementById('refresh-models').click(); });
      await page.waitForFunction(() => document.getElementById('models-help').textContent.includes('无法获取模型'));
      assert.deepEqual(await layout(), before);
      await page.evaluate(() => { window.fixtureModelsError = ''; document.getElementById('refresh-models').click(); });
      await page.waitForFunction(() => !document.getElementById('models-help').textContent && !document.getElementById('refresh-models').disabled);
      assert.deepEqual(await layout(), before);
    }
    await page.locator('#toggle-settings').click();
    await page.locator('#key').fill('invalid');
    await page.locator('#settings').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
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
    assert.equal(await page.locator('.status-region').evaluate(el => getComputedStyle(el).position), 'fixed');
    await page.evaluate(() => {
      window.fixtureBackups = [{ id: 'stable', file: '/isolated/config/config.toml', created: '2026-09-08T06:00:00Z', kind: 'configure', existed: true, baseUrl: 'https://example.com/v1', keepOfficialLogin: false, content: 'model = "gpt-6-astra"\n'.repeat(40) }];
      window.fixtureDialogError = '配置已改变，请刷新后重试。';
    });
    await openHistory(page);
    await page.getByRole('button', { name: '查看', exact: true }).click();
    const dialogLayout = () => page.evaluate(() => ['#backup-preview', '#backup-preview-code', '.backup-preview-footer'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, height: r.height }; }));
    const beforeDialogError = await dialogLayout();
    await page.getByRole('button', { name: '还原此配置' }).click();
    await page.waitForFunction(() => document.getElementById('backup-preview-status').textContent.includes('刷新'));
    assert.deepEqual(await dialogLayout(), beforeDialogError);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('updater: inline errors never install unverified downloads', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await openUpdater(page);
    const row = page.getByRole('button', { name: '检查更新', exact: true });
    await row.click();
    await page.getByText('已是最新版本', { exact: true }).waitFor();
    await page.evaluate(() => window.fixtureUpdateCheckError = true);
    await row.click();
    await page.getByText('检查失败，点击重试').waitFor();
    await page.evaluate(() => { window.fixtureUpdateCheckError = false; window.fixtureUpdate = true; window.fixtureUpdateDownloadError = true; });
    await row.click();
    await page.getByText('下载或校验失败，点击重试').waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('plugin:updater|install')), false);
    assert.equal(await page.locator('#software-update').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('updater: inline download persists after closing settings; install and restart retries preserve verified package', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.evaluate(() => { window.fixtureUpdate = true; window.fixtureUpdateDelay = 500; window.fixtureUpdateInstallError = true; });
    await openUpdater(page);
    const row = page.getByRole('button', { name: '检查更新', exact: true });
    await row.click();
    await page.getByRole('progressbar', { name: '更新进度' }).waitFor();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await openUpdater(page);
    await page.getByText('安装失败，点击重试').waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('plugin:process|restart')), false);
    await page.evaluate(() => { window.fixtureUpdateInstallError = false; window.fixtureUpdateRestartError = true; });
    await row.click();
    await page.getByText('重启失败，点击重试').waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(c => c === 'plugin:updater|download').length), 1);
    await row.click();
    await page.getByText('重启失败，点击重试').waitFor();
    const installs = await page.evaluate(() => window.fixtureCalls.filter(c => c === 'plugin:updater|install').length);
    await row.click();
    await page.waitForFunction(() => !document.querySelector('.settings-update-row').disabled);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(c => c === 'plugin:updater|install').length), installs);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('updater: background discovery only shows dots until user clicks', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.evaluate(() => window.fixtureUpdate = true);
    await page.waitForFunction(() => !!document.querySelector('.software-update-dot'), { timeout: 10000 });
    const calls = await page.evaluate(() => window.fixtureCalls);
    assert.ok(!calls.includes('plugin:updater|download'));
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
      await chooseTheme(page, theme);
      await page.waitForTimeout(160);
      await page.evaluate(() => { window.fixtureChannelDelay = 400; window.fixturePreviewDelay = 200; });
      const appearance = () => page.evaluate(() => ['.config-card', '#key', '.login-option', '#apply'].map(selector => {
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

test('React: providers switch independently of login preference and preserve its pixels during writes', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const checkbox = page.locator('#keep-official-login');
    for (const theme of ['雾白', '石墨灰']) {
      await chooseTheme(page, theme);
      await checkbox.uncheck();
      const providers = page.getByRole('radiogroup', { name: '提供商' });
      assert.equal(await providers.getAttribute('title'), null);
      assert.equal(await providers.getAttribute('aria-disabled'), 'false');
      assert.equal(await providers.getByRole('radio', { name: 'API', exact: true }).isDisabled(), false);
      assert.equal(await providers.getByRole('radio', { name: '官方', exact: true }).isDisabled(), false);
      await providers.hover();
      const tooltip = page.getByRole('tooltip');
      assert.equal(await tooltip.isVisible(), true);
      assert.equal(await tooltip.textContent(), '提供商');
      await tooltip.hover();
      assert.equal(await tooltip.isVisible(), true);
      await page.screenshot({ path: path.join(output, `provider-tooltip-${theme === '雾白' ? 'light' : 'dark'}.png`) });
      await page.keyboard.press('Escape');
      // Keyboard dismissal works with focus on the provider group.
      await providers.focus();
      assert.equal(await tooltip.isVisible(), true);
      await page.keyboard.press('Escape');
      assert.equal(await tooltip.isVisible(), false);
      assert.equal(await providers.getByRole('radio', { name: 'API', exact: true }).isChecked(), true);
      for (const checked of [false, true]) {
        await checkbox.setChecked(checked);
        assert.equal(await providers.getAttribute('aria-disabled'), 'false');
        assert.equal(await providers.getByRole('radio', { name: '官方', exact: true }).isDisabled(), false);
        await providers.hover();
        assert.equal(await page.locator('#provider-tooltip').textContent(), '提供商');
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
        assert.equal(await providers.getByRole('radio', { name: '官方', exact: true }).isChecked(), true);
        assert.equal(await page.locator('#status').textContent(), '切换成功，新对话生效');
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

test('React: missing official login confirms channel switching without changing login preference', async () => {
  const f = await fixture({ officialLogin: false }); const { page } = f;
  try {
    const official = page.getByRole('radio', { name: '官方', exact: true });
    const api = page.getByRole('radio', { name: 'API', exact: true });
    const checkbox = page.locator('#keep-official-login');
    const dialog = page.locator('#official-channel-confirm');
    await official.click();
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /未检测到官方账号/);
    assert.equal(await page.locator('#official-login-confirm[open]').count(), 0);
    assert.equal(await api.isChecked(), true);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('switch_channel')), false);
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await api.isChecked(), true);
    await official.click();
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('switch_channel')), false);
    await official.click();
    await dialog.waitFor();
    await dialog.getByRole('button', { name: '仍要切换', exact: true }).click();
    await page.waitForFunction(() => window.fixtureState.modelChannel === 'official' && !document.querySelector('main').dataset.channelUpdating);
    assert.equal(await official.isChecked(), true);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await page.locator('#status').textContent(), '切换成功，新对话生效');
    await api.click();
    await page.waitForFunction(() => window.fixtureState.modelChannel === 'api' && !document.querySelector('main').dataset.channelUpdating);
    assert.equal(await checkbox.isChecked(), false);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(command => command === 'has_official_login').length), 3);
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('configure')), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: official login detection waits and failures preserve the current channel', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.evaluate(() => { window.fixtureOfficialLoginDelay = 400; });
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('switch_channel')), false);
    assert.equal(await page.getByRole('radio', { name: 'API', exact: true }).isDisabled(), true);
    await page.waitForFunction(() => window.fixtureState.modelChannel === 'official' && !document.querySelector('main').dataset.channelUpdating);
    await page.getByRole('radio', { name: 'API', exact: true }).click();
    await page.waitForFunction(() => window.fixtureState.modelChannel === 'api' && !document.querySelector('main').dataset.channelUpdating);
    await page.evaluate(() => { window.fixtureOfficialLoginDelay = 0; window.fixtureOfficialLoginError = true; });
    const writes = await page.evaluate(() => window.fixtureCalls.filter(command => command === 'switch_channel').length);
    await page.getByRole('radio', { name: '官方', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '无法检测官方登录状态' }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'API', exact: true }).isChecked(), true);
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(command => command === 'switch_channel').length), writes);
    assert.equal(await page.locator('#keep-official-login').isChecked(), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('React: provider tooltip leaves no painted shadow after pointer exit', async () => {
  const f = await fixture(); const { page } = f;
  try {
    for (const theme of ['雾白', '石墨灰']) {
      await chooseTheme(page, theme);
      for (const width of [600, 460]) {
        await page.setViewportSize({ width, height: 460 });
        await page.mouse.move(10, 10);
        await page.waitForTimeout(160);
        const clip = await page.locator('#model-channel').evaluate(el => {
          const r = el.getBoundingClientRect();
          const x = Math.max(0, Math.floor(r.left) - 100), y = Math.ceil(r.bottom) + 6;
          return { x, y, width: Math.min(300, innerWidth - x), height: Math.min(80, innerHeight - y) };
        });
        const before = await page.screenshot({ clip, animations: 'disabled' });
        for (let i = 0; i < 3; i++) {
          await page.locator('#model-channel').hover();
          assert.equal(await page.getByRole('tooltip').isVisible(), true);
          await page.getByRole('tooltip').hover();
          await page.mouse.move(10, 10);
          assert.equal(await page.getByRole('tooltip').isVisible(), false);
          await page.waitForTimeout(160);
          assert.equal(await page.locator('#provider-tooltip').count(), 0);
          const after = await page.screenshot({ clip, animations: 'disabled' });
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
    for (const [channel, destination] of [['official', 40], ['api', 0]]) {
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
      assert.ok(positions.some(x => x > 0 && x < 40), 'selection should pass through intermediate positions');
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
      await chooseTheme(page, theme);
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


test('React: Windows diagnostics starts fresh, shows result logs and copies the same report', async () => {
  const f = await fixture({ platform: 'windows' }); const { page } = f;
  try {
    const enter = async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '问题排查', exact: true }).click();
    };
    await enter();
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('windows_diagnostics')), false);
    assert.equal(await page.getByRole('button', { name: '复制报告', exact: true }).count(), 0);
    assert.equal(await page.getByLabel('排查日志').innerText(), '等待排查');
    assert.match(await page.locator('.diagnostic-intro').innerText(), /排查后可复制报告/);
    await page.screenshot({ path: path.join(output, 'windows-diagnostics-waiting.png') });
    await page.evaluate(() => { window.fixtureDiagnosticDelay = 500; });
    const initialLayout = await page.locator('dialog[open]').boundingBox();
    await page.getByRole('button', { name: '开始排查', exact: true }).click();
    assert.equal(await page.getByLabel('排查日志').innerText(), '[RUN] 正在排查…');
    await page.getByRole('button', { name: '再次排查', exact: true }).waitFor();
    assert.match(await page.getByLabel('排查日志').innerText(), /401/);
    assert.match(await page.getByLabel('排查日志').innerText(), /model =/);
    await page.setViewportSize({ width: 600, height: 700 });
    const dialogBounds = await page.locator('dialog[open]').boundingBox();
    const logBounds = await page.getByLabel('排查日志').boundingBox();
    const actionsBounds = await page.locator('.diagnostic-actions').boundingBox();
    assert.ok(logBounds.height <= 200, 'Keep the diagnostic log compact even in a tall window.');
    assert.ok(dialogBounds.y + dialogBounds.height - actionsBounds.y - actionsBounds.height <= 24, 'No unused space below the actions.');
    await page.screenshot({ path: path.join(output, 'windows-diagnostics-filled.png') });
    await page.setViewportSize({ width: 600, height: 460 });
    assert.equal(await page.getByRole('button', { name: '备份并打开 .env', exact: true }).count(), 0);
    assert.deepEqual(await page.locator('dialog[open]').boundingBox(), initialLayout);
    await page.evaluate(() => {
      window.fixtureCopyError = true;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
        if (window.fixtureCopyError) throw new Error('clipboard unavailable');
        window.fixtureCopiedReport = text;
      } } });
    });
    await page.getByRole('button', { name: '复制报告', exact: true }).click();
    await page.getByText('复制失败，请重试。', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('dialog[open]').boundingBox(), initialLayout);
    await page.evaluate(() => { window.fixtureCopyError = false; });
    await page.getByRole('button', { name: '复制报告', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.diagnostic-feedback').textContent === '');
    assert.equal(await page.getByRole('button', { name: '复制报告', exact: true }).locator('.lucide-check').count(), 1);
    await page.getByRole('button', { name: '复制报告', exact: true }).locator('.lucide-copy').waitFor({ timeout: 4000 });
    assert.deepEqual(await page.locator('dialog[open]').boundingBox(), initialLayout);
    const report = await page.evaluate(() => window.fixtureCopiedReport);
    assert.equal(report, await page.getByLabel('排查日志').innerText());
    assert.match(report, /7890/);
    assert.match(report, /401/);
    assert.match(report, /model = "gpt-5.6-sol"/);
    assert.equal(report.includes('sk-saved'), false);
    assert.deepEqual(await page.locator('dialog[open]').boundingBox(), initialLayout);
    await page.getByRole('button', { name: '再次排查', exact: true }).click();
    await page.getByRole('button', { name: '再次排查', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureCalls.filter(c => c === 'windows_diagnostics').length), 2);
    await page.screenshot({ path: path.join(output, 'windows-diagnostics.png') });
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await enter();
    assert.equal(await page.getByRole('button', { name: '开始排查', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '复制报告', exact: true }).count(), 0);
    await page.evaluate(() => { window.fixtureDiagnosticError = true; });
    await page.getByRole('button', { name: '开始排查', exact: true }).click();
    await page.getByText('排查未完成', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('dialog[open]').boundingBox(), initialLayout);
    assert.equal(await page.getByRole('button', { name: '复制报告', exact: true }).count(), 0);
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('React: shared modal shell matches across dialogs and restores focus on Escape', async () => {
  const f = await fixture({ platform: 'windows' }); const { page } = f;
  try {
    const shell = () => page.locator('dialog[open]').evaluate(el => {
      const css = getComputedStyle(el), header = getComputedStyle(el.querySelector('.modal-header'));
      return { fontSize: css.fontSize, fontWeight: css.fontWeight, radius: css.borderRadius, border: css.border, background: css.backgroundColor, shadow: css.boxShadow, headerPadding: header.padding, titleSize: getComputedStyle(el.querySelector('h2')).fontSize };
    });
    for (const theme of ['light', 'dark']) {
      await chooseTheme(page, theme === 'dark' ? '石墨灰' : '雾白');
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const expected = await shell();
      await page.screenshot({ path: path.join(output, `modal-settings-${theme}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog[open]'));
      assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate(el => el === document.activeElement), true);
      await openUpdater(page);
      assert.deepEqual(await shell(), expected);
      await page.screenshot({ path: path.join(output, `modal-update-${theme}.png`) });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      if (!(await page.locator('#settings').isVisible())) await page.locator('#toggle-settings').click();
      await page.locator('#change-version').click();
      assert.deepEqual(await shell(), expected);
      await page.screenshot({ path: path.join(output, `modal-version-${theme}.png`) });
      await page.getByRole('button', { name: '关闭版本选择' }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '问题排查', exact: true }).click();
      assert.deepEqual(await shell(), expected);
      if (await page.getByRole('button', { name: '开始排查', exact: true }).count()) {
        await page.getByRole('button', { name: '开始排查', exact: true }).click();
      }
      await page.getByRole('button', { name: '再次排查', exact: true }).waitFor();
      await page.setViewportSize({ width: 460, height: 460 });
      const bounds = await page.locator('dialog[open]').boundingBox();
      const controlsHeight = await page.evaluate(() => parseFloat(getComputedStyle(document.body).getPropertyValue('--window-controls-height')) || 0);
      assert.ok(bounds.x >= 0 && bounds.y >= controlsHeight && bounds.x + bounds.width <= 460 && bounds.y + bounds.height <= 460, JSON.stringify(bounds));
      await page.screenshot({ path: path.join(output, `modal-diagnostics-small-${theme}.png`) });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.setViewportSize({ width: 600, height: 460 });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('React: settings contains themes and updater on every platform, diagnostics only on Windows', async () => {
  for (const platform of ['macos', 'windows']) {
    const f = await fixture({ platform }); const { page } = f;
    try {
      assert.equal(await page.locator('.app-header #theme:visible').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'CodexBei 软件更新' }).count(), 0);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      assert.equal(await page.getByRole('radiogroup', { name: '外观主题' }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: '历史备份', exact: true }).isVisible(), true);
      assert.equal(await page.locator('main #open-history').count(), 0);
      assert.equal(await page.getByRole('button', { name: '问题排查', exact: true }).count(), platform === 'windows' ? 1 : 0);
      await page.getByRole('radio', { name: '雾白', exact: true }).check();
      await page.getByRole('button', { name: '关闭', exact: true }).click();
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});


test('updater: discovery shows stable red dots on settings and update row before download finishes', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.locator('.software-update-dot').count(), 0);
    const rowBefore = await page.locator('.settings-update-row').boundingBox();
    const gearBefore = await page.locator('.settings-entry').boundingBox();
    await page.evaluate(() => { window.fixtureUpdate = true; window.fixtureUpdateDelay = 2000; });
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('progressbar', { name: '更新进度' }).waitFor();
    assert.equal(await page.locator('.settings-entry .software-update-dot').count(), 1);
    assert.equal(await page.locator('.settings-update-row .software-update-dot').count(), 1);
    assert.deepEqual(await page.locator('.settings-update-row').boundingBox(), rowBefore);
    assert.deepEqual(await page.locator('.settings-entry').boundingBox(), gearBefore);
    await page.screenshot({ path: path.join(output, 'settings-update-dots.png') });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('updater: percentage changes keep progress ring, status and versions stationary', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.evaluate(() => { window.fixtureUpdate = true; window.fixtureManualProgress = true; });
    await openUpdater(page);
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await page.getByRole('progressbar', { name: '更新进度' }).waitFor();
    const geometry = () => page.locator('.settings-row-tail').evaluate(el =>
      ['.update-ring', '.settings-update-status', '.update-percentage', '.settings-update-versions'].map(selector => {
        const r = el.querySelector(selector).getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
    const before = await geometry();
    await page.evaluate(() => window.fixtureProgressEvent({ event: 'Started', data: { contentLength: 100 } }));
    let previous = 0;
    for (const percent of [0, 9, 10, 99, 100]) {
      await page.evaluate(chunkLength => window.fixtureProgressEvent({ event: 'Progress', data: { chunkLength } }), percent - previous);
      await page.waitForFunction(expected => document.querySelector('.update-percentage').textContent === expected, `${percent}%`);
      assert.deepEqual(await geometry(), before);
      previous = percent;
    }
    await page.evaluate(() => window.fixtureFinishDownload());
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('React: open config precedes change and reports editor failures without modifying the form', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await page.locator('#toggle-settings').click();
    const open = page.getByRole('button', { name: '打开', exact: true });
    assert.deepEqual(await page.locator('.path-row button').allTextContents(), ['打开', '更改']);
    await open.click();
    await page.waitForFunction(() => window.fixtureOpenedFile === window.fixtureState.file);
    const path = await page.locator('#target').inputValue();
    await page.evaluate(() => { window.fixtureOpenConfigError = '配置文件尚未创建，请先完成配置。'; });
    await open.click();
    await page.getByText('配置文件尚未创建，请先完成配置。', { exact: true }).waitFor();
    assert.equal(await page.locator('#target').inputValue(), path);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('configure')), false);
    assert.equal(await page.evaluate(() => window.fixtureCalls.includes('choose')), false);
    await page.setViewportSize({ width: 460, height: 460 });
    const bounds = await page.locator('.path-row').boundingBox();
    const right = await page.locator('#choose').boundingBox();
    assert.ok(right.x + right.width <= bounds.x + bounds.width + 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const cliOnly of [false, true]) {
  test(`React: installed ${cliOnly ? 'CLI' : 'desktop'} does not recheck on focus or optional install`, async () => {
    const f = await fixture({ platform: 'windows', cliOnly }); const { page } = f;
    try {
      await page.clock.install();
      const count = await page.evaluate(() => window.fixtureCalls.filter(c => c === 'check').length);
      if (cliOnly) await page.getByRole('button', { name: '安装桌面版', exact: true }).first().click();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.clock.fastForward(30_000);
      assert.equal(await page.evaluate(() => window.fixtureCalls.filter(c => c === 'check').length), count);
      assert.equal(await page.locator('#key').isEnabled(), true);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}

test('React: Windows installation offers a direct download fallback', async () => {
  const f = await fixture({ platform: 'windows', noInstallations: true }); const { page } = f;
  try {
    await page.getByRole('button', { name: '微软商店下载', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureInstallerArgs.directDownload), false);
    await page.getByRole('button', { name: '下载安装程序', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureInstallerArgs.directDownload), true);
    await page.evaluate(() => {
      window.fixtureMatching.installations = [{ id: 'desktop', kind: 'desktop', runtimeVersion: '0.153.4' }];
      window.fixtureMatching.selection = { mode: 'installed', id: 'desktop' };
      window.dispatchEvent(new Event('focus'));
    });
    await page.locator('#key').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const kind of ['desktop', 'cli']) {
  test(`React: installation guide stops polling when ${kind} appears`, async () => {
    const f = await fixture({ platform: 'windows', noInstallations: true }); const { page } = f;
    try {
      await page.clock.install();
      await page.getByRole('button', { name: '微软商店下载', exact: true }).click();
      await page.evaluate(kind => {
        window.fixtureMatching.installations = [{ id: kind, kind, runtimeVersion: '0.153.4' }];
        window.fixtureMatching.selection = { mode: 'installed', id: kind };
        window.dispatchEvent(new Event('focus'));
      }, kind);
      await page.clock.fastForward(10_000);
      await page.locator('#key').waitFor();
      const count = await page.evaluate(() => window.fixtureCalls.filter(c => c === 'check').length);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.clock.fastForward(30_000);
      assert.equal(await page.evaluate(() => window.fixtureCalls.filter(c => c === 'check').length), count);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}


test('React: Claude tab keeps drafts isolated, previews mapping and configures JSON with its own backups', async () => {
  const f = await fixture(); const { page } = f;
  page.setDefaultTimeout(8000);
  try {
    await page.locator('#key').fill('sk-codex-unsaved-fixture');
    const saved = await page.evaluate(() => JSON.stringify(window.fixtureState));
    await page.getByRole('tab', {name:'Claude Code'}).click();
    await page.waitForFunction(() => document.querySelector('#key')?.value === 'sk-claude-fixture-not-real' && !document.querySelector('#key').disabled);
    assert.equal(await page.locator('#claude-panel').getAttribute('aria-labelledby'), 'claude-tab');
    assert.equal(await page.locator('#keep-official-login').count(), 0);
    assert.equal(await page.locator('#model-channel').count(), 0);
    await page.getByRole('button', {name:'安装指南', exact:true}).click();
    assert.equal(await page.evaluate(() => window.fixtureClaudeCalls.some(call => call.cmd === 'open_claude_installer')), true);
    await page.locator('#toggle-settings').click();
    await waitForSettingOption(page, '#model', 'claude-opus-test');
    await chooseSetting(page, '#mapping-opus', 'claude-opus-test');
    await page.waitForFunction(() => document.querySelector('#preview-code').textContent.includes('claude-opus-test'));
    assert.equal((await page.locator('#preview-code').textContent()).includes('sk-claude-fixture'), false);
    await page.getByRole('tab', {name:'ChatGPT'}).click();
    await page.waitForFunction(() => document.querySelector('#key')?.value === 'sk-codex-unsaved-fixture' && !document.querySelector('#key').disabled);
    assert.deepEqual(await page.evaluate(() => window.fixtureCheckForces), [false, false]);
    await page.getByRole('tab', {name:'Claude Code'}).click();
    await page.waitForFunction(() => document.querySelector('#mapping-opus')?.value === 'claude-opus-test' && !document.querySelector('#apply').disabled);
    assert.equal(await page.locator('#toggle-settings').getAttribute('aria-expanded'), 'true');
    await page.locator('#mapping-opus').scrollIntoViewIfNeeded();
    await page.screenshot({path: path.join(output, 'claude-settings.png')});
    await page.locator('#apply').click();
    await page.getByRole('heading', {name:'配置完成'}).waitFor();
    assert.match(await page.locator('#success').innerText(), /Claude Code.*新会话生效/);
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixtureState)), saved);
    assert.equal(await page.evaluate(() => window.fixtureClaude.mapping.opus), 'claude-opus-test');
    await page.locator('#done').click();
    await openHistory(page);
    await page.getByRole('button', {name:'查看', exact:true}).click();
    await page.getByText('/isolated/claude/settings.json', {exact:true}).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureBackups.length), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('React: incoming Claude link selects Claude and never configures Codex', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const saved = await page.evaluate(() => JSON.stringify(window.fixtureState));
    await page.evaluate(async () => {
      window.fixtureIncomingTool = 'claude';
      await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {event:'incoming-changed',payload:null});
    });
    await page.getByRole('heading', {name:'配置完成'}).waitFor();
    assert.equal(await page.getByRole('tab', {name:'Claude Code'}).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => JSON.stringify(window.fixtureState)), saved);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('React: tool tabs keep icon positions and configuration label stable while loading', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await chooseTheme(page, '雾白');
    const positions = () => page.locator('.tabs .agent-icon').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; }));
    const before = await positions();
    await page.locator('#key').fill('sk-steady-draft');
    await page.waitForFunction(() => !document.querySelector('#apply').disabled);
    for (const tool of ['Claude Code', 'ChatGPT']) {
      await page.evaluate(() => { window.fixtureHoldCheck = true; window.fixtureReleaseCheck = null; });
      await page.getByRole('tab', {name:tool,exact:true}).click();
      await page.waitForFunction(() => !!window.fixtureReleaseCheck);
      assert.deepEqual(await positions(), before);
      assert.equal(await page.locator('#apply').innerText(), '一键配置');
      assert.equal(await page.locator('#apply').isDisabled(), true);
      if (tool === 'ChatGPT') {
        assert.equal(await page.locator('#key').inputValue(), 'sk-steady-draft');
        for (const selector of ['#key', '#apply']) {
          assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).opacity), '1');
        }
      }
      assert.equal(await page.getByRole('tab', {name:tool,exact:true}).isDisabled(), false);
      await page.evaluate(() => { window.fixtureHoldCheck = false; window.fixtureReleaseCheck(); });
      await page.waitForFunction(() => document.querySelector('#configure')?.getAttribute('aria-busy') === 'false');
      assert.deepEqual(await positions(), before);
      assert.equal(await page.locator('#apply').innerText(), '一键配置');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('React: API quota and Plus Ultra plans stay visible across routing and refresh', async () => {
  const f = await fixture(); const {page}=f;
  try {
    await page.setViewportSize({width:600,height:740});
    await page.getByText('$128.50',{exact:true}).waitFor();
    assert.equal(await page.locator('.quota-official').count(),0);
    assert.equal(await page.evaluate(()=>window.fixtureQuotaRequests),1);
    assert.equal(await page.locator('.quota-plans').isVisible(),false);
    const titleTop=await page.locator('.config-title').evaluate(e=>e.getBoundingClientRect().top);
    await page.getByRole('button',{name:/生效套餐\s*2/}).click();
    await page.getByText('Ultra 月卡',{exact:true}).waitFor();
    assert.equal(await page.locator('.config-title').evaluate(e=>e.getBoundingClientRect().top),titleTop);
    await page.locator('#keep-official-login').check();
    const geometry=()=>page.evaluate(()=>['#key','#apply','.quota-api'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]}));
    const before=await geometry();
    const count=await page.evaluate(()=>window.fixtureCalls.filter(c=>c==='quota').length);
    await page.getByRole('radio',{name:'官方',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('main').dataset.channelUpdating);
    assert.deepEqual(await geometry(),before);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c==='quota').length),count);
    await page.evaluate(()=>window.fixtureQuotaDelay=400);
    await page.getByRole('button',{name:'刷新API 额度'}).click();
    await page.waitForFunction(n=>window.fixtureCalls.filter(c=>c==='quota').length>n,count);
    assert.deepEqual(await geometry(),before);
    await page.waitForFunction(()=>document.querySelector('.quota-api').getAttribute('aria-busy')==='false');
    assert.deepEqual(await geometry(),before);
    await page.evaluate(()=>window.fixtureQuotaError='额度查询失败，请稍后刷新。');
    await page.getByRole('button',{name:'刷新API 额度'}).evaluate(button=>button.click());
    await page.locator('.quota-panel').waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>['#key','#apply'].map(s=>{const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height]})),before.slice(0,2));
    assert.equal(await page.getByText('暂时无法获取额度信息',{exact:true}).count(),0);
    await page.setViewportSize({width:460,height:600});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(f.errors,[]);
  } finally { await f.close(); }
});

test('React: switching Claude and ChatGPT reuses API quota snapshot', async () => {
  const f = await fixture(); const {page}=f;
  try {
    await page.getByText('$128.50',{exact:true}).waitFor();
    const calls=()=>page.evaluate(()=>window.fixtureCalls.filter(c=>c==='quota').length);
    const before=await calls();
    for(let i=0;i<2;i++) {
      await page.getByRole('tab',{name:'Claude Code',exact:true}).click();
      await page.locator('#claude-panel').waitFor();
      await page.getByText('$64.25',{exact:true}).waitFor();
      assert.equal(await page.locator('.quota-plans').isVisible(),false);
      await page.getByRole('button',{name:/生效套餐\s*2/}).click();
      await page.getByText('Ultra 月卡',{exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'充值',exact:true}).count(),1);
      await page.getByRole('tab',{name:'ChatGPT',exact:true}).click();
      await page.getByText('$128.50',{exact:true}).waitFor();
    }
    assert.equal(await calls(),before+1);
    await page.getByRole('button',{name:'刷新API 额度',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.quota-api').getAttribute('aria-busy')==='false');
    assert.equal(await calls(),before+2);
    assert.equal(await page.evaluate(()=>window.fixtureClaudeCalls.filter(c=>c.cmd==='quota').length),1);
  } finally { await f.close(); }
});

test('React: absent official credentials hide the whole official quota region', async () => {
  const f = await fixture({officialLogin:false}); const {page}=f;
  try {
    await page.getByText('$128.50',{exact:true}).waitFor();
    assert.equal(await page.locator('.quota-official').count(),0);
    assert.equal(await page.getByRole('button',{name:'刷新官方额度'}).count(),0);
    assert.equal(await page.evaluate(()=>window.fixtureCalls.filter(c=>c==='quota').length),1);
    assert.equal(await page.locator('.quota-panel').evaluate(e=>e.firstElementChild.classList.contains('quota-api')),true);
  } finally { await f.close(); }
});

test('React: API quota stays hidden until available and on initial failure or empty response', async () => {
 for (const options of [{quotaDelay:1200},{quotaError:'查询失败'},{emptyQuota:true}]) {
  const f=await fixture(options); const {page}=f;
  try {
   assert.equal(await page.locator('.quota-panel').count(),0);
   assert.equal(await page.getByText('正在查询额度…',{exact:true}).count(),0);
   if(options.quotaDelay) await page.getByText('$128.50',{exact:true}).waitFor();
   else {assert.equal(await page.getByText('API 额度',{exact:true}).count(),0);}
   assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
 }
});

 test('React: no eligible plans leaves no message or plan placeholder', async () => {
 const f=await fixture(); const {page}=f;
 try {
  await page.getByText('$128.50',{exact:true}).waitFor();
  await page.evaluate(()=>window.fixtureNoPlans=true);
  await page.getByRole('button',{name:'刷新API 额度',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.quota-api').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('.quota-plans').count(),0);
  assert.equal(await page.getByText('暂无有效套餐',{exact:true}).count(),0);
  assert.equal(await page.getByText('$128.50',{exact:true}).count(),1);
 } finally {await f.close();}
});

test('React: recharge is available only for the BeiAPI v1 endpoint', async () => {
 for (const baseUrl of ['https://api.beiapi.cn/v1','https://other.example/v1','https://api.beiapi.cn/v2']) {
  const f=await fixture({baseUrl});
  try {
   await f.page.getByText('$128.50',{exact:true}).waitFor();
   const button=f.page.getByRole('button',{name:'充值',exact:true});
   if(baseUrl==='https://api.beiapi.cn/v1') {
    assert.match(await button.locator('..').innerText(),/余额/);
    await button.click();
    assert.equal(await f.page.evaluate(()=>window.fixtureWalletOpened),true);
   } else assert.equal(await button.count(),0);
   assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
 }
});
