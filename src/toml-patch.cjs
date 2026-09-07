const { parseForESLint } = require('toml-eslint-parser');
const { formatPreset, tomlLiteral } = require('./format-preset.cjs');

function structure(source) {
  let ast;
  try { ast = parseForESLint(source, { tomlVersion: '1.0' }).ast; }
  catch { throw new Error('无法可靠解析此 TOML 配置，已停止修改。'); }
  const entries = [];
  const tables = [];
  function walk(body, prefix) {
    for (const node of body) {
      if (node.type === 'TOMLTable') {
        tables.push(node);
        walk(node.body, node.resolvedKey);
      } else if (node.type === 'TOMLKeyValue') {
        const key = [...prefix, ...node.key.keys.map((part) => part.name ?? part.value)];
        entries.push({ node, key });
        if (node.value.type === 'TOMLInlineTable') walk(node.value.body, key);
      }
    }
  }
  walk(ast.body[0].body, []);
  return { entries, tables };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const prefixOf = (a, b) => a.length < b.length && a.every((part, index) => part === b[index]);
const splice = (source, start, end, value) => source.slice(0, start) + value + source.slice(end);
const dotted = (key) => key.map((part) => /^[A-Za-z0-9_-]+$/.test(part) ? part : JSON.stringify(part)).join('.');

// Update one scalar at its AST range. All unrelated bytes remain untouched.
function setField(source, key, value) {
  const { entries, tables } = structure(source);
  const literal = tomlLiteral(value);
  const exact = entries.find((entry) => same(entry.key, key));
  if (exact) {
    if (exact.node.value.type !== 'TOMLValue') throw new Error('推荐字段的现有类型不兼容，已停止修改。');
    return splice(source, ...exact.node.value.range, literal);
  }
  const ancestors = entries.filter((entry) => prefixOf(entry.key, key)).sort((a, b) => b.key.length - a.key.length);
  if (ancestors.length) {
    const ancestor = ancestors[0];
    if (ancestor.node.value.type !== 'TOMLInlineTable') throw new Error('推荐字段的上级配置不是 TOML 表，已停止修改。');
    const inline = ancestor.node.value;
    const insertion = `${inline.body.length ? ', ' : ''}${dotted(key.slice(ancestor.key.length))} = ${literal}`;
    const position = inline.body.length ? inline.body.at(-1).range[1] : inline.range[0] + 1;
    return splice(source, position, position, insertion);
  }
  const table = tables.filter((node) => prefixOf(node.resolvedKey, key)).sort((a, b) => b.resolvedKey.length - a.resolvedKey.length)[0];
  if (table?.kind === 'array') throw new Error('推荐字段所在表的类型不兼容，已停止修改。');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  // Append after a complete line, including its comment. Repeated additions stay in preset order.
  const afterLine = (end) => {
    const lf = source.indexOf('\n', end);
    return lf === -1 ? source.length : lf + 1;
  };
  let position;
  let separator = '';
  if (table) {
    position = afterLine(table.body.length ? table.body.at(-1).range[1] : source.indexOf(']', table.key.range[1]) + 1);
  } else {
    const firstTable = tables[0]?.range[0] ?? source.length;
    const rootEntries = entries.filter((entry) => entry.node.range[0] < firstTable && entry.node.parent.type !== 'TOMLInlineTable');
    position = rootEntries.length ? afterLine(rootEntries.at(-1).node.range[1]) : firstTable;
    if (!rootEntries.length && tables.length) separator = newline;
  }
  const leading = position > 0 && source[position - 1] !== '\n' ? newline : '';
  const line = `${dotted(table ? key.slice(table.resolvedKey.length) : key)} = ${literal}`;
  return splice(source, position, position, `${leading}${line}${newline}${separator}`);
}

function removeField(source, key) {
  const { entries, tables } = structure(source);
  const entry = entries.find((item) => same(item.key, key));
  if (entry) {
    const node = entry.node;
    if (node.parent.type === 'TOMLInlineTable') {
      const siblings = node.parent.body;
      const index = siblings.indexOf(node);
      if (index < siblings.length - 1) return splice(source, node.range[0], siblings[index + 1].range[0], '');
      if (index > 0) return splice(source, siblings[index - 1].range[1], node.range[1], '');
    }
    return splice(source, ...node.range, '');
  }
  const ranges = [
    ...tables.filter((node) => same(node.resolvedKey, key) || prefixOf(key, node.resolvedKey)).map((node) => node.range),
  ].sort((a, b) => b[0] - a[0]);
  for (const range of ranges) source = splice(source, ...range, '');
  const descendants = structure(source).entries.filter((item) => prefixOf(key, item.key));
  for (const descendant of descendants) source = removeField(source, descendant.key);
  return source;
}

function patchPreset(source, preset, remove = []) {
  let result = source;
  const changes = [];
  if (!source.trim() && preset.model_providers?.custom) {
    const text = formatPreset(preset);
    structure(text);
    const fields = structure(text).entries.filter((entry) => entry.node.value.type === 'TOMLValue');
    return { text, changes: fields.map((entry) => ({ field: entry.key.join('.'), action: '新增' })) };
  }
  const before = structure(source);
  for (const key of remove) {
    const existing = before.entries.find((entry) => same(entry.key, key));
    if ((existing && existing.node.value.type !== 'TOMLValue') || before.tables.some((table) => same(table.resolvedKey, key))) {
      throw new Error('旧参数的现有类型不兼容，已停止修改。');
    }
    const next = removeField(result, key);
    if (next !== result) changes.push({ field: key.join('.'), action: '移除旧参数' });
    result = next;
  }
  for (const entry of before.entries) {
    const [providers, provider, kind, header] = entry.key;
    if (providers === 'model_providers' && provider === 'custom' && entry.key.length === 4 &&
      ((['http_headers', 'env_http_headers'].includes(kind) && header.toLowerCase() === 'authorization') ||
       (kind === 'env_http_headers' && header.toLowerCase() === 'x-openai-actor-authorization') ||
       (kind === 'http_headers' && header.toLowerCase() === 'x-openai-actor-authorization' && header !== 'x-openai-actor-authorization'))) {
      result = removeField(result, entry.key);
      changes.push({ field: entry.key.join('.'), action: '移除冲突认证项' });
    }
  }
  // These authentication methods conflict with the supplied direct bearer token.
  for (const field of ['env_key', 'env_key_instructions', 'auth']) {
    const key = ['model_providers', 'custom', field];
    const next = removeField(result, key);
    if (next !== result) changes.push({ field: key.join('.'), action: '移除冲突认证项' });
    result = next;
  }
  // Create a standard provider table only when no existing representation needs preserving.
  const providerKey = ['model_providers', 'custom'];
  const current = structure(result);
  if (preset.model_providers?.custom && !current.entries.some((entry) => same(entry.key, providerKey) || prefixOf(providerKey, entry.key) || prefixOf(entry.key, providerKey)) &&
      !current.tables.some((table) => same(table.resolvedKey, providerKey) || prefixOf(providerKey, table.resolvedKey))) {
    const newline = result.includes('\r\n') ? '\r\n' : '\n';
    result += (result.endsWith(newline + newline) ? '' : result.endsWith(newline) ? newline : newline + newline) + '[model_providers.custom]' + newline;
  }
  function applyFields(value, key) {
    for (const [name, child] of Object.entries(value)) {
      const full = [...key, name];
      if (child && typeof child === 'object') {
        const tree = structure(result);
        if (same(full, ['model_providers', 'custom', 'http_headers']) &&
            !tree.entries.some((entry) => same(entry.key, full) || prefixOf(full, entry.key)) &&
            !tree.tables.some((table) => same(table.resolvedKey, full) || prefixOf(full, table.resolvedKey))) {
          result = setField(result, full, child);
          for (const name of Object.keys(child)) changes.push({ field: [...full, name].join('.'), action: '新增' });
        } else applyFields(child, full);
      }
      else {
        const next = setField(result, full, child);
        if (next !== result) changes.push({ field: full.join('.'), action: before.entries.some((entry) => same(entry.key, full)) ? '更新' : '新增' });
        result = next;
      }
    }
  }
  applyFields(preset, []);
  structure(result);
  return { text: result, changes };
}

module.exports = { patchPreset };
