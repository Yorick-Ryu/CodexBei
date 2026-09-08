const $ = (id) => document.getElementById(id);
let previewRequest = 0;
let previewTimer;
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
let configurationScroll = 0;

function showConfiguration(restoreFocus = false) {
  const wasHistory = !$('history-page').hidden;
  $('history-page').hidden = true;
  $('configuration-page').hidden = false;
  if (wasHistory) window.scrollTo(0, configurationScroll);
  if (restoreFocus) $('open-history').focus({ preventScroll: true });
}

function selectModel(value) {
  if (![...$('model').options].some((option) => option.value === value)) $('model').add(new Option(value, value));
  $('model').value = value;
}

function renderModels(models, preserveCurrent = false) {
  const current = $('model').value;
  $('model').replaceChildren(...models.map((model) => new Option(model, model)));
  if (preserveCurrent && current) selectModel(current);
  else if (models.includes(current)) $('model').value = current;
  else if (models.includes('gpt-6-astra')) $('model').value = 'gpt-6-astra';
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
    invalidate();
    modelMessage(!result.models.length ? '此密钥暂无可用的 ChatGPT 模型。' : '');
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
  renderModels([], true);
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
  $('version-status').textContent = $('version-choice').open ? message : '';
  $('version-status').className = error ? 'version-status error' : 'version-status';
  $('version-status').hidden = !$('version-status').textContent;
}

function invalidate() {
  ++previewRequest;
  clearTimeout(previewTimer);
  if (templateState?.template && !versionCheckPending) previewTimer = setTimeout(refreshPreview, 150);
}

async function refreshPreview() {
  const request = ++previewRequest;
  if (!templateState?.template || versionCheckPending) return;
  try {
    const result = await call('preview', $('base-url').value, $('model').value, $('keep-official-login').checked);
    if (request !== previewRequest) return;
    renderTemplateVersions();
    if ($('preview-code').textContent !== result.preview) $('preview-code').textContent = result.preview;
  } catch {
    if (request === previewRequest) $('preview-code').textContent = '';
  }
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
  showConfiguration();
  status();
  $('success-title').focus();
}

function hasTemplateUpdate() {
  return Boolean(templateState?.templateUpdateAvailable);
}

function renderTemplateVersions() {
  const current = templateState?.template?.version ? `v${templateState.template.version}` : '未获取';
  const latest = templateState?.latestTemplate?.version ? `v${templateState.latestTemplate.version}` : '未获取';
  const cached = templateState?.template && templateState.cached ? '（缓存）' : '';
  $('preview-version').textContent = `配置模板：当前 ${current} · 最新 ${latest}${cached}`;
  const available = hasTemplateUpdate();
  $('template-update-dot').hidden = !available;
  $('update-template').disabled = busy || versionCheckPending || !available;
  $('update-template').setAttribute('aria-label', available ? '更新配置模板，有可用更新' : '更新配置模板');
  $('update-template').title = available ? '更新配置模板与预览' : '暂无可用的配置模板更新';
}

function showTemplate(data) {
  const modelVersionChanged = templateState?.modelClientVersion !== data.modelClientVersion;
  if (data.template?.digest === appliedDigest) data = { ...data, updateAvailable: false };
  templateState = data;
  if (modelVersionChanged) resetModels();
  invalidate();
  renderTemplateVersions();
  $('apply').textContent = data.updateAvailable ? '更新配置' : '一键配置';
  $('apply').disabled = versionCheckPending || !data.template;
  $('template-notice').textContent = data.needsSelection ? '请选择 ChatGPT 版本' : data.cached && !data.updateAvailable ? '离线配置已就绪' : '';
  $('template-notice').hidden = !$('template-notice').textContent;
  if (data.needsSelection) showVersionChoice(true);
  const current = $('installation').value;
  $('installation').replaceChildren(new Option('自动匹配', 'auto'));
  for (const item of data.installations) {
    const name = item.kind === 'cli' ? 'CLI' : 'ChatGPT 桌面版';
    $('installation').add(new Option(`${name} · ${item.runtimeVersion ?? '版本未知'}`, item.id));
  }
  $('installation').add(new Option('手动输入版本', 'manual'));
  if ([...$('installation').options].some((item) => item.value === current)) $('installation').value = current;
  $('version-info').textContent = data.installations.map((item) =>
    `${item.kind === 'cli' ? 'CLI' : '桌面版'} ${item.appDisplayVersion ? item.appDisplayVersion + ' · 内核 ' : ''}${item.runtimeVersion ?? '未知'}`
  ).join(' / ');
  if ((data.updateAvailable || data.templateUpdateAvailable) && !$('success').hidden) {
    $('success').hidden = true;
    $('setup-view').hidden = false;
  }
}

async function loadExisting() {
  const { connection, template, keepOfficialLogin } = await call('inspect', $('target').value);
  $('keep-official-login').checked = keepOfficialLogin === true;
  appliedDigest = template?.digest;
  renderTemplateVersions();
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
  showVersionChoice(false);
  if ($('backup-preview').open) $('backup-preview').close();
  showConfiguration();
  clearTimeout(versionCheckTimer);
  versionCheckTimer = undefined;
  versionCheckQueued = false;
  versionCheckPending = false;
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
  $('apply').textContent = '正在配置…';
  const result = await call('configureIncoming', $('target').value, incoming.revision, $('keep-official-login').checked);
  if (incomingQueued) return;
  await completeConfiguration(result);
}

function scheduleIncoming() {
  incomingQueued = true;
  if (!busy) void run(loadIncoming);
}

async function run(action) {
  if (busy) return;
  busy = true;
  $('configure').setAttribute('aria-busy', 'true');
  $('history-page').setAttribute('aria-busy', 'true');
  document.querySelectorAll('button:not([role="tab"]):not(#close-version):not(#close-backup), input:not([name="appearance"]), select').forEach((element) => { element.disabled = true; });
  try { await action(); }
  catch (error) { status(error.message, true); }
  finally {
    busy = false;
    $('configure').setAttribute('aria-busy', 'false');
    $('history-page').setAttribute('aria-busy', 'false');
    $('apply').textContent = templateState?.updateAvailable ? '更新配置' : '一键配置';
    document.querySelectorAll('button:not([role="tab"]):not(#close-version):not(#close-backup), input:not([name="appearance"]), select').forEach((element) => { element.disabled = false; });
    if (queuedTemplate) { showTemplate(queuedTemplate); queuedTemplate = undefined; }
    $('apply').disabled = versionCheckPending || !templateState?.template;
    renderTemplateVersions();
    syncKeyControls();
    syncBackupActions();
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
    const heading = document.createElement('div');
    heading.className = 'backup-heading';
    heading.append(title);
    if (backup.baseUrl) {
      const baseUrl = document.createElement('p');
      baseUrl.className = 'backup-detail';
      baseUrl.textContent = backup.baseUrl;
      heading.append(baseUrl);
    }
    if (backup.keepOfficialLogin === true) {
      const badge = document.createElement('span');
      badge.className = 'backup-login-badge';
      badge.textContent = '保留官方登录';
      heading.append(badge);
    }
    text.append(heading);
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = '还原';
    button.setAttribute('aria-label', `还原 ${title.textContent}`);
    button.addEventListener('click', () => run(() => restoreBackup(backup.id)));
    const view = document.createElement('button');
    view.type = 'button';
    view.className = 'secondary';
    view.textContent = '查看';
    view.setAttribute('aria-label', `查看 ${title.textContent}`);
    view.setAttribute('aria-haspopup', 'dialog');
    view.setAttribute('aria-controls', 'backup-preview');
    view.addEventListener('click', () => { if (!busy) void viewBackup(backup); });
    const actions = document.createElement('div');
    actions.className = 'backup-actions';
    actions.append(view, button);
    row.append(text, actions);
    $('backups').append(row);
  });
}

async function restoreBackup(id) {
  const result = await call('restore', id);
  if (!result) return;
  if ($('backup-preview').open) $('backup-preview').close();
  invalidate();
  showSuccess('已还原');
  await loadExisting();
  showTemplate(await call('check', $('target').value));
  await loadBackups();
  if (result.backupWarning) status(result.backupWarning, true);
}

let backupPreviewRequest = 0;
let selectedBackup = null;
let backupPreviewReady = false;
function syncBackupActions() {
  $('restore-backup').disabled = busy || !selectedBackup || !backupPreviewReady;
  $('delete-backup').disabled = busy || !selectedBackup;
}
function backupError(error) {
  $('backup-preview-status').setAttribute('role', 'alert');
  $('backup-preview-status').textContent = error.message;
}
$('restore-backup').addEventListener('click', () => {
  if (!selectedBackup || !backupPreviewReady) return;
  const id = selectedBackup.id;
  void run(async () => {
    try { await restoreBackup(id); } catch (error) { backupError(error); }
  });
});
$('delete-backup').addEventListener('click', () => {
  if (!selectedBackup) return;
  const id = selectedBackup.id;
  void run(async () => {
    try {
      const result = await call('deleteBackup', id);
      if (!result) return;
      $('backup-preview').close();
      await loadBackups();
      $('history-title').focus();
    } catch (error) { backupError(error); }
  });
});
async function viewBackup(backup) {
  const request = ++backupPreviewRequest;
  selectedBackup = backup;
  backupPreviewReady = false;
  syncBackupActions();
  const dialog = $('backup-preview');
  $('backup-preview-date').textContent = new Date(backup.created).toLocaleString();
  $('backup-preview-path').textContent = backup.file;
  $('backup-preview-path').title = backup.file;
  $('backup-preview-code').textContent = '';
  $('backup-preview-code').hidden = true;
  $('backup-preview-status').textContent = '正在读取备份…';
  $('backup-preview-status').setAttribute('role', 'status');
  dialog.setAttribute('aria-busy', 'true');
  dialog.showModal();
  $('close-backup').focus();
  try {
    const data = await call('backupPreview', backup.id);
    if (request !== backupPreviewRequest || !dialog.open) return;
    $('backup-preview-status').textContent = data.existed ? (data.content ? '' : '此备份的配置内容为空。') : '此备份记录的是配置文件尚未创建的状态。';
    $('backup-preview-code').textContent = data.content;
    $('backup-preview-code').hidden = !data.content;
    backupPreviewReady = true;
    syncBackupActions();
  } catch (error) {
    if (request !== backupPreviewRequest || !dialog.open) return;
    $('backup-preview-status').setAttribute('role', 'alert');
    $('backup-preview-status').textContent = error.message;
  } finally {
    if (request === backupPreviewRequest) dialog.setAttribute('aria-busy', 'false');
  }
}
$('close-backup').addEventListener('click', () => $('backup-preview').close());
$('backup-preview').addEventListener('close', () => {
  ++backupPreviewRequest;
  selectedBackup = null;
  backupPreviewReady = false;
  syncBackupActions();
  $('backup-preview-code').textContent = '';
  $('backup-preview').setAttribute('aria-busy', 'false');
});
$('backup-preview').addEventListener('click', (event) => {
  const dialog = $('backup-preview');
  const rect = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
});

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
$('keep-official-login').addEventListener('change', () => { invalidate(); status(); });
$('refresh-models').addEventListener('click', loadModels);
$('settings').addEventListener('toggle', () => {
  if ($('settings').open) { void loadModels(); invalidate(); }
  else clearTimeout(modelTimer);
});
$('model').addEventListener('invalid', () => { $('settings').open = true; });
$('target').addEventListener('change', () => run(async () => {
  invalidate(); status(); await loadExisting(); showTemplate(await call('check', $('target').value));
}));
$('base-url').addEventListener('invalid', () => { $('settings').open = true; });
$('target').addEventListener('invalid', () => { $('settings').open = true; });
$('done').addEventListener('click', () => {
  $('success').hidden = true;
  $('setup-view').hidden = false;
  status();
  $('apply').focus();
});
$('open-history').addEventListener('click', () => {
  if (busy) return;
  configurationScroll = window.scrollY;
  $('configuration-page').hidden = true;
  $('history-page').hidden = false;
  window.scrollTo(0, 0);
  $('history-title').focus();
  status();
  void run(loadBackups);
});
$('back-to-config').addEventListener('click', () => {
  status();
  showConfiguration(true);
});
$('refresh-backups').addEventListener('click', () => {
  status();
  void run(loadBackups);
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
  const dialog = $('version-choice');
  if (open && !dialog.open) {
    dialog.showModal();
    $('version-status').hidden = true;
    $('installation').focus();
  } else if (!open && dialog.open) dialog.close();
  $('change-version').setAttribute('aria-expanded', String(dialog.open));
}
$('change-version').addEventListener('click', () => showVersionChoice(true));
$('close-version').addEventListener('click', () => showVersionChoice(false));
$('version-choice').addEventListener('close', () => {
  $('change-version').setAttribute('aria-expanded', 'false');
});
$('version-choice').addEventListener('click', (event) => {
  const rect = $('version-choice').getBoundingClientRect();
  if (event.target === $('version-choice') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) showVersionChoice(false);
});
function matchVersion() {
  if (busy || !versionCheckQueued) return;
  versionCheckQueued = false;
  let selection = { mode: 'auto' };
  if ($('installation').value === 'manual') {
    const runtimeVersion = $('runtime-version').value.trim();
    if (!runtimeVersion) { $('version-choice').setAttribute('aria-busy', 'false'); status('请输入内核版本。'); return; }
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
  renderTemplateVersions();
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
$('update-template').addEventListener('click', () => {
  if (busy || versionCheckPending || !hasTemplateUpdate()) return;
  void run(async () => {
    status();
    showTemplate(await call('updateTemplate', $('target').value));
    await refreshPreview();
    status('配置模板已更新');
  });
});
$('configure').addEventListener('submit', (event) => {
  event.preventDefault();
  if (versionCheckPending || !templateState?.template) return;
  void run(async () => {
    $('apply').textContent = '正在配置…';
    status();
    // Manual setup uses the same backup and merge behavior as an automatic website handoff.
    const id = (await call('prepare', $('target').value, $('key').value, $('base-url').value, $('model').value, $('keep-official-login').checked)).id;
    invalidate();
    let result;
    try { result = await call('apply', id); }
    catch (error) { invalidate(); throw error; }
    await completeConfiguration(result);
  });
});

async function completeConfiguration(result) {
  if (templateState) templateState.updateAvailable = false;
  await loadExisting();
  if (result.configuration) showTemplate(result.configuration);
  showSuccess('配置完成');
  await loadBackups();
  if (result.backupWarning) status(result.backupWarning, true);
}

window.setup.onIncoming(scheduleIncoming);
window.setup.onTemplates((data) => {
  if (busy) queuedTemplate = data;
  else showTemplate(data);
});
void run(async () => {
  const { candidates, platform, backupWarning } = await call('detect');
  document.body.dataset.platform = platform;
  candidates.forEach((candidate) => $('target').add(new Option(candidate.file, candidate.file)));
  await loadBackups();
  await loadExisting();
  showTemplate(await call('check', $('target').value));
  await loadIncoming();
  if (backupWarning) status(backupWarning, true);
});
