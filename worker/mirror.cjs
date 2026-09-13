const PREFIX = 'chatgpt-mac';
const FILES = [
  ['arm64', 'CHATGPT_MAC_ARM64_URL', 'ChatGPT_aarch64.dmg'],
  ['x64', 'CHATGPT_MAC_X64_URL', 'ChatGPT_x64.dmg'],
];
const json = (body, status = 200) => Response.json(body, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

async function syncMirror(env, scheduledTime = Date.now()) {
  const entries = [];
  for (const [arch, variable, file] of FILES) {
    const upstream = env[variable];
    if (!upstream) continue;
    const response = await fetch(upstream, { redirect: 'follow', headers: { 'User-Agent': 'CodexBei-Mac-Mirror/1.0' } });
    if (!response.ok || !response.body) throw new Error(`upstream_${arch}_${response.status}`);
    const key = `${PREFIX}/${arch}/${file}`;
    await env.MAC_MIRROR.put(key, response.body, {
      httpMetadata: { contentType: 'application/x-apple-diskimage', cacheControl: 'public, max-age=3600' },
      customMetadata: { upstream, syncedAt: new Date(scheduledTime).toISOString() },
    });
    entries.push({ arch, file, url: `/mirror/${arch}/${file}`, bytes: Number(response.headers.get('content-length')) || null });
  }
  if (!entries.length) throw new Error('no_mac_upstreams_configured');
  await env.MAC_MIRROR.put(`${PREFIX}/manifest.json`, JSON.stringify({ schemaVersion: 1, syncedAt: new Date(scheduledTime).toISOString(), files: entries }, null, 2), { httpMetadata: { contentType: 'application/json' } });
  return { syncedAt: new Date(scheduledTime).toISOString(), files: entries };
}

async function handleMirror(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/mirror/sync') {
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    if (!env.MIRROR_SYNC_TOKEN || request.headers.get('authorization') !== `Bearer ${env.MIRROR_SYNC_TOKEN}`) return json({ error: 'unauthorized' }, 401);
    try { return json(await syncMirror(env)); } catch (error) { return json({ error: 'sync_failed', detail: String(error.message || error) }, 502); }
  }
  const key = url.pathname === '/mirror/manifest.json' ? `${PREFIX}/manifest.json` : `${PREFIX}${url.pathname.slice('/mirror'.length)}`;
  const object = await env.MAC_MIRROR.get(key);
  if (!object) return json({ error: 'not_found' }, 404);
  const headers = new Headers(); object.writeHttpMetadata(headers); headers.set('etag', object.httpEtag); headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(object.body, { headers });
}

module.exports = { handleMirror, syncMirror };
