const { normalizeBaseUrl, validateKey, validateModel } = require('./deep-link.cjs');

const MAX_BYTES = 1024 * 1024;

async function fetchModels({ baseUrl, apiKey }, fetchImpl = globalThis.fetch) {
  const endpoint = `${normalizeBaseUrl(baseUrl)}/models`;
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
    if (!Array.isArray(value.data) || value.data.length > 5000 || value.error || value.success === false) throw new Error();
    const models = [...new Set(value.data.map((item) => validateModel(item?.id)))].sort();
    return { models };
  } catch {
    // Never forward remote errors or request headers: either may contain credentials.
    return { models: [], error: '模型列表获取失败，请稍后重试。' };
  } finally { clearTimeout(timer); }
}

module.exports = { fetchModels, MAX_BYTES };
