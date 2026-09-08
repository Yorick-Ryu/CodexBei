const TOML = require('@iarna/toml');
const { parseForESLint } = require('toml-eslint-parser');

const HIDDEN = '（已隐藏）';
function isCredential(name) {
  const key = name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  // These are environment-variable references or authentication modes, not keys.
  if (['env_key', 'env_http_headers', 'bearer_token_env_var', 'preferred_auth_method'].includes(key)) return false;
  if (/^(?:model_)?max_(?:output_|completion_)?tokens$/.test(key)) return false;
  return /(?:^|[_-])(?:key|token|secret|password|passwd|authorization|credential)s?(?:$|[_-])/.test(key);
}
function redactText(value) {
  let text = value.replace(/\bsk-[a-zA-Z0-9_-]+/g, HIDDEN).replace(/\bBearer\s+[^\s"']+/gi, 'Bearer ' + HIDDEN);
  // Preserve endpoint paths and ordinary query options, hiding only credentials.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      let changed = false;
      if (url.password) { url.password = 'REDACTED'; changed = true; }
      for (const name of [...url.searchParams.keys()]) {
        if (isCredential(name)) { url.searchParams.set(name, HIDDEN); changed = true; }
      }
      if (changed) text = url.href;
    } catch { /* Non-URL settings remain ordinary text. */ }
  }
  return text;
}

// Replace only sensitive value ranges. Keep tables, inline headers, ordering,
// comments and line endings exactly as stored in the selected snapshot.
function backupPreview(bytes) {
  let source = bytes.toString('utf8');
  let config, ast;
  try {
    config = TOML.parse(source);
    ast = parseForESLint(source, { tomlVersion: '1.0' }).ast;
  } catch { throw new Error('备份不是有效的 TOML，无法预览。'); }
  const edits = [];
  const replace = (node, value) => edits.push({ range: node.range, text: TOML.stringify.value(value) });
  function actorEndpoint(parts, node) {
    if (parts.length !== 4 || parts[0] !== 'model_providers' || parts[2] !== 'http_headers' || parts[3].toLowerCase() !== 'x-openai-actor-authorization' || node.kind !== 'string') return false;
    if (node.value !== config.model_providers?.[parts[1]]?.base_url) return false;
    try { return ['https:', 'http:'].includes(new URL(node.value).protocol); } catch { return false; }
  }
  function value(node, parts, hidden = false) {
    if (node.type === 'TOMLInlineTable') { body(node.body, parts, hidden); return; }
    if (node.type === 'TOMLArray') {
      node.elements.forEach((item, index) => {
        const previous = node.elements[index - 1]?.value;
        const afterKeyFlag = typeof previous === 'string' && /^--?/.test(previous) && isCredential(previous.replace(/^--?/, ''));
        if (!hidden && !afterKeyFlag && item.kind === 'string') {
          const flag = item.value.match(/^(--?[^=]+)=(.*)$/s);
          if (flag && isCredential(flag[1].replace(/^--?/, ''))) { replace(item, flag[1] + '=' + HIDDEN); return; }
        }
        value(item, parts, hidden || afterKeyFlag);
      });
      return;
    }
    if (hidden) { replace(node, HIDDEN); return; }
    if (node.kind === 'string') {
      const text = redactText(node.value);
      if (text !== node.value) replace(node, text);
    }
  }
  function body(nodes, prefix, hidden = false) {
    for (const node of nodes) {
      if (node.type === 'TOMLTable') body(node.body, node.resolvedKey, node.resolvedKey.some(part => typeof part === 'string' && isCredential(part)));
      else if (node.type === 'TOMLKeyValue') {
        const keys = node.key.keys.map(part => part.name ?? part.value);
        const parts = [...prefix, ...keys];
        const sensitive = hidden || (keys.some(isCredential) && !actorEndpoint(parts, node.value));
        value(node.value, parts, sensitive);
      }
    }
  }
  body(ast.body[0].body, []);
  for (const comment of ast.comments) {
    // Comments may contain pasted credentials too; retain their ordinary text.
    const original = source.slice(...comment.range);
    const text = redactText(original).replace(/([\w-]+)(\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/g, (match, key, separator) => isCredential(key) ? key + separator + HIDDEN : match);
    if (text !== original) edits.push({ range: comment.range, text });
  }
  for (const edit of edits.sort((a, b) => b.range[0] - a.range[0])) source = source.slice(0, edit.range[0]) + edit.text + source.slice(edit.range[1]);
  return source;
}

module.exports = { backupPreview };
