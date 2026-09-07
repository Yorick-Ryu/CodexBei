function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('请输入有效的 HTTPS API 地址。');
  let url;
  try { url = new URL(value.trim()); }
  catch { throw new Error('请输入有效的 HTTPS API 地址。'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址必须使用 HTTPS，且不能包含账号、密码、查询参数或片段。');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1') ? pathname : `${pathname}/v1`;
  return url.href.replace(/\/$/, '');
}

function validateKey(value) {
  if (typeof value !== 'string' || !/^sk-[A-Za-z0-9_-]{12,512}$/.test(value.trim()) || value.trim() === 'sk-your-api-key') {
    throw new Error('请提供有效的 API 密钥，不能使用示例占位符。');
  }
  return value.trim();
}

function validateModel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) {
    throw new Error('请选择有效的模型。');
  }
  return value;
}

function parseSetupLink(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('配置链接无效，请从网站重新打开。');
  let url;
  try { url = new URL(value); }
  catch { throw new Error('配置链接无效，请从网站重新打开。'); }
  if (url.protocol !== 'codexbei:' || url.hostname !== 'configure' || url.pathname !== '/codex' || url.port || url.username || url.password || url.hash) {
    throw new Error('不支持此配置链接，请从网站重新打开。');
  }
  const params = [...url.searchParams.keys()];
  if (!params.length) return null;
  if (params.length !== 4 || url.searchParams.getAll('model').length !== 1 || url.searchParams.getAll('preset').length !== 1 || url.searchParams.get('preset') !== 'codexbei-v1' || url.searchParams.getAll('base_url').length !== 1 || url.searchParams.getAll('api_key').length !== 1) {
    throw new Error('配置链接必须包含唯一的 API 地址、密钥、模型和配置预设。');
  }
  return { baseUrl: normalizeBaseUrl(url.searchParams.get('base_url')), apiKey: validateKey(url.searchParams.get('api_key')), model: validateModel(url.searchParams.get('model')) };
}

module.exports = { normalizeBaseUrl, validateKey, validateModel, parseSetupLink };
