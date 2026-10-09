const { validateAppRelease, handleUpdate } = require('./updates.cjs');
const origin = 'https://codexbei.beiapi.cn';
const currentKey = 'releases/current.json';
const immutable = 'public, max-age=31536000, immutable';
const versionPattern = '(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)';
const binaryPath = new RegExp(`^downloads/${versionPattern}/(?:[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:dmg|exe|zip|gz|sig)|SHA256SUMS)$`);
const assetPath = /^download-assets\/[a-z-]+\.[a-f0-9]{12}\.(?:js|css)$/;
const installers = version => ['aarch64.dmg', 'x64.dmg', 'x64-setup.exe', 'arm64-setup.exe'].map(suffix => `CodexBei_${version}_${suffix}`);
const json = (error, status) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function validateSnapshot(snapshot) {
  const release = validateAppRelease(snapshot?.release);
  if (snapshot?.schemaVersion !== 1 || !release || !new RegExp(`^${versionPattern}$`).test(release.version)
    || Object.keys(release.platforms).length !== 4 || !Array.isArray(snapshot.files) || snapshot.files.length > 100) throw Error('Invalid release snapshot');
  const prefix = `downloads/${release.version}/`;
  const keys = new Set();
  for (const file of snapshot.files) {
    if (!file || typeof file.key !== 'string' || keys.has(file.key)
      || !(binaryPath.test(file.key) && file.key.startsWith(prefix) || assetPath.test(file.key)
        || file.key === `site/${release.version}/index.html` || file.key === `site/${release.version}/favicon.ico`)
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size <= 0) throw Error('Invalid public release file');
    keys.add(file.key);
  }
  const required = [...installers(release.version).map(name => prefix + name), prefix + 'SHA256SUMS', `site/${release.version}/index.html`, `site/${release.version}/favicon.ico`];
  for (const artifact of Object.values(release.platforms)) {
    const url = new URL(artifact.url);
    const key = url.pathname.slice(1);
    if (url.origin !== origin || url.search || !key.startsWith(prefix) || !binaryPath.test(key)) throw Error('Update URL must use its immutable release directory');
    required.push(key, key + '.sig');
  }
  if (required.some(key => !keys.has(key))) throw Error('Incomplete release snapshot');
  return snapshot;
}

async function readCurrent(bucket) {
  const object = await bucket.get(currentKey);
  if (!object) throw Error('Release storage is not initialized');
  return validateSnapshot(await object.json());
}

function parseRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start, end;
  if (!match[1]) { start = Math.max(0, size - Number(match[2])); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size
    ? { offset: start, length: end - start + 1 } : null;
}

async function serveObject(request, bucket, key, cacheControl = immutable) {
  const object = await bucket.head(key);
  if (!object) return json('not_found', 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', cacheControl);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Accept-Ranges', 'bytes');
  const matches = request.headers.get('if-none-match')?.split(',').map(value => value.trim().replace(/^W\//, ''));
  if (matches?.some(value => value === '*' || value === object.httpEtag)) return new Response(null, { status: 304, headers });
  let range;
  const rangeHeader = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  if (request.method === 'GET' && rangeHeader && (!ifRange || ifRange === object.httpEtag)) {
    range = parseRange(rangeHeader, object.size);
    if (!range) { headers.set('Content-Range', `bytes */${object.size}`); return new Response(null, { status: 416, headers }); }
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  }
  headers.set('Content-Length', String(range?.length ?? object.size));
  if (request.method === 'HEAD') return new Response(null, { headers });
  const body = await bucket.get(key, { ...(range ? { range } : {}), onlyIf: { etagMatches: object.etag } });
  if (!body || !body.body) return json('download_changed', 503);
  return new Response(body.body, { status: range ? 206 : 200, headers });
}

async function handleRelease(request, bucket) {
  const url = new URL(request.url);
  if (url.protocol !== 'https:') return json('https_required', 400);
  if (!['GET', 'HEAD'].includes(request.method)) return json('method_not_allowed', 405);
  try {
    if (url.pathname.startsWith('/updates/')) return handleUpdate(request, (await readCurrent(bucket)).release);
    const key = url.pathname.slice(1);
    if (binaryPath.test(key) || assetPath.test(key)) return await serveObject(request, bucket, key);
    if (url.pathname === '/downloads') return new Response(null, { status: 308, headers: { Location: '/downloads/', 'Cache-Control': 'no-store' } });
    if (['/', '/index.html', '/downloads/', '/downloads/index.html', '/favicon.ico'].includes(url.pathname) || url.pathname.startsWith('/downloads/latest/')) {
      const { release } = await readCurrent(bucket);
      if (url.pathname.startsWith('/downloads/latest/')) {
        const name = installers(release.version).find(file => url.pathname === `/downloads/latest/${file.replace(`_${release.version}_`, '_')}`);
        return name ? new Response(null, { status: 302, headers: { Location: `/downloads/${release.version}/${name}`, 'Cache-Control': 'no-store' } }) : json('not_found', 404);
      }
      return await serveObject(request, bucket, `site/${release.version}/${url.pathname === '/favicon.ico' ? 'favicon.ico' : 'index.html'}`, 'no-store');
    }
    return json('not_found', 404);
  } catch { return json('release_unavailable', 503); }
}

module.exports = { origin, currentKey, immutable, installers, binaryPath, validateSnapshot, handleRelease };
