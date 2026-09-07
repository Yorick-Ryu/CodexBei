const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const TOML = require('@iarna/toml');
const { patchPreset } = require('./toml-patch.cjs');
const { formatPreset } = require('./format-preset.cjs');
const { normalizeBaseUrl, validateKey, validateModel } = require('./deep-link.cjs');
const { materialize, templateDigest } = require('./template-policy.cjs');
const bootstrap = require('./bootstrap-manifest.json');

const BASE_URL = 'https://api.beiapi.cn/v1';
const MODEL = 'gpt-6-astra';
const digest = (bytes) => createHash('sha256').update(bytes === null ? 'missing' : Buffer.concat([Buffer.from('file:'), bytes])).digest('hex');

function readConfig(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('配置必须是普通文件，暂不支持符号链接或硬链接。');
    if (stat.size > 2 * 1024 * 1024) throw new Error('配置文件超过 2 MB，请手动检查。');
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function parseConfig(bytes) {
  if (bytes === null) return {};
  try { return TOML.parse(bytes.toString('utf8')); }
  catch { throw new Error('配置不是有效的 TOML，未修改任何配置。请先修复原文件。'); }
}

function preset(apiKey, baseUrl = BASE_URL, model = MODEL, template = bootstrap.templates[0]) {
  return materialize(template, { apiKey, baseUrl, model });
}

// Exclusive temporary file + fsync + rename keeps the previous file intact on failure.
function atomicWrite(file, bytes, mode = 0o600) {
  const temp = path.join(path.dirname(file), `.codexbei-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

class ConfigStore {
  constructor({ backupDir, home = os.homedir(), env = process.env, write = atomicWrite }) {
    this.backupDir = backupDir;
    this.home = home;
    this.env = env;
    this.write = write;
    this.plans = new Map();
  }

  detect() {
    const folders = [...new Set([this.env.CODEX_HOME, path.join(this.home, '.codex')].filter(Boolean))];
    return folders.map((folder, index) => {
      const file = path.resolve(folder, 'config.toml');
      return { file, source: index === 0 && this.env.CODEX_HOME ? 'CODEX_HOME' : '默认目录', exists: fs.existsSync(file) };
    });
  }

  target(file) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || (path.basename(file) !== 'config.toml' && !/^[\w-]+\.config\.toml$/.test(path.basename(file)))) {
      throw new Error('请选择 Codex 的 config.toml 或配置档案 .config.toml 文件。');
    }
    const parent = path.dirname(file);
    if (fs.existsSync(parent)) return path.join(fs.realpathSync(parent), path.basename(file));
    // Automatic creation is restricted to the detected Codex directory.
    const detected = this.detect().some((candidate) => {
      if (candidate.file === file) return true;
      const candidateParent = path.dirname(candidate.file);
      try {
        return path.join(fs.realpathSync(path.dirname(candidateParent)), path.basename(candidateParent), 'config.toml') === file;
      } catch { return false; }
    });
    if (!detected) throw new Error('选择的配置目录不存在。');
    const ancestor = path.dirname(parent);
    if (!fs.existsSync(ancestor)) throw new Error('CODEX_HOME 的上级目录不存在，请先选择正确目录。');
    return path.join(fs.realpathSync(ancestor), path.basename(parent), path.basename(file));
  }

  inspect(file) {
    const target = this.target(file);
    const parsed = parseConfig(readConfig(target));
    let connection = null;
    if (parsed.model_provider === 'custom') {
      try {
        validateKey(parsed.model_providers?.custom?.experimental_bearer_token);
        connection = { baseUrl: normalizeBaseUrl(parsed.model_providers.custom.base_url), model: validateModel(parsed.model), hasKey: true };
      } catch { /* An incomplete configuration still needs the user's connection details. */ }
    }
    const latest = this.list().find((item) => item.file === target);
    const metadata = latest ? this.loadBackup(latest.id).metadata : null;
    return { connection, template: metadata?.kind === 'configure' ? metadata.template ?? null : null };
  }

  modelCredentials(file, key, baseUrl = BASE_URL) {
    const endpoint = normalizeBaseUrl(baseUrl);
    if (key) return { baseUrl: endpoint, apiKey: validateKey(key) };
    const parsed = parseConfig(readConfig(this.target(file)));
    const provider = parsed.model_provider === 'custom' ? parsed.model_providers?.custom : null;
    if (!provider?.experimental_bearer_token) throw new Error('请先填写 API 密钥，再获取可用模型。');
    // A saved key belongs to its existing gateway; never send it to a newly entered address.
    if (normalizeBaseUrl(provider.base_url) !== endpoint) throw new Error('API 地址已更改，请填写对应密钥后获取模型。');
    return { baseUrl: endpoint, apiKey: validateKey(provider.experimental_bearer_token) };
  }

  prepare(file, key, baseUrl = BASE_URL, selectedModel = MODEL, template = bootstrap.templates[0]) {
    const endpoint = normalizeBaseUrl(baseUrl);
    const model = validateModel(selectedModel);
    const target = this.target(file);
    const before = readConfig(target);
    const parsed = parseConfig(before);
    // Updating an already configured file reuses its key in main, never sending it to the renderer or remote.
    const apiKey = validateKey(key || (parsed.model_provider === 'custom' ? parsed.model_providers?.custom?.experimental_bearer_token : null));
    if (parsed.profile) throw new Error('检测到默认 profile。请先选择该 profile 的 .config.toml 文件；旧式内嵌 profile 需先手动整理，避免写入后不生效。');
    if (parsed.model_providers && (typeof parsed.model_providers !== 'object' || Array.isArray(parsed.model_providers))) throw new Error('model_providers 必须是 TOML 表。');
    const recommended = preset(apiKey, endpoint, model, template);
    const patch = patchPreset(before?.toString('utf8') ?? '', recommended, template.remove);
    const after = Buffer.from(patch.text);
    parseConfig(after);
    const id = randomUUID();
    this.plans.clear();
    const policy = { id: template.id, version: template.version, digest: templateDigest(template) };
    this.plans.set(id, { target, before, after, created: Date.now(), template: policy });
    return {
      id, file: target, existing: before !== null,
      replacesProvider: Boolean(parsed.model_providers?.custom),
      changes: patch.changes,
      // Preview only our public preset; existing MCP/environment secrets never leave main.
      template: policy,
      preview: formatPreset(preset('sk-••••••••（你的密钥）', endpoint, model, template)) +
        (template.remove.length ? '\n# 删除指定字段：\n' + template.remove.map((parts) => '# ' + parts.join('.')).join('\n') : ''),
    };
  }

  snapshot(target, before, after, kind, template) {
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.backupDir).isSymbolicLink()) throw new Error('备份目录不能是符号链接。');
    const id = randomUUID();
    const folder = path.join(this.backupDir, id);
    fs.mkdirSync(folder, { mode: 0o700 });
    const metadata = {
      id, target, kind, created: new Date().toISOString(), existed: before !== null,
      beforeHash: digest(before), afterHash: digest(after),
      mode: before === null ? 0o600 : fs.statSync(target).mode & 0o777,
      ...(template ? { template } : {}),
    };
    if (before !== null) this.write(path.join(folder, 'config.toml'), before);
    this.write(path.join(folder, 'metadata.json'), Buffer.from(JSON.stringify(metadata)));
    return metadata;
  }

  apply(id) {
    const plan = this.plans.get(id);
    this.plans.delete(id);
    if (!plan || Date.now() - plan.created > 10 * 60 * 1000) throw new Error('预览已过期，请重新预览配置。');
    if (this.target(plan.target) !== plan.target || digest(readConfig(plan.target)) !== digest(plan.before)) throw new Error('原文件在预览后发生变化，请重新预览。');
    fs.mkdirSync(path.dirname(plan.target), { recursive: true, mode: 0o700 });
    const backup = this.snapshot(plan.target, plan.before, plan.after, 'configure', plan.template);
    // Check again after backup creation in case an external editor wrote the file.
    if (digest(readConfig(plan.target)) !== digest(plan.before)) throw new Error('配置在备份期间发生变化，已停止写入。');
    this.write(plan.target, plan.after);
    if (digest(readConfig(plan.target)) !== digest(plan.after)) throw new Error('写入后校验失败，请从备份还原。');
    return { file: plan.target, backupId: backup.id };
  }

  loadBackup(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的备份编号。');
    const folder = path.join(this.backupDir, id);
    if (!fs.existsSync(folder) || fs.lstatSync(folder).isSymbolicLink()) throw new Error('备份不存在或不可读取。');
    const metadata = JSON.parse(readConfig(path.join(folder, 'metadata.json'))?.toString('utf8') ?? '{}');
    if (metadata.id !== id || typeof metadata.existed !== 'boolean' || !['configure', 'restore'].includes(metadata.kind)) throw new Error('备份记录损坏。');
    const bytes = metadata.existed ? readConfig(path.join(folder, 'config.toml')) : null;
    if ((metadata.existed && bytes === null) || digest(bytes) !== metadata.beforeHash) throw new Error('备份校验失败，已停止还原。');
    return { metadata, bytes };
  }

  list() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).flatMap((id) => {
      try {
        const { metadata } = this.loadBackup(id);
        return [{ id, file: metadata.target, created: metadata.created, kind: metadata.kind }];
      } catch { return []; }
    }).sort((a, b) => b.created.localeCompare(a.created));
  }

  inspectRestore(id) {
    const { metadata } = this.loadBackup(id);
    const target = this.target(metadata.target);
    if (target !== metadata.target) throw new Error('备份对应目录已改变，已停止还原。');
    const currentHash = digest(readConfig(target));
    return { file: target, changed: currentHash !== metadata.afterHash, currentHash };
  }

  restore(id, expectedHash) {
    const { metadata, bytes } = this.loadBackup(id);
    const state = this.inspectRestore(id);
    const before = readConfig(state.file);
    if (digest(before) !== expectedHash) throw new Error('当前配置已改变，请重新确认还原。');
    // Keep the current state as a new backup, so restoring can itself be undone.
    const backup = this.snapshot(state.file, before, bytes, 'restore');
    if (digest(readConfig(state.file)) !== expectedHash) throw new Error('配置在备份期间发生变化，已停止还原。');
    if (bytes === null) {
      if (before !== null) fs.unlinkSync(state.file);
    } else {
      fs.mkdirSync(path.dirname(state.file), { recursive: true, mode: 0o700 });
      this.write(state.file, bytes, metadata.mode);
    }
    return { file: state.file, backupId: backup.id };
  }
}

module.exports = { ConfigStore, BASE_URL, MODEL, preset, digest, atomicWrite };
