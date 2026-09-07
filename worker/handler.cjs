const { normalizeRequest, resolveResponse } = require('../src/version-request.cjs');
const { validateManifest } = require('../src/template-policy.cjs');
const json = (body, status) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function handle(request, manifest) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:') return json({ error: 'https_required' }, 400);
  if (url.pathname !== '/config/v1/resolve' || url.search) return json({ error: 'not_found' }, 404);
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: 'json_required' }, 415);
  if (Number(request.headers.get('content-length')) > 4096 || !request.body) return json({ error: 'invalid_request' }, 400);
  let versions;
  try {
    const reader = request.body.getReader(); const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 4096) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    versions = normalizeRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch { return json({ error: 'invalid_versions' }, 400); }
  try {
    const result = resolveResponse(validateManifest(manifest), versions);
    return json(result, result.template ? 200 : 404);
  } catch { return json({ error: 'configuration_unavailable' }, 503); }
}
module.exports = { handle };
