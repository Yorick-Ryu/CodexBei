const $ = (id) => document.getElementById(id);
let planId;
let busy = false;
let incomingQueued = false;
let templateState;
let queuedTemplate;
let appliedDigest;
let versionCheckPending = false;
let versionCheckQueued = false;
let versionCheckTimer;
let modelRequest = 0;
let modelTimer;
let modelsLoading = false;

function selectModel(value) {
  if (![...$('model').options].some((option) => option.value === value)) $('model').add(new Option(value, value));
  $('model').value = value;
}

function renderModels(models) {
  const current = $('model').value;
  $('model').replaceChildren(...models.map((model) => new Option(model, model)));
  if (current) selectModel(current);
}

function modelMessage(message = '') {
  $('models-help').textContent = message;
  $('models-help').hidden = !message;
}

async function loadModels() {
  clearTimeout(modelTimer);
  const request = ++modelRequest;
  modelsLoading = true;
  $('refresh-models').disabled = true;
  $('model').setAttribute('aria-busy', 'true');
  modelMessage('正在获取可用模型…');
  try {
    const result = await call('models', $('target').value, $('key').value, $('base-url').value);
    if (request !== modelRequest) return;
    if (result.error) throw new Error(result.error);
    renderModels(result.models);
    modelMessage(!result.models.length ? '此密钥暂无可用模型，已保留当前选择。' :
      !result.models.includes($('model').value) ? '当前模型不在可用列表中，可选择其他模型。' : '');
  } catch (error) {
    if (request === modelRequest) modelMessage(error.message);
  } finally {
    if (request === modelRequest) {
      modelsLoading = false;
      $('refresh-models').disabled = busy;
      $('model').setAttribute('aria-busy', 'false');
    }
  }
}

function resetModels() {
  ++modelRequest;
  clearTimeout(modelTimer);
  modelsLoading = false;
  renderModels([]);
  modelMessage();
  $('model').setAttribute('aria-busy', 'false');
  $('refresh-models').disabled = busy;
  if ($('settings').open) modelTimer = setTimeout(loadModels, 600);
}

async function call(name, ...args) {
  const result = await window.setup[name](...args);
  if (result.error) throw new Error(result.error);
  return result.data;
}

function status(message = '', error = false) {
  $('status').textContent = message;
  $('status').className = error ? 'error' : '';
}

function invalidate() {
  planId = undefined;
  $('preview').hidden = true;
  $('preview-code').textContent = '';
}

function syncKeyControls(reset = false) {
  const empty = !$('key').value;
  if (reset || empty) $('key').type = 'password';
  const visible = $('key').type === 'text';
  $('toggle-key').setAttribute('aria-pressed', String(visible));
  $('toggle-key').setAttribute('aria-label', visible ? '隐藏密钥' : '显示密钥');
  $('toggle-key').title = visible ? '隐藏密钥' : '显示密钥';
  $('toggle-key').disabled = busy || empty;
  $('clear-key').disabled = busy || empty;
}

function showSuccess(title) {
  $('key').value = '';
  syncKeyControls(true);
  $('imported').hidden = true;
  $('setup-view').hidden = true;
  $('success').hidden = false;
  $('success-title').textContent = title;
  $('history').open = false;
  status();
  $('success-title').focus();
}

function showTemplate(data) {
  if (data.template?.digest === appliedDigest) data = { ...data, updateAvailable: false };
  if (templateState?.template?.digest !== data.template?.digest) invalidate();
  templateState = data;
  $('config-state').textContent = data.needsSelection ? '需选择版本' : data.connection?.hasKey ? '已有配置' : '待配置';
  $('config-state').hidden = Boolean(data.updateAvailable && !data.needsSelection);
  $('config-state').dataset.state = data.connection?.hasKey ? 'configured' : 'pending';
  $('apply').textContent = data.updateAvailable ? '更新配置' : '一键配置';
  $('apply').disabled = versionCheckPending || !data.template;
  $('preview-button').disabled = versionCheckPending || !data.template;
  $('template-notice').textContent = data.needsSelection ? '请选择 Codex 版本' : data.cached && !data.updateAvailable ? '离线配置已就绪' : '';
  $('template-notice').hidden = !$('template-notice').textContent;
  if (data.needsSelection) showVersionChoice(true);
  const current = $('installation').value;
  $('installation').replaceChildren(new Option('自动匹配', 'auto'));
  for (const item of data.installations) {
    const name = item.kind === 'cli' ? 'Codex CLI' : 'Codex 桌面版';
    $('installation').add(new Option(`${name} · ${item.runtimeVersion ?? '版本未知'}`, item.id));
  }
  $('installation').add(new Option('手动输入版本', 'manual'));
  if ([...$('installation').options].some((item) => item.value === current)) $('installation').value = current;
  $('version-info').textContent = data.installations.map((item) =>
    `${item.kind === 'cli' ? 'CLI' : '桌面版'} ${item.appDisplayVersion ? item.appDisplayVersion + ' · 内核 ' : ''}${item.runtimeVersion ?? '未知'}`
  ).join(' / ');
  if (data.updateAvailable && !$('success').hidden) {
    $('success').hidden = true;
    $('setup-view').hidden = false;
  }
}

async function loadExisting() {
  const { connection, template } = await call('inspect', $('target').value);
  appliedDigest = template?.digest;
  $('key').required = !connection?.hasKey;
  $('key').placeholder = connection?.hasKey ? '已配置密钥' : '粘贴密钥';
  $('key-help').textContent = connection?.hasKey ? '留空保留现有密钥，填入可替换。' : '使用你在 BeiAPI 创建的密钥。';
  if (connection) {
    $('base-url').value = connection.baseUrl;
    selectModel(connection.model);
  }
  resetModels();
}

async function loadIncoming() {
  incomingQueued = false;
  const incoming = await call('incoming');
  if (!incoming) return;
  invalidate();
  $('key').value = '';
  syncKeyControls(true);
  $('imported').hidden = true;
  $('setup-view').hidden = false;
  $('success').hidden = true;
  if (incoming.error) { status('链接无效，请从官网重新打开。', true); return; }
  $('base-url').value = incoming.connection.baseUrl;
  selectModel(incoming.connection.model);
  $('key').value = incoming.connection.apiKey;
  syncKeyControls(true);
  $('imported').hidden = false;
  $('settings').open = false;
  resetModels();
  status();
}

function scheduleIncoming() {
  incomingQueued = true;
  if (!busy) void run(loadIncoming);
}

async function run(action) {
  if (busy) return;
  busy = true;
  $('configure').setAttribute('aria-busy', 'true');
  document.querySelectorAll('button:not([role="tab"]), input:not([name="appearance"]), select').forEach((element) => { element.disabled = true; });
  try { await action(); }
  catch (error) { status(error.message, true); }
  finally {
    busy = false;
    $('configure').setAttribute('aria-busy', 'false');
    $('apply').textContent = templateState?.updateAvailable ? '更新配置' : '一键配置';
    document.querySelectorAll('button:not([role="tab"]), input:not([name="appearance"]), select').forEach((element) => { element.disabled = false; });
    if (queuedTemplate) { showTemplate(queuedTemplate); queuedTemplate = undefined; }
    $('apply').disabled = versionCheckPending || !templateState?.template;
    $('preview-button').disabled = versionCheckPending || !templateState?.template;
    syncKeyControls();
    $('refresh-models').disabled = modelsLoading;
    if (incomingQueued) scheduleIncoming();
    else if (versionCheckQueued && !versionCheckTimer) matchVersion();
  }
}

async function loadBackups() {
  const backups = await call('backups');
  $('backups').replaceChildren();
  if (!backups.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '暂无备份';
    $('backups').append(empty);
  }
  backups.forEach((backup) => {
    const row = document.createElement('div');
    row.className = 'backup';
    const text = document.createElement('div');
    const title = document.createElement('p');
    title.textContent = new Date(backup.created).toLocaleString();
    const file = document.createElement('p');
    file.className = 'backup-path';
    file.textContent = backup.file;
    text.append(title, file);
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = '还原';
    button.setAttribute('aria-label', `还原 ${title.textContent}`);
    button.addEventListener('click', () => run(async () => {
      const result = await call('restore', backup.id);
      if (!result) return;
      invalidate();
      showSuccess('已还原');
      await loadExisting();
      showTemplate(await call('check', $('target').value));
      await loadBackups();
    }));
    row.append(text, button);
    $('backups').append(row);
  });
}

$('toggle-key').addEventListener('click', () => {
  $('key').type = $('key').type === 'password' ? 'text' : 'password';
  syncKeyControls();
});
$('clear-key').addEventListener('click', () => {
  $('key').value = '';
  $('key').dispatchEvent(new Event('input', { bubbles: true }));
  $('key').focus();
});
$('key').addEventListener('input', () => {
  syncKeyControls();
  resetModels();
  invalidate();
  $('imported').hidden = true;
  status();
});
$('base-url').addEventListener('input', () => {
  resetModels();
  invalidate();
  status();
});
$('model').addEventListener('input', () => { invalidate(); status(); });
$('refresh-models').addEventListener('click', loadModels);
$('settings').addEventListener('toggle', () => {
  if ($('settings').open) void loadModels();
  else clearTimeout(modelTimer);
});
$('model').addEventListener('invalid', () => { $('settings').open = true; });
$('target').addEventListener('change', () => run(async () => {
  invalidate(); status(); await loadExisting(); showTemplate(await call('check', $('target').value));
}));
$('base-url').addEventListener('invalid', () => { $('settings').open = true; });
$('target').addEventListener('invalid', () => { $('settings').open = true; });
$('website').addEventListener('click', () => run(() => call('website')));
$('done').addEventListener('click', () => run(() => call('close')));
$('history').addEventListener('toggle', () => {
  if ($('history').open) void run(loadBackups);
});
$('choose').addEventListener('click', () => run(async () => {
  const file = await call('choose');
  if (!file) return;
  invalidate();
  if (![...$('target').options].some((option) => option.value === file)) $('target').add(new Option(file, file));
  $('target').value = file;
  await loadExisting();
  showTemplate(await call('check', file));
}));
function showVersionChoice(open) {
  $('version-choice').hidden = !open;
  $('change-version').setAttribute('aria-expanded', String(open));
}
$('change-version').addEventListener('click', () => {
  showVersionChoice($('version-choice').hidden);
  if (!$('version-choice').hidden) $('installation').focus();
});
function matchVersion() {
  if (busy || !versionCheckQueued) return;
  versionCheckQueued = false;
  let selection = { mode: 'auto' };
  if ($('installation').value === 'manual') {
    const runtimeVersion = $('runtime-version').value.trim();
    if (!runtimeVersion) { $('version-choice').setAttribute('aria-busy', 'false'); status('请输入 Codex 内核版本。'); return; }
    selection = { mode: 'manual', kind: $('codex-kind').value, runtimeVersion, appVersion: $('app-version').value.trim() };
  } else if ($('installation').value !== 'auto') selection = { mode: 'installed', id: $('installation').value };
  void run(async () => {
    status();
    try {
      const data = await call('check', $('target').value, selection);
      versionCheckPending = false;
      showTemplate(data);
    } finally { $('version-choice').setAttribute('aria-busy', 'false'); }
  });
}
function scheduleVersionCheck(delay = 0) {
  clearTimeout(versionCheckTimer);
  versionCheckTimer = undefined;
  invalidate();
  status();
  versionCheckPending = true;
  versionCheckQueued = true;
  $('version-choice').setAttribute('aria-busy', 'true');
  $('apply').disabled = true;
  $('preview-button').disabled = true;
  if (delay) versionCheckTimer = setTimeout(() => {
    versionCheckTimer = undefined;
    matchVersion();
  }, delay);
  else matchVersion();
}
$('installation').addEventListener('change', () => {
  $('manual-version').hidden = $('installation').value !== 'manual';
  scheduleVersionCheck();
});
$('codex-kind').addEventListener('change', () => scheduleVersionCheck());
for (const id of ['runtime-version', 'app-version']) {
  $(id).addEventListener('input', () => scheduleVersionCheck(400));
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); scheduleVersionCheck(); }
  });
}
$('preview-button').addEventListener('click', () => {
  if (versionCheckPending || !templateState?.template) return;
  if (!$('configure').reportValidity()) return;
  void run(async () => {
    invalidate();
    const plan = await call('prepare', $('target').value, $('key').value, $('base-url').value, $('model').value);
    planId = plan.id;
    $('preview-code').textContent = plan.preview;
    $('preview').hidden = false;
    status();
  });
});
$('configure').addEventListener('submit', (event) => {
  event.preventDefault();
  if (versionCheckPending || !templateState?.template) return;
  void run(async () => {
    $('apply').textContent = '正在配置…';
    status();
    // Explicit button click prepares and applies; receiving a link only fills the form.
    const id = planId ?? (await call('prepare', $('target').value, $('key').value, $('base-url').value, $('model').value)).id;
    invalidate();
    try { await call('apply', id); }
    catch (error) { invalidate(); throw error; }
    if (templateState) { templateState.updateAvailable = false; }
    showSuccess('配置完成');
    await loadExisting();
    await loadBackups();
  });
});

window.setup.onIncoming(scheduleIncoming);
window.setup.onTemplates((data) => {
  if (busy) queuedTemplate = data;
  else showTemplate(data);
});
void run(async () => {
  const { candidates, platform } = await call('detect');
  document.body.dataset.platform = platform;
  candidates.forEach((candidate) => $('target').add(new Option(candidate.file, candidate.file)));
  await loadBackups();
  await loadExisting();
  await loadIncoming();
  showTemplate(await call('check', $('target').value));
});
