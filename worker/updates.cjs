const semver = require('semver');
const platforms = new Set(['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'windows-aarch64']);
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
function validateAppRelease(release) {
  if (release === null) return null;
  if (!release || !semver.valid(release.version) || semver.prerelease(release.version)
    || typeof release.notes !== 'string' || release.notes.length > 20000
    || typeof release.pub_date !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(release.pub_date) || !Number.isFinite(Date.parse(release.pub_date))
    || !release.platforms || !Object.keys(release.platforms).length) throw Error('Invalid application release');
  for (const [target, artifact] of Object.entries(release.platforms)) {
    if (!platforms.has(target) || !artifact || typeof artifact.url !== 'string'
      || typeof artifact.signature !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(artifact.signature) || artifact.signature.length < 100) throw Error('Invalid update artifact');
    const url = new URL(artifact.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('Update artifacts require HTTPS');
  }
  return release;
}
function handleUpdate(request, release) {
  const url = new URL(request.url);
  const json = (body, status) => Response.json(body, { status, headers });
  if (url.protocol !== 'https:') return json({ error: 'https_required' }, 400);
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  const match = url.pathname.match(/^\/updates\/v1\/(darwin|windows|linux)\/([a-z0-9_]+)\/([^/]+)$/);
  if (!match || url.search) return json({ error: 'not_found' }, 404);
  let current;
  try { current = decodeURIComponent(match[3]); } catch { return json({ error: 'invalid_version' }, 400); }
  if (!semver.valid(current)) return json({ error: 'invalid_version' }, 400);
  try {
    validateAppRelease(release);
    const artifact = release?.platforms[`${match[1]}-${match[2]}`];
    if (!artifact || !semver.gt(release.version, current)) return new Response(null, { status: 204, headers });
    return json({ version: release.version, notes: release.notes, pub_date: release.pub_date, ...artifact }, 200);
  } catch { return json({ error: 'update_unavailable' }, 503); }
}
module.exports = { handleUpdate, validateAppRelease };
