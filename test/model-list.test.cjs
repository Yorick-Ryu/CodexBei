const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchModels, MAX_BYTES } = require('../src/model-list.cjs');
const credentials = { baseUrl: 'https://api.beiapi.cn/v1', apiKey: 'sk-fixture-not-a-real-credential' };

test('models use authenticated HTTPS without redirects and return only validated unique IDs', async () => {
  const result = await fetchModels(credentials, async (url, options) => {
    assert.equal(url, 'https://api.beiapi.cn/v1/models');
    assert.equal(options.headers.Authorization, `Bearer ${credentials.apiKey}`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.method, 'GET');
    return Response.json({ data: [{ id: 'model-b', owner: 'ignored' }, { id: 'model-a' }, { id: 'model-b' }] });
  });
  assert.deepEqual(result, { models: ['model-a', 'model-b'] });
  assert.equal(JSON.stringify(result).includes(credentials.apiKey), false);
  assert.deepEqual(await fetchModels(credentials, async () => Response.json({ data: [] })), { models: [] });
});

test('bad model responses and credential-bearing errors never reach the renderer', async () => {
  for (const response of [
    () => Response.json({ message: credentials.apiKey }, { status: 401 }),
    () => Response.json({ error: credentials.apiKey }, { status: 403 }),
    () => Response.json({ data: [{ id: '<script>' }] }),
    () => Response.json({ data: [], success: false, message: credentials.apiKey }),
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
