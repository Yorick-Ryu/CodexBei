const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchModels, MAX_BYTES } = require('../src/model-list.cjs');
const credentials = { baseUrl: 'https://api.beiapi.cn/v1', apiKey: 'sk-fixture-not-a-real-credential', clientVersion: '0.153.4' };
const entry = (slug) => ({ slug, visibility: 'list', supported_in_api: true });

test('catalog requests use the selected Codex runtime and never the desktop or CodexBei app version', async () => {
  const { modelClientVersion } = require('../src/codex-versions.cjs');
  const installed = [
    { id: 'desktop', kind: 'desktop', runtimeVersion: '0.152.1', appVersion: '26.901.51231' },
    { id: 'cli', kind: 'cli', runtimeVersion: '0.153.4' },
  ];
  assert.equal(modelClientVersion(installed, { mode: 'auto' }), '0.153.4');
  assert.equal(modelClientVersion(installed, { mode: 'installed', id: 'desktop' }), '0.152.1');
  assert.equal(modelClientVersion(installed.slice(0, 1)), '0.152.1');
  const preview = modelClientVersion(installed, { mode: 'manual', kind: 'desktop', runtimeVersion: '0.154.0-alpha.3', appVersion: '26.901.51231' });
  assert.equal(preview, '0.154.0-alpha.3');
  await fetchModels({ ...credentials, clientVersion: preview }, async (url) => {
    assert.equal(new URL(url).searchParams.get('client_version'), preview);
    return Response.json({ models: [] });
  });
  assert.equal(modelClientVersion([{ kind: 'desktop', runtimeVersion: null, appVersion: '26.901.51231' }]), null);
  for (const clientVersion of [undefined, null, 'codexbei', '26.901.51231.0']) {
    await assert.rejects(fetchModels({ ...credentials, clientVersion }, async () => assert.fail('Must not send an invented version')), /Codex 内核版本/);
  }
});

test('models use authenticated HTTPS without redirects and return only validated unique IDs', async () => {
  const result = await fetchModels(credentials, async (url, options) => {
    assert.equal(url, 'https://api.beiapi.cn/v1/models?client_version=0.153.4');
    assert.equal(options.headers.Authorization, `Bearer ${credentials.apiKey}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    return Response.json({ models: [entry('model-b'), entry('model-a'), entry('model-b')] });
  });
  assert.deepEqual(result, { models: ['model-b', 'model-a'] });
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
  assert.deepEqual(await fetchModels(credentials, async () => Response.json({ models: [] })), { models: [] });
});

test('Codex catalog visibility is respected without reordering or rejecting multimodal chat models', async () => {
  const result = await fetchModels(credentials, async () => Response.json({ models: [
    entry('gpt-6-astra'),
    { ...entry('internal-model'), visibility: 'hide' },
    { ...entry('unavailable-model'), supported_in_api: false },
    { ...entry('gpt-5.6-sol'), input_modalities: ['text', 'image'] }, entry('gpt-5.6-terra'),
  ] }));
  assert.deepEqual(result.models, ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']);
});

test('bad model responses and credential-bearing errors never reach the renderer', async () => {
  for (const response of [
    () => Response.json({ message: credentials.apiKey }, { status: 401 }),
    () => Response.json({ error: credentials.apiKey }, { status: 403 }),
    () => Response.json({ models: [entry('<script>')] }),
    () => Response.json({ data: [] }),
    () => Response.json({ models: [], success: false, message: credentials.apiKey }),
    () => new Response('not json'),
    () => new Response('x'.repeat(MAX_BYTES + 1)),
    () => new Response('{}', { headers: { 'content-length': String(MAX_BYTES + 1) } }),
    () => { throw new Error(credentials.apiKey); },
  ]) {
    const result = await fetchModels(credentials, async () => response());
    assert.deepEqual(result.models, []);
    assert.ok(result.error);
    assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
  }
  let fetched = false;
  await assert.rejects(fetchModels({ ...credentials, baseUrl: 'http://example.com' }, async () => { fetched = true; }));
  assert.equal(fetched, false);
});
