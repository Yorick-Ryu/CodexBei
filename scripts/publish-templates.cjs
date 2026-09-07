#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateManifest } = require('../src/template-policy.cjs');
const { resolveResponse } = require('../src/version-request.cjs');
const root = path.resolve(__dirname, '..');
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set(['--validate-only', '--token-file', '--apply']);
  let tokenFile, attachDomain = false;
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw Error('Unknown argument');
    if (args[i] === '--token-file') tokenFile = args[++i];
  }
  const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(root, 'remote/manifest.json'), 'utf8')));
  console.log(`Validated release ${manifest.release} (${manifest.templates.length} templates)`);
  if (args.includes('--validate-only')) return;
  const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
  if (args.includes('--apply')) {
    if (!tokenFile) throw Error('Provide --token-file for deployment');
    const stat = fs.lstatSync(tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error('Token file must be a regular private file (600)');
    env.CLOUDFLARE_API_TOKEN = fs.readFileSync(tokenFile, 'utf8').trim();
    const zone = await fetch('https://api.cloudflare.com/client/v4/zones/75d29191c520e6c19d12242b4faeb7bd', { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(10000) });
    const data = await zone.json();
    if (!zone.ok || data.result?.name !== 'beiapi.cn' || data.result?.account?.id !== '4e528d4c6e70aee6dd9fec89af0e0522') throw Error('Zone/account verification failed');
  }
  if (args.includes('--apply')) {
    const headers = { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
    const domains = await fetch('https://api.cloudflare.com/client/v4/accounts/4e528d4c6e70aee6dd9fec89af0e0522/workers/domains', { headers, signal: AbortSignal.timeout(10000) });
    const body = await domains.json();
    if (!domains.ok || !body.success) throw Error('Worker domain verification failed');
    const existing = body.result.filter((d) => d.hostname === 'codexbei.beiapi.cn');
    if (existing.some((d) => d.service !== 'codexbei-config')) throw Error('Domain belongs to another Worker');
    if (!existing.length) {
      attachDomain = true;
      const dns = await fetch('https://api.cloudflare.com/client/v4/zones/75d29191c520e6c19d12242b4faeb7bd/dns_records?name=codexbei.beiapi.cn', { headers, signal: AbortSignal.timeout(10000) });
      const records = await dns.json();
      if (!dns.ok || !records.success || records.result.length) throw Error('Resolve existing DNS ownership before deployment');
    }
  }
  const command = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  let temporary;
  let configArgs = [];
  if (args.includes('--apply')) {
    // Publish code independently of zone path routes. Custom domains use the account API below.
    const config = JSON.parse(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
    if (config.name !== 'codexbei-config' || config.account_id !== '4e528d4c6e70aee6dd9fec89af0e0522') throw Error('Unexpected Worker target');
    fs.mkdirSync(path.join(root, '.wrangler'), { recursive: true });
    temporary = fs.mkdtempSync(path.join(root, '.wrangler/deploy-'));
    const file = path.join(temporary, 'wrangler.json');
    fs.writeFileSync(file, JSON.stringify({ ...config, routes: [], main: path.resolve(root, config.main), $schema: path.join(root, 'node_modules/wrangler/config-schema.json') }));
    configArgs = ['--config', file];
  }
  let result;
  try {
    result = spawnSync(process.execPath, [command, 'deploy', ...configArgs, ...(args.includes('--apply') ? [] : ['--dry-run', '--outdir', 'dist/worker'])], { cwd: root, env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(env.CLOUDFLARE_API_TOKEN ? output.split(env.CLOUDFLARE_API_TOKEN).join('[redacted]') : output);
  if (result.status !== 0) throw Error('Worker deployment/validation failed');
  if (attachDomain) {
    const response = await fetch('https://api.cloudflare.com/client/v4/accounts/4e528d4c6e70aee6dd9fec89af0e0522/workers/domains', {
      method: 'PUT', headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: 'codexbei.beiapi.cn', service: 'codexbei-config', zone_id: '75d29191c520e6c19d12242b4faeb7bd', environment: 'production' }), signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw Error('Worker uploaded; custom domain attachment failed');
  }
  if (args.includes('--apply')) {
    const request = { clientVersion: require('../package.json').version, targets: [{ kind: 'cli', runtimeVersion: '0.153.4' }] };
    const expected = resolveResponse(manifest, request);
    let verified = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        const response = await fetch('https://codexbei.beiapi.cn/config/v1/resolve', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), redirect: 'error', signal: AbortSignal.timeout(10000),
        });
        const actual = await response.json();
        if (response.status === (expected.template ? 200 : 404) && JSON.stringify(actual) === JSON.stringify(expected)) { verified = true; break; }
      } catch { /* Allow edge deployment propagation within this bounded verification window. */ }
    }
    if (!verified) throw Error('Worker uploaded; public HTTPS verification failed');
    console.log(`Public HTTPS verified: release ${manifest.release}`);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
