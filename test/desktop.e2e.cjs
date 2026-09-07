// Runs only against disposable Codex and app-data directories.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const { test } = require('node:test');

test('minimal desktop: link prefill, one-click setup, advanced preview, errors and restore', async () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-ui-')));
  const home = path.join(temporary, 'codex');
  const userData = path.join(temporary, 'app-data');
  const file = path.join(home, 'config.toml');
  const artifacts = path.resolve(__dirname, '../artifacts');
  fs.mkdirSync(home);
  fs.mkdirSync(userData);
  fs.mkdirSync(artifacts, { recursive: true });
  const original = '# Personal tools\nmodel="old"\n[mcp_servers.editor]\ncommand="node"\nargs=["my-tool.js"]\n';
  fs.writeFileSync(file, original);
  const launcher = path.join(temporary, 'launch.cjs');
  fs.writeFileSync(launcher, `
    const { app, dialog } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.env.CODEX_HOME = ${JSON.stringify(home)};
    dialog.showMessageBox = async () => ({ response: 1 });
    globalThis.__testManifest = require(${JSON.stringify(path.resolve(__dirname, '../src/bootstrap-manifest.json'))});
    globalThis.__models = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol'];
    globalThis.__modelStatus = 200;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).pathname === '/v1/models') {
        const data = globalThis.__models.map(id => ({ id }));
        if (globalThis.__holdModels) {
          globalThis.__holdModels = false;
          await new Promise(resolve => { globalThis.__releaseModels = resolve; });
        }
        return Response.json({ data }, { status: globalThis.__modelStatus });
      }
      return require(${JSON.stringify(path.resolve(__dirname, '../worker/handler.cjs'))}).handle(new Request(url, options), globalThis.__testManifest);
    };
    const originalInterval = globalThis.setInterval;
    globalThis.setInterval = (callback, delay, ...args) => {
      if (delay === 4 * 60 * 60 * 1000) globalThis.__periodicCheck = callback;
      return originalInterval(callback, delay, ...args);
    };
    globalThis.__unknownVersions = () => {
      // The detector is imported by main below, so switch its fixture via a shared list.
      globalThis.__testInstallations.length = 0;
    };
    globalThis.__testInstallations = [
      { id: 'cli', kind: 'cli', runtimeVersion: '0.153.4' },
      { id: 'desktop', kind: 'desktop', runtimeVersion: '0.153.4', appVersion: '26.901.51231' }
    ];
    require(${JSON.stringify(path.resolve(__dirname, '../src/codex-versions.cjs'))}).detectInstallations = async () => globalThis.__testInstallations;
    require(${JSON.stringify(path.resolve(__dirname, '../src/main.cjs'))});
  `);
  const link = new URL('codexbei://configure/codex');
  link.searchParams.set('model', 'gpt-5.6-terra');
  link.searchParams.set('preset', 'codexbei-v1');
  link.searchParams.set('base_url', 'https://api.beiapi.cn/v1');
  link.searchParams.set('api_key', 'sk-fixture-not-a-real-credential');
  let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [launcher, link.href], timeout: 25000 });
    const page = await electron.firstWindow();
    assert.equal(await page.title(), 'CodexBei');
    assert.equal(await electron.evaluate(({ app }) => app.getName()), 'CodexBei');
    await page.waitForFunction(() => !document.getElementById('imported').hidden);
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await page.locator('#theme input:checked').inputValue(), 'system');
    const captureThemes = async (name) => {
      for (const theme of ['dark', 'light']) {
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({ path: path.join(artifacts, `desktop-${name}-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
    };
    // Visibility is local to this input; clearing never modifies the saved config.
    await page.locator('#toggle-key').click();
    assert.equal(await page.locator('#key').getAttribute('type'), 'text');
    assert.equal(await page.locator('#toggle-key').getAttribute('aria-label'), '隐藏密钥');
    await page.locator('#toggle-key').click();
    assert.equal(await page.locator('#key').getAttribute('type'), 'password');
    await page.locator('#toggle-key').click();
    await page.locator('#clear-key').click();
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.equal(await page.locator('#key').getAttribute('type'), 'password');
    assert.equal(await page.locator('#key').evaluate((element) => element === document.activeElement), true);
    assert.equal(await page.locator('#toggle-key').isDisabled(), true);
    assert.equal(await page.locator('#clear-key').isDisabled(), true);
    assert.equal(await page.locator('#imported').isVisible(), false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link.href);
    await page.waitForFunction(() => !document.getElementById('toggle-key').disabled);
    await page.locator('#toggle-key').click();
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link.href);
    await page.waitForFunction(() => document.getElementById('key').type === 'password' && !document.getElementById('toggle-key').disabled);
    // The OS appearance updates the UI live without changing the entered connection.
    await captureThemes('theme');
    await page.locator('#key').focus();
    for (const theme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
      await page.locator('.credential-field').screenshot({ path: path.join(artifacts, `input-focus-${theme}.png`), animations: 'disabled' });
    }
    await page.locator('#theme input[value="system"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#theme input:checked').inputValue(), 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await page.locator('#theme input:checked').inputValue(), 'dark');
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.locator('#theme input[value="system"]').check();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link.href);
    await page.waitForFunction(() => !document.getElementById('imported').hidden);
    assert.equal(await page.locator('#settings').getAttribute('open'), null);
    assert.equal(await page.locator('#history').getAttribute('open'), null);
    assert.equal(await page.locator('#base-url').isVisible(), false);
    assert.equal(await page.locator('#base-url').inputValue(), 'https://api.beiapi.cn/v1');
    assert.equal(await page.locator('#key').getAttribute('type'), 'password');
    assert.equal(await page.locator('#model').inputValue(), 'gpt-5.6-terra');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(await page.locator('[role="tab"][aria-selected="false"]').isDisabled(), true);
    const firstScreen = await page.evaluate(() => ({
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      actionVisible: document.getElementById('apply').getBoundingClientRect().bottom <= innerHeight,
    }));
    assert.deepEqual(firstScreen, { horizontalOverflow: false, actionVisible: true });
    await page.screenshot({ path: path.join(artifacts, 'desktop-minimal.png') });
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear.png') });
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(460, 540));
    await page.waitForFunction(() => innerWidth === 460);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('apply').getBoundingClientRect().bottom <= innerHeight), true);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-compact.png') });
    await captureThemes('compact');
    assert.equal(await page.evaluate(() => {
      const brand = document.querySelector('.brand').getBoundingClientRect();
      const actions = document.querySelector('.toolbar-actions').getBoundingClientRect();
      return brand.right < actions.left && actions.right <= innerWidth;
    }), true);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 594));
    await page.waitForFunction(() => innerWidth === 600);

    // Selecting an installed version or automatic matching needs no confirmation or write.
    await page.locator('#settings > summary').click();
    await page.waitForFunction(() => [...document.getElementById('model').options].some(option => option.value === 'gpt-5.6-sol'));
    assert.equal(await page.locator('#model').evaluate(element => element.tagName), 'SELECT');
    assert.equal(await page.locator('#model').inputValue(), 'gpt-5.6-terra');
    await page.locator('#model').selectOption('gpt-5.6-sol');
    await page.locator('#preview-button').click();
    await page.waitForFunction(() => !document.getElementById('preview').hidden);
    assert.ok((await page.locator('#preview-code').textContent()).includes('gpt-5.6-sol'));
    await page.locator('#model').selectOption('gpt-5.6-terra');
    assert.equal(await page.locator('#preview').isVisible(), false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    // A failed refresh retains the user's model and a later response for an old key is ignored.
    await electron.evaluate(() => { globalThis.__modelStatus = 401; });
    await page.locator('#refresh-models').click();
    await page.waitForFunction(() => document.getElementById('models-help').textContent.includes('权限'));
    assert.equal(await page.locator('#model').inputValue(), 'gpt-5.6-terra');
    await electron.evaluate(() => { globalThis.__modelStatus = 200; globalThis.__models = ['stale-model']; globalThis.__holdModels = true; });
    await page.locator('#refresh-models').click();
    await electron.evaluate(async () => { while (!globalThis.__releaseModels) await new Promise(resolve => setTimeout(resolve, 10)); });
    await electron.evaluate(() => { globalThis.__models = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol']; });
    await page.locator('#key').fill('sk-fixture-another-credential');
    await page.waitForFunction(() => [...document.getElementById('model').options].some(option => option.value === 'gpt-5.6-sol'));
    await electron.evaluate(() => { globalThis.__releaseModels(); });
    await page.waitForFunction(() => document.getElementById('model').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#model option[value="stale-model"]').count(), 0);
    await page.locator('#key').fill('sk-fixture-not-a-real-credential');

    await page.locator('#change-version').click();
    assert.equal(await page.getByRole('button', { name: '确认版本', exact: true }).count(), 0);
    for (const selection of ['cli', 'desktop', 'auto']) {
      await page.locator('#installation').selectOption(selection);
      await page.waitForFunction(() => document.getElementById('version-choice').getAttribute('aria-busy') === 'false' && !document.getElementById('apply').disabled);
      assert.equal(await page.locator('#installation').inputValue(), selection);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
    await page.locator('#change-version').click();
    await page.locator('#settings > summary').click();
    // One explicit click is enough; preview is optional and the link itself never applies.
    await page.getByRole('button', { name: '一键配置', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('success').hidden);
    assert.equal(await page.locator('#success-title').textContent(), '配置完成');
    assert.equal(require('@iarna/toml').parse(fs.readFileSync(file, 'utf8')).model, 'gpt-5.6-terra');
    assert.equal(require('@iarna/toml').parse(fs.readFileSync(file, 'utf8')).model_providers.custom.base_url, 'https://api.beiapi.cn/v1');
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.ok(fs.readFileSync(file, 'utf8').includes('[mcp_servers.editor]\ncommand="node"\nargs=["my-tool.js"]\n'));
    await page.screenshot({ path: path.join(artifacts, 'desktop-minimal-success.png') });
    await captureThemes('success');

    // Download a new remote policy while the app is running. No config write until the update click.
    const beforeUpdate = fs.readFileSync(file, 'utf8');
    await electron.evaluate(() => {
      const next = structuredClone(globalThis.__testManifest);
      next.release += 1; next.templates[0].version = '1.1.0';
      next.templates[0].set.model_reasoning_effort = 'xhigh';
      delete next.templates[0].set.disable_response_storage;
      next.templates[0].remove = [['disable_response_storage']];
      globalThis.__testManifest = next;
    });
    await electron.evaluate(async () => { await globalThis.__periodicCheck(); });
    await page.waitForFunction(() => document.getElementById('apply').textContent === '更新配置');
    assert.equal(await page.locator('#apply').textContent(), '更新配置');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeUpdate);
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.equal(await page.locator('#model').inputValue(), 'gpt-5.6-terra');
    await page.screenshot({ path: path.join(artifacts, 'desktop-update.png') });
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('success').hidden);
    const updated = require('@iarna/toml').parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.model, 'gpt-5.6-terra');
    assert.equal(updated.model_reasoning_effort, 'xhigh');
    assert.equal(updated.disable_response_storage, undefined);
    assert.equal(updated.model_providers.custom.experimental_bearer_token, 'sk-fixture-not-a-real-credential');

    // Restore remains accessible without technical details on the home screen.
    await page.locator('#history > summary').click();
    await page.locator('.backup button').last().click();
    await page.waitForFunction(() => document.getElementById('success-title').textContent === '已还原');
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link.href);
    await page.waitForFunction(() => !document.getElementById('setup-view').hidden);
    await page.locator('#key').fill('invalid');
    await page.getByRole('button', { name: '一键配置', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').classList.contains('error'));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(await page.locator('#apply').isEnabled(), true);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-error.png'), fullPage: true });
    await captureThemes('error');

    await page.locator('#key').fill('sk-fixture-not-a-real-credential');
    await page.locator('#settings > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#base-url').isVisible(), true);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-settings.png'), fullPage: true });
    await captureThemes('settings');
    await page.getByRole('button', { name: '查看配置改动' }).click();
    await page.waitForFunction(() => !document.getElementById('preview').hidden);
    assert.equal((await page.locator('#preview-code').textContent()).includes('sk-fixture-not-a-real-credential'), false);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-preview.png'), fullPage: true });
    await captureThemes('preview');
    const edited = original + '\n# Added after preview\n';
    fs.writeFileSync(file, edited);
    await page.getByRole('button', { name: '一键配置', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status').classList.contains('error'));
    assert.equal(fs.readFileSync(file, 'utf8'), edited);

    // A new link clears any stale preview and brings the compact form back.
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link.href);
    await page.waitForFunction(() => !document.getElementById('imported').hidden);
    assert.equal(await page.locator('#settings').getAttribute('open'), null);
    assert.equal(await page.locator('#preview').isVisible(), false);
    await electron.evaluate(async () => { globalThis.__unknownVersions(); await globalThis.__periodicCheck(); });
    await page.waitForFunction(() => !document.getElementById('version-choice').hidden);
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#installation').selectOption('manual');
    await page.locator('#runtime-version').fill('0.152.1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-version.png'), fullPage: true });
    await page.waitForFunction(() => document.getElementById('version-choice').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#runtime-version').fill('0.153.4');
    await page.waitForFunction(() => document.getElementById('version-choice').getAttribute('aria-busy') === 'false');
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await page.locator('#version-choice').isVisible(), true);
    // Editing a matched version invalidates it immediately, including incomplete input.
    await page.locator('#runtime-version').fill('0.153.');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.waitForFunction(() => document.getElementById('version-choice').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#apply').isDisabled(), true);
    await page.locator('#runtime-version').fill('0.153.4');
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    await page.getByRole('button', { name: '一键配置', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('success').hidden);
    await page.locator('#theme input[value="light"]').check();
    const beforeRestart = fs.readFileSync(file, 'utf8');
    const closed = electron.waitForEvent('close');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await closed;
    electron = null;
    // A full app restart preserves an explicit choice despite a different OS appearance.
    electron = await _electron.launch({ executablePath: require('electron'), args: [launcher], timeout: 25000 });
    const restarted = await electron.firstWindow();
    await restarted.emulateMedia({ colorScheme: 'dark' });
    await restarted.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await restarted.locator('#theme input:checked').inputValue(), 'light');
    assert.equal(await restarted.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeRestart);
  } finally {
    if (electron) await electron.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
