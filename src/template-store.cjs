const fs = require('node:fs');
const path = require('node:path');
const { atomicWrite } = require('./config.cjs');
const { validateManifest, selectTemplate, templateDigest } = require('./template-policy.cjs');
const { requestFor, requestKey, validateResponse } = require('./version-request.cjs');
const bootstrap = validateManifest(require('./bootstrap-manifest.json'));
const RESOLVE_URL = 'https://codexbei.beiapi.cn/config/v1/resolve';
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 20;

class TemplateStore {
  constructor({ directory, fetchImpl = globalThis.fetch, now = Date.now }) {
    Object.assign(this, { directory, fetch: fetchImpl, now });
    this.entries = new Map(); this.inflight = new Map(); this.remote = new Set(); this.errors = new Set();
    try {
      const file = path.join(directory, 'resolved-templates.json');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * MAX_ENTRIES) throw new Error();
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(cached) || cached.length > MAX_ENTRIES) throw new Error();
      const entries = cached.map((item) => [requestKey(item.request), validateResponse(item, item.request)]);
      this.entries = new Map(entries);
    } catch { /* Use the validated bundled default when the cache is absent or invalid. */ }
    this.selected = new Map();
    try {
      const file = path.join(directory, 'selected-templates.json');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * MAX_ENTRIES) throw new Error();
      const values = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(values) || values.length > MAX_ENTRIES) throw new Error();
      this.selected = new Map(values.map((value) => [requestKey(value.request), validateResponse(value, value.request)]));
    } catch { /* No selected template yet; initialize from the local cache or bundled default. */ }
  }
  current(installations) {
    const request = requestFor(installations), key = requestKey(request);
    if (!this.selected.has(key)) {
      const value = this.entries.get(key) ?? { schemaVersion: 1, release: bootstrap.release, request, template: selectTemplate(bootstrap, request.targets) };
      this.saveSelection(key, value);
    }
    const template = this.selected.get(key).template;
    return template ? { template, digest: templateDigest(template) } : null;
  }
  saveSelection(key, value) {
    const next = new Map(this.selected); next.delete(key); next.set(key, value);
    while (next.size > MAX_ENTRIES) next.delete(next.keys().next().value);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error('模板缓存目录无效。');
    atomicWrite(path.join(this.directory, 'selected-templates.json'), Buffer.from(JSON.stringify([...next.values()])));
    this.selected = next;
  }
  activate(installations) {
    const request = requestFor(installations), key = requestKey(request);
    const value = this.entries.get(key);
    if (!value?.template || this.errors.has(key)) throw new Error('无法获取最新模板，请稍后重试。');
    this.saveSelection(key, value);
    return this.current(installations);
  }
  async check(installations) {
    let request;
    try { request = requestFor(installations); } catch { return false; }
    const key = requestKey(request);
    if (this.inflight.has(key)) return this.inflight.get(key);
    const pending = this.refresh(request, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, pending);
    return pending;
  }
  async refresh(request, key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // Only version identifiers cross this boundary. Never send keys, paths, model or configuration.
      const response = await this.fetch(RESOLVE_URL, {
        method: 'POST', body: JSON.stringify(request), signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      });
      if (![200, 404].includes(response.status) || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw new Error();
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_BYTES) { controller.abort(); throw new Error(); }
        chunks.push(Buffer.from(chunk));
      }
      const value = validateResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), request);
      if ((value.template === null) !== (response.status === 404)) throw new Error();
      const old = this.entries.get(key);
      if (value.release < bootstrap.release || (old && (value.release < old.release || (value.release === old.release && JSON.stringify(value) !== JSON.stringify(old))))) throw new Error();
      for (const template of [...bootstrap.templates, ...[...this.entries.values(), ...this.selected.values()].map((item) => item.template).filter(Boolean)]) {
        if (value.template?.id === template.id && value.template.version === template.version && templateDigest(value.template) !== templateDigest(template)) throw new Error();
      }
      const next = new Map(this.entries); next.delete(key); next.set(key, value);
      while (next.size > MAX_ENTRIES) next.delete(next.keys().next().value);
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(this.directory).isSymbolicLink()) throw new Error();
      atomicWrite(path.join(this.directory, 'resolved-templates.json'), Buffer.from(JSON.stringify([...next.values()])));
      this.entries = next; this.remote.add(key); this.errors.delete(key); this.checkedAt = this.now();
      return true;
    } catch { this.errors.add(key); return false; }
    finally { clearTimeout(timer); }
  }
  resolve(installations) {
    let request;
    try { request = requestFor(installations); } catch { return null; }
    const key = requestKey(request), entry = this.entries.get(key);
    const template = entry ? entry.template : selectTemplate(bootstrap, request.targets);
    if (!template) return null;
    return { template, digest: templateDigest(template), source: entry ? (this.remote.has(key) ? 'remote' : 'cache') : 'bundled', offline: this.errors.has(key) };
  }
}
module.exports = { TemplateStore, RESOLVE_URL, MAX_BYTES };
