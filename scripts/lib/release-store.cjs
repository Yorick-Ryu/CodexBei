const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AwsClient } = require('aws4fetch');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../../wrangler.jsonc'), 'utf8'));
const bucket = config.r2_buckets.find(value => value.binding === 'APP_RELEASES')?.bucket_name;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function checksum(body) {
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of body) { hash.update(chunk); size += chunk.length; }
  return { sha256: hash.digest('hex'), size };
}
function contentType(key) {
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  if (key.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (key.endsWith('.css')) return 'text/css; charset=utf-8';
  if (key.endsWith('.ico')) return 'image/x-icon';
  if (key.endsWith('.json')) return 'application/json';
  if (key.endsWith('.sig') || key.endsWith('/SHA256SUMS')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
function createStore(credentialsFile) {
  if (!credentialsFile) throw Error('Provide --credentials-file with bucket-scoped R2 S3 credentials');
  const stat = fs.lstatSync(credentialsFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('R2 credentials must be a regular private file (600)');
  let credentials;
  try { credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8')); }
  catch { throw Error('R2 credentials file is not valid JSON'); }
  if (!credentials || typeof credentials !== 'object') throw Error('Invalid R2 credentials');
  if (credentials.accountId !== config.account_id || !bucket || typeof credentials.accessKeyId !== 'string' || !credentials.accessKeyId
    || typeof credentials.secretAccessKey !== 'string' || !credentials.secretAccessKey) throw Error('Invalid R2 credentials or account');
  const client = new AwsClient({ accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken, service: 's3', region: 'auto', retries: 0 });
  const url = key => `https://${config.account_id}.r2.cloudflarestorage.com/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  return {
    async head(key) {
      const response = await client.fetch(url(key), { method: 'HEAD', signal: AbortSignal.timeout(15000) });
      if (response.status === 404) return null;
      if (!response.ok) throw Error(`R2 metadata read failed (${response.status}): ${key}`);
      return response;
    },
    async get(key) {
      const response = await client.fetch(url(key), { signal: AbortSignal.timeout(180000) });
      if (response.status === 404) return null;
      if (!response.ok) throw Error(`R2 read failed (${response.status}): ${key}`);
      return response;
    },
    async put(key, body, sha256, etag) {
      const response = await client.fetch(url(key), {
        method: 'PUT', body, signal: AbortSignal.timeout(180000),
        headers: { 'Content-Type': contentType(key), 'x-amz-content-sha256': sha256, 'x-amz-meta-sha256': sha256,
          ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }) },
      });
      if (response.status === 412 || response.status === 409) throw Error(`Remote object changed; refresh before retrying: ${key}`);
      if (!response.ok) throw Error(`R2 write failed (${response.status}): ${key}`);
      await response.body?.cancel();
    },
  };
}
async function verifyFile(store, file) {
  const response = await store.get(file.key);
  if (!response) throw Error(`Missing remote file: ${file.key}`);
  const actual = await checksum(response.body);
  if (actual.sha256 !== file.sha256 || actual.size !== file.size) throw Error(`Remote checksum mismatch: ${file.key}`);
}
module.exports = { createStore, checksum, digest, contentType, verifyFile };
