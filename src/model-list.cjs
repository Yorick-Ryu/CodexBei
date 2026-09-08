const { normalizeBaseUrl, validateKey, validateModel } = require('./deep-link.cjs');
const { validVersion } = require('./version-request.cjs');

const MAX_BYTES = 1024 * 1024;

async function fetchModels({ baseUrl, apiKey, clientVersion }, fetchImpl = globalThis.fetch) {
  if (!validVersion(clientVersion)) throw new Error('未识别到 Codex 内核版本，请先选择 Codex 版本。');
  const endpoint = `${normalizeBaseUrl(baseUrl)}/models?client_version=${encodeURIComponent(clientVersion)}`;
  const key = validateKey(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'GET', signal: controller.signal, redirect: 'error',
      credentials: 'omit', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
    });
    if (response.status === 401 || response.status === 403) {
      return { models: [], error: '无法获取模型，请检查密钥及访问权限。' };
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error();
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) { controller.abort(); throw new Error(); }
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(value.models) || value.models.length > 5000 || value.error || value.success === false) throw new Error();
    const models = [...new Set(value.models.filter((item) => item?.visibility === 'list' && item.supported_in_api === true)
      .map((item) => validateModel(item.slug)))];
    return { models };
  } catch {
    // Never forward remote errors or request headers: either may contain credentials.
    return { models: [], error: '模型列表获取失败，请稍后重试。' };
  } finally { clearTimeout(timer); }
}

module.exports = { fetchModels, MAX_BYTES };
