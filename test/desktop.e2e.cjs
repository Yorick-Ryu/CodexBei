// Runs only against disposable Codex and app-data directories.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron } = require('playwright-core');
const { test } = require('node:test');
const TOML = require('@iarna/toml');

test('website links automatically configure on cold and warm launch, deduplicate delivery and supersede stale requests', async () => {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexbei-auto-')));
  const home = path.join(temporary, 'codex');
  const userData = path.join(temporary, 'app-data');
  const file = path.join(home, 'config.toml');
  const backups = path.join(userData, 'backups');
  fs.mkdirSync(home); fs.mkdirSync(userData);
  const original = '# Personal setup\n[mcp_servers.editor]\ncommand="node"\n';
  fs.writeFileSync(file, original);
  const launcher = path.join(temporary, 'launch.cjs');
  fs.writeFileSync(launcher, `
    const { app, shell } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.env.CODEX_HOME = ${JSON.stringify(home)};
    shell.trashItem = async folder => {
      const fs = require('node:fs'), path = require('node:path');
      const trash = ${JSON.stringify(path.join(temporary, 'trash'))};
      fs.mkdirSync(trash, { recursive: true }); fs.renameSync(folder, path.join(trash, path.basename(folder)));
    };
    require(${JSON.stringify(path.resolve(__dirname, '../src/codex-versions.cjs'))}).detectInstallations = async () => [
      { id: 'cli', kind: 'cli', runtimeVersion: '0.153.4' }
    ];
    globalThis.fetch = async (url, options) => {
      if (globalThis.__holdNextCheck) {
        globalThis.__holdNextCheck = false;
        await new Promise(resolve => { globalThis.__releaseCheck = resolve; globalThis.__onHeld(); });
      }
      return require(${JSON.stringify(path.resolve(__dirname, '../worker/handler.cjs'))}).handle(
        new Request(url, options), require(${JSON.stringify(path.resolve(__dirname, '../src/bootstrap-manifest.json'))}));
    };
    require(${JSON.stringify(path.resolve(__dirname, '../src/main.cjs'))});
  `);
  const link = (model, key = 'sk-fixture-auto-not-a-real-key', baseUrl = 'https://api.beiapi.cn/v1') => {
    const url = new URL('codexbei://configure/codex');
    url.searchParams.set('base_url', baseUrl); url.searchParams.set('api_key', key);
    url.searchParams.set('model', model); url.searchParams.set('preset', 'codexbei-v1');
    return url.href;
  };
  let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [launcher, link('gpt-5.6-terra')], timeout: 25000 });
    const page = await electron.firstWindow();
    const completed = model => page.waitForFunction(expected =>
      document.getElementById('model').value === expected && !document.getElementById('success').hidden &&
      document.getElementById('configure').getAttribute('aria-busy') === 'false', model);
    await completed('gpt-5.6-terra');
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.equal(await page.locator('#success-title').textContent(), '配置完成');
    assert.equal(TOML.parse(fs.readFileSync(file, 'utf8')).model, 'gpt-5.6-terra');
    assert.ok(fs.readFileSync(file, 'utf8').includes('[mcp_servers.editor]\ncommand="node"'));
    assert.equal(fs.readdirSync(backups).length, 1);
    assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'config.toml'), 'utf8'), original);
    // A consumed handoff cannot be replayed through IPC.
    assert.ok((await page.evaluate(file => window.setup.configureIncoming(file, 1, false), file)).error);
    assert.equal(fs.readdirSync(backups).length, 1);

    const second = link('gpt-5.6-sol', 'sk-fixture-second-not-a-real-key', 'https://second.example/v1');
    await electron.evaluate(({ app }, url) => {
      app.emit('second-instance', {}, ['CodexBei', url]);
      app.emit('open-url', { preventDefault() {} }, url);
    }, second);
    await completed('gpt-5.6-sol');
    assert.equal(fs.readdirSync(backups).length, 2);
    const secondConfig = TOML.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(secondConfig.model_providers.custom.base_url, 'https://second.example/v1');
    assert.equal(secondConfig.model_providers.custom.experimental_bearer_token, 'sk-fixture-second-not-a-real-key');

    await electron.evaluate(() => {
      globalThis.__holdNextCheck = true;
      globalThis.__waitUntilHeld = new Promise(resolve => { globalThis.__onHeld = resolve; });
    });
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link('gpt-5.6-terra'));
    await electron.evaluate(async () => { await globalThis.__waitUntilHeld; });
    await electron.evaluate(({ app }, url) => {
      app.emit('open-url', { preventDefault() {} }, url);
      globalThis.__releaseCheck();
    }, link('gpt-5.6-luna'));
    await completed('gpt-5.6-luna');
    assert.equal(fs.readdirSync(backups).length, 3);
    assert.equal(TOML.parse(fs.readFileSync(file, 'utf8')).model, 'gpt-5.6-luna');

    const beforeInvalid = fs.readFileSync(file);
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), link('gpt-6-astra', undefined, 'http://example.com/v1'));
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('链接无效'));
    assert.deepEqual(fs.readFileSync(file), beforeInvalid);
    assert.equal(fs.readdirSync(backups).length, 3);

    fs.writeFileSync(file, 'profile="work"\n' + beforeInvalid.toString());
    const blocked = fs.readFileSync(file);
    const retry = link('gpt-6-astra');
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), retry);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('profile'));
    assert.deepEqual(fs.readFileSync(file), blocked);
    assert.equal(fs.readdirSync(backups).length, 3);
    fs.writeFileSync(file, beforeInvalid);
    await electron.evaluate(({ app }, url) => app.emit('open-url', { preventDefault() {} }, url), retry);
    await completed('gpt-6-astra');
    assert.equal(fs.readdirSync(backups).length, 4);
  } finally {
    if (electron) await electron.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('minimal desktop: manual setup, advanced preview, errors and restore', async () => {
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
    const { app, dialog, shell } = require('electron');
    app.setPath('userData', ${JSON.stringify(userData)});
    process.env.CODEX_HOME = ${JSON.stringify(home)};
    globalThis.__dialogResponse = 1;
    dialog.showMessageBox = async () => ({ response: globalThis.__dialogResponse });
    shell.trashItem = async (folder) => {
      if (globalThis.__trashFail) throw new Error('Fixture trash unavailable');
      const destination = ${JSON.stringify(path.join(temporary, 'trash'))};
      require('node:fs').mkdirSync(destination, { recursive: true });
      require('node:fs').renameSync(folder, require('node:path').join(destination, require('node:path').basename(folder)));
    };
    globalThis.__testManifest = require(${JSON.stringify(path.resolve(__dirname, '../src/bootstrap-manifest.json'))});
    globalThis.__models = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol'];
    globalThis.__modelStatus = 200;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).pathname === '/v1/models') {
        if (!['0.153.4', '0.152.1'].includes(new URL(url).searchParams.get('client_version'))) throw new Error('Expected actual Codex runtime version');
        const models = globalThis.__models.map(slug => ({ slug, visibility: 'list', supported_in_api: true }));
        if (globalThis.__holdModels) {
          globalThis.__holdModels = false;
          await new Promise(resolve => { globalThis.__releaseModels = resolve; });
        }
        return Response.json({ models }, { status: globalThis.__modelStatus });
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
    electron = await _electron.launch({ executablePath: require('electron'), args: [launcher], timeout: 25000 });
    const page = await electron.firstWindow();
    assert.equal(await page.title(), 'CodexBei');
    assert.equal(await page.getByRole('tab', { name: 'ChatGPT', exact: true }).count(), 1);
    assert.equal(await page.locator('#codex-tab img').getAttribute('src'), 'assets/agents/chatgpt.svg');
    assert.equal(await page.getByRole('button', { name: '官网' }).count(), 0);
    assert.equal(await electron.evaluate(({ app }) => app.getName()), 'CodexBei');
    const fillManual = async () => {
      await page.waitForFunction(() => document.getElementById('configure').getAttribute('aria-busy') === 'false');
      if (await page.locator('#history-page').isVisible()) await page.locator('#back-to-config').click();
      if (await page.locator('#success').isVisible()) await page.locator('#done').click();
      if (await page.locator('#key').getAttribute('type') === 'text') await page.locator('#toggle-key').click();
      await page.locator('#key').fill(link.searchParams.get('api_key'));
      if (!await page.locator('#settings').evaluate(element => element.open)) await page.locator('#settings > summary').click();
      await page.locator('#base-url').fill(link.searchParams.get('base_url'));
      await page.waitForFunction(() => [...document.getElementById('model').options].some(option => option.value === 'gpt-5.6-terra'));
      await page.locator('#model').selectOption(link.searchParams.get('model'));
      await page.locator('#settings > summary').click();
    };
    await fillManual();
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
    await fillManual();
    await page.waitForFunction(() => !document.getElementById('toggle-key').disabled);
    await page.locator('#toggle-key').click();
    await fillManual();
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
    await fillManual();
    await page.waitForFunction(() => document.getElementById('key').value.length > 0);
    assert.equal(await page.locator('#keep-official-login').isChecked(), false);
    assert.equal(await page.locator('#settings').getAttribute('open'), null);
    assert.equal(await page.locator('#history-page').isVisible(), false);
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
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(460, 460));
    await page.waitForFunction(() => innerWidth === 460);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.getElementById('apply').getBoundingClientRect().bottom <= innerHeight), true);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-compact.png') });
    await captureThemes('compact');
    assert.equal(await page.evaluate(() => {
      const brand = document.querySelector('.brand').getBoundingClientRect();
      const actions = document.querySelector('.toolbar-actions').getBoundingClientRect();
      return brand.right < actions.left && actions.right <= innerWidth;
    }), true);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(600, 460));
    await page.waitForFunction(() => innerWidth === 600);

    // Selecting an installed version or automatic matching needs no confirmation or write.
    await page.locator('#settings > summary').click();
    await page.waitForFunction(() => [...document.getElementById('model').options].some(option => option.value === 'gpt-5.6-sol'));
    assert.equal(await page.locator('#model').evaluate(element => element.tagName), 'SELECT');
    assert.equal(await page.locator('#model').inputValue(), 'gpt-5.6-terra');
    await electron.evaluate(() => {
      globalThis.__models = ['gpt-6-astra', 'gpt-5.6-sol'];
    });
    await page.locator('#refresh-models').click();
    await page.waitForFunction(() => document.getElementById('model').getAttribute('aria-busy') === 'false');
    assert.deepEqual(await page.locator('#model option').evaluateAll(options => options.map(option => option.value)), ['gpt-6-astra', 'gpt-5.6-sol']);
    assert.equal(await page.locator('#model').inputValue(), 'gpt-6-astra');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    await electron.evaluate(() => {
      globalThis.__models = ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol'];
    });
    await page.locator('#refresh-models').click();
    await page.waitForFunction(() => document.getElementById('model').getAttribute('aria-busy') === 'false');
    await page.locator('#model').selectOption('gpt-5.6-sol');
    assert.equal(await page.locator('#version-info').isVisible(), true);
    assert.equal(await page.locator('#preview-version').isVisible(), true);
    await page.waitForFunction(() => !document.getElementById('preview').hidden);
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('gpt-5.6-sol'));
    assert.equal(await page.locator('.preview-heading').textContent(), '配置预览');
    await page.evaluate(() => {
      const preview = document.getElementById('preview-code');
      window.__previewWentBlank = false;
      window.__previewObserver = new MutationObserver(() => {
        if (!preview.textContent.trim()) window.__previewWentBlank = true;
      });
      window.__previewObserver.observe(preview, { childList: true, characterData: true, subtree: true });
    });
    await page.getByRole('checkbox', { name: '保留官方登录' }).check();
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('requires_openai_auth = true'));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    await page.getByRole('checkbox', { name: '保留官方登录' }).uncheck();
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('requires_openai_auth = false'));
    assert.equal(await page.evaluate(() => {
      window.__previewObserver.disconnect();
      return window.__previewWentBlank;
    }), false, 'Changing official login must update the preview without clearing it first');
    assert.equal(await page.locator('#preview-version').textContent(), '配置模板：当前 v1.0.0 · 最新 v1.0.0');
    assert.equal(await page.getByRole('button', { name: '更新配置模板', exact: true }).count(), 1);
    assert.equal(await page.locator('#template-update-dot').isVisible(), false);
    assert.equal(await page.locator('#update-template').isDisabled(), true);
    await page.locator('#model').selectOption('gpt-5.6-terra');
    assert.equal(await page.locator('#preview').isVisible(), true);
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('gpt-5.6-terra'));
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
    assert.equal(await page.locator('#version-choice').evaluate(dialog => dialog.matches(':modal')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#version-choice').isVisible(), false);
    assert.equal(await page.locator('#change-version').evaluate(button => button === document.activeElement), true);
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

    // Checking and activating a template never writes the user's configuration.
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
    await page.waitForFunction(() => document.getElementById('preview-version').textContent.includes('最新 v1.1.0'));
    assert.equal(await page.locator('#apply').textContent(), '一键配置');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeUpdate);
    assert.equal(await page.locator('#preview-version').textContent(), '配置模板：当前 v1.0.0 · 最新 v1.1.0');
    assert.equal(await page.locator('#key').inputValue(), '');
    assert.equal(await page.locator('#model').inputValue(), 'gpt-5.6-terra');
    await page.locator('#settings > summary').click();
    assert.equal(await page.locator('#template-update-dot').isVisible(), true);
    assert.equal(await page.locator('#update-template').isDisabled(), false);
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('model_reasoning_effort = "high"'));
    await page.screenshot({ path: path.join(artifacts, 'desktop-update.png'), fullPage: true });
    const backupsBeforeTemplateUpdate = await page.locator('.backup').count();
    await page.locator('#update-template').click();
    await page.waitForFunction(() => document.getElementById('status').textContent === '配置模板已更新' && document.getElementById('configure').getAttribute('aria-busy') === 'false');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeUpdate);
    assert.equal(await page.locator('.backup').count(), backupsBeforeTemplateUpdate);
    assert.equal(await page.locator('#success').isVisible(), false);
    assert.equal(await page.locator('#preview-version').textContent(), '配置模板：当前 v1.1.0 · 最新 v1.1.0');
    assert.ok((await page.locator('#preview-code').textContent()).includes('model_reasoning_effort = "xhigh"'));
    assert.equal(await page.locator('#template-update-dot').isVisible(), false);
    assert.equal(await page.locator('#update-template').isDisabled(), true);
    await page.getByRole('button', { name: '更新配置', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('success').hidden);
    const updated = require('@iarna/toml').parse(fs.readFileSync(file, 'utf8'));
    assert.equal(updated.model, 'gpt-5.6-terra');
    assert.equal(updated.model_reasoning_effort, 'xhigh');
    await page.waitForFunction(() => document.getElementById('preview-version').textContent === '配置模板：当前 v1.1.0 · 最新 v1.1.0');
    assert.equal(updated.disable_response_storage, undefined);
    assert.equal(await page.locator('#template-update-dot').getAttribute('hidden'), '');
    assert.equal(await page.locator('#update-template').isDisabled(), true);
    assert.equal(updated.model_providers.custom.experimental_bearer_token, 'sk-fixture-not-a-real-credential');

    // Restore remains accessible without technical details on the home screen.
    await page.locator('#open-history').click();
    await page.locator('.backup button').last().click();
    await page.waitForFunction(() => document.getElementById('success-title').textContent === '已还原');
    assert.equal(fs.readFileSync(file, 'utf8'), original);

    await fillManual();
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
    await page.waitForFunction(() => !document.getElementById('preview').hidden);
    await page.waitForFunction(() => document.getElementById('preview-code').textContent.includes('model_provider'));
    assert.equal((await page.locator('#preview-code').textContent()).includes('sk-fixture-not-a-real-credential'), false);
    assert.equal(await page.locator('#preview-version').textContent(), '配置模板：当前 v1.1.0 · 最新 v1.1.0');
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-preview.png'), fullPage: true });
    await captureThemes('preview');
    const edited = original + '\n# Added after preview\n';
    fs.writeFileSync(file, edited);
    await page.getByRole('button', { name: '一键配置', exact: true }).click();
    await page.waitForFunction(() => !document.getElementById('success').hidden);
    assert.ok(fs.readFileSync(file, 'utf8').includes('# Added after preview'));
    assert.ok(fs.readFileSync(file, 'utf8').includes('[mcp_servers.editor]'));

    // Returning to manual setup keeps the compact form available after success.
    await fillManual();
    await page.waitForFunction(() => document.getElementById('key').value.length > 0);
    assert.equal(await page.locator('#settings').getAttribute('open'), null);
    assert.equal(await page.locator('#preview').isVisible(), false);
    await electron.evaluate(async () => { globalThis.__unknownVersions(); await globalThis.__periodicCheck(); });
    await page.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await page.locator('#version-choice').isVisible(), false);
    await page.locator('#settings > summary').click();
    await page.locator('#change-version').click();
    await page.locator('#installation').selectOption('manual');
    await page.locator('#runtime-version').fill('0.152.1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(artifacts, 'desktop-linear-version.png'), fullPage: true });
    await page.waitForFunction(() => document.getElementById('version-choice').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#apply').isDisabled(), false);
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
    await page.locator('#close-version').click();
    assert.equal(await page.locator('#version-choice').isVisible(), false);
    await page.getByRole('checkbox', { name: '保留官方登录' }).check();
    await page.locator('#apply').click();
    await page.waitForFunction(() => !document.getElementById('success').hidden);
    await page.locator('#theme input[value="light"]').check();
    const beforeRestart = fs.readFileSync(file, 'utf8');
    await page.getByRole('button', { name: '完成', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('success').hidden && !document.getElementById('setup-view').hidden);
    assert.equal(page.isClosed(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'apply');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeRestart);
    await electron.close();
    electron = null;
    // A full app restart preserves an explicit choice despite a different OS appearance.
    electron = await _electron.launch({ executablePath: require('electron'), args: [launcher], timeout: 25000 });
    const restarted = await electron.firstWindow();
    await restarted.emulateMedia({ colorScheme: 'dark' });
    await restarted.waitForFunction(() => !document.getElementById('apply').disabled);
    assert.equal(await restarted.locator('#theme input:checked').inputValue(), 'light');
    assert.equal(await restarted.locator('html').getAttribute('data-theme'), 'light');
    assert.equal(await restarted.getByRole('checkbox', { name: '保留官方登录' }).isChecked(), true);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeRestart);
    await restarted.locator('#open-history').click();
    await restarted.waitForFunction(() => document.getElementById('history-page').getAttribute('aria-busy') === 'false');
    assert.equal(await restarted.locator('#configuration-page').isVisible(), false);
    assert.equal(await restarted.locator('#history-title').isVisible(), true);
    await restarted.locator('#back-to-config').click();
    assert.equal(await restarted.locator('#history-page').isVisible(), false);
    assert.equal(await restarted.evaluate(() => document.activeElement.id), 'open-history');
    assert.equal(await restarted.getByRole('checkbox', { name: '保留官方登录' }).isChecked(), true);
    await restarted.locator('#open-history').click();
    await restarted.waitForFunction(() => document.getElementById('history-page').getAttribute('aria-busy') === 'false');
    for (const theme of ['dark', 'light']) {
      await restarted.locator('html').evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await restarted.screenshot({ path: path.join(artifacts, `desktop-history-page-${theme}.png`), animations: 'disabled' });
    }
    const viewBackup = restarted.locator('.backup-actions button').filter({ hasText: '查看' }).first();
    await viewBackup.waitFor();
    const historyRows = await restarted.locator('#backups').textContent();
    assert.equal(historyRows.includes(file), false);
    assert.ok(historyRows.includes('https://api.beiapi.cn/v1'));
    assert.equal(historyRows.includes('Base URL：'), false);
    assert.equal(historyRows.includes('保留官方登录：'), false);
    const historySummary = await restarted.evaluate(async () => (await window.setup.backups()).data);
    assert.equal(await restarted.locator('.backup-login-badge').count(), historySummary.filter(item => item.keepOfficialLogin === true).length);
    const backupCount = fs.readdirSync(path.join(userData, 'backups')).length;
    await viewBackup.click();
    await restarted.waitForFunction(() => document.getElementById('backup-preview').getAttribute('aria-busy') === 'false');
    assert.equal(await restarted.getByRole('dialog', { name: '历史配置' }).isVisible(), true);
    const historyText = await restarted.locator('#backup-preview-code').textContent();
    assert.match(historyText, /\bmodel\s*=/);
    assert.ok(historyText.includes('# Personal tools'));
    assert.ok(historyText.includes('http_headers = {'));
    assert.ok(historyText.includes('\"x-openai-actor-authorization\" = \"https://api.beiapi.cn/v1\"'));
    assert.equal(historyText.includes('[model_providers.custom.http_headers]'), false);
    assert.equal((await restarted.locator('#backup-preview-code').textContent()).includes('sk-fixture-not-a-real-credential'), false);
    assert.equal(await restarted.locator('#backup-preview-path').textContent(), file);
    assert.equal(await restarted.locator('#backup-preview-path').getAttribute('title'), file);
    for (const theme of ['dark', 'light']) {
      await restarted.locator('html').evaluate((element, value) => { element.dataset.theme = value; }, theme);
      await restarted.screenshot({ path: path.join(artifacts, `desktop-history-${theme}.png`), animations: 'disabled' });
    }
    await restarted.keyboard.press('Escape');
    assert.equal(await restarted.locator('#backup-preview').isVisible(), false);
    assert.equal(await viewBackup.evaluate(element => element === document.activeElement), true);
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(460, 460));
    await viewBackup.click();
    await restarted.waitForFunction(() => document.getElementById('backup-preview').getAttribute('aria-busy') === 'false');
    assert.equal(await restarted.locator('#backup-preview').evaluate(element => element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().bottom <= innerHeight), true);
    assert.equal(await restarted.evaluate(() => {
      const date = document.getElementById('backup-preview-date').getBoundingClientRect();
      const file = document.getElementById('backup-preview-path').getBoundingClientRect();
      const remove = document.getElementById('delete-backup').getBoundingClientRect();
      const restore = document.getElementById('restore-backup').getBoundingClientRect();
      return Math.abs(date.top - file.top) < 1 && date.right < file.left && remove.right < restore.left && restore.bottom <= innerHeight;
    }), true);
    await restarted.screenshot({ path: path.join(artifacts, 'desktop-history-compact.png'), animations: 'disabled' });
    await restarted.getByRole('button', { name: '关闭历史配置' }).click();
    await restarted.waitForFunction(() => document.getElementById('backup-preview-code').textContent === '');
    assert.equal(fs.readFileSync(file, 'utf8'), beforeRestart);
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, backupCount);
    // A backup deleted after listing produces a readable error within the dialog.
    const listed = await restarted.evaluate(async () => (await window.setup.backups()).data);
    fs.rmSync(path.join(userData, 'backups', listed[0].id), { recursive: true });
    await viewBackup.click();
    await restarted.waitForFunction(() => document.getElementById('backup-preview').getAttribute('aria-busy') === 'false');
    assert.ok((await restarted.locator('#backup-preview [role="alert"]').textContent()).includes('不存在'));
    assert.equal(await restarted.locator('#backup-preview-code').isVisible(), false);
    assert.equal(await restarted.locator('#restore-backup').isDisabled(), true);
    await restarted.keyboard.press('Escape');
    await restarted.waitForFunction(() => !document.getElementById('backup-preview').open);
    await restarted.locator('#refresh-backups').click();
    await restarted.waitForFunction(() => document.getElementById('configure').getAttribute('aria-busy') === 'false');
    const remaining = await restarted.evaluate(async () => (await window.setup.backups()).data);
    const snapshot = fs.readFileSync(path.join(userData, 'backups', remaining[0].id, 'config.toml'));
    await viewBackup.click();
    await restarted.waitForFunction(() => !document.getElementById('restore-backup').disabled);
    await electron.evaluate(() => { globalThis.__dialogResponse = 0; });
    await restarted.locator('#restore-backup').click();
    await restarted.waitForFunction(() => !document.getElementById('restore-backup').disabled);
    assert.equal(await restarted.locator('#backup-preview').isVisible(), true);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeRestart);
    await electron.evaluate(() => { globalThis.__dialogResponse = 1; });
    await restarted.locator('#restore-backup').click();
    await restarted.waitForFunction(() => !document.getElementById('success').hidden);
    assert.equal(await restarted.locator('#backup-preview').isVisible(), false);
    assert.deepEqual(fs.readFileSync(file), snapshot);
    await restarted.getByRole('button', { name: '完成', exact: true }).click();
    if (!await restarted.locator('#history-page').isVisible()) await restarted.locator('#open-history').click();
    await restarted.waitForFunction(() => document.getElementById('configure').getAttribute('aria-busy') === 'false');
    const beforeDelete = fs.readFileSync(file);
    const deletable = await restarted.evaluate(async () => (await window.setup.backups()).data);
    await viewBackup.click();
    await restarted.waitForFunction(() => !document.getElementById('restore-backup').disabled);
    await electron.evaluate(() => { globalThis.__dialogResponse = 0; });
    await restarted.locator('#delete-backup').click();
    await restarted.waitForFunction(() => !document.getElementById('delete-backup').disabled);
    assert.equal(await restarted.locator('#backup-preview').isVisible(), true);
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, deletable.length);
    await electron.evaluate(() => { globalThis.__dialogResponse = 1; globalThis.__trashFail = true; });
    await restarted.locator('#delete-backup').click();
    await restarted.waitForFunction(() => document.getElementById('backup-preview-status').getAttribute('role') === 'alert');
    assert.equal(await restarted.locator('#backup-preview').isVisible(), true);
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, deletable.length);
    await electron.evaluate(() => { globalThis.__trashFail = false; });
    await restarted.locator('#delete-backup').click();
    await restarted.waitForFunction(() => !document.getElementById('backup-preview').open && document.getElementById('configure').getAttribute('aria-busy') === 'false');
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, deletable.length - 1);
    assert.equal(fs.existsSync(path.join(temporary, 'trash', deletable[0].id, 'metadata.json')), true);
    assert.deepEqual(fs.readFileSync(file), beforeDelete);
    // Actual apply/restore IPC enforces retention after successful writes.
    const applyAgain = () => restarted.evaluate(async () => {
      const plan = await window.setup.prepare(document.getElementById('target').value, 'sk-fixture-not-a-real-credential',
        document.getElementById('base-url').value, document.getElementById('model').value,
        document.getElementById('keep-official-login').checked);
      if (plan.error) throw new Error(plan.error);
      const result = await window.setup.apply(plan.data.id);
      if (result.error) throw new Error(result.error);
      return result.data;
    });
    for (let i = 0; i < 11; i++) {
      const applied = await applyAgain();
      assert.equal(applied.backupWarning, null);
      assert.ok(fs.readdirSync(path.join(userData, 'backups')).length <= 10);
      assert.ok(fs.existsSync(path.join(userData, 'backups', applied.backupId)));
    }
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, 10);
    await electron.evaluate(() => { globalThis.__trashFail = true; });
    const cleanupFailed = await applyAgain();
    assert.ok(cleanupFailed.backupWarning.includes('清理失败'));
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, 11);
    await electron.evaluate(() => { globalThis.__trashFail = false; });
    const cleanupRecovered = await applyAgain();
    assert.equal(cleanupRecovered.backupWarning, null);
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, 10);
    const restoredWithRetention = await restarted.evaluate(async () => {
      const backups = (await window.setup.backups()).data;
      return window.setup.restore(backups[backups.length - 1].id);
    });
    assert.equal(restoredWithRetention.error, undefined);
    assert.equal(restoredWithRetention.data.backupWarning, null);
    assert.equal(fs.readdirSync(path.join(userData, 'backups')).length, 10);
    assert.ok(fs.existsSync(path.join(userData, 'backups', restoredWithRetention.data.backupId)));
  } finally {
    if (electron) await electron.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
