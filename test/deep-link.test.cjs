const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSetupLink, normalizeBaseUrl } = require('../src/deep-link.cjs');
const KEY = 'sk-fixture-not-a-real-credential';
function link(baseUrl = 'https://api.beiapi.cn/v1', key = KEY) {
  const url = new URL('codexbei://configure/codex');
  url.searchParams.set('base_url', baseUrl);
  url.searchParams.set('api_key', key);
  url.searchParams.set('model', 'gpt-5.6-sol');
  url.searchParams.set('preset', 'codexbei-v1');
  return url.href;
}

test('URL-encoded credentials and base URL are parsed as a pair', () => {
  assert.deepEqual(parseSetupLink(link('https://api.example.com/gateway/')), { baseUrl: 'https://api.example.com/gateway/v1', apiKey: KEY, model: 'gpt-5.6-sol' });
});

test('the original bare launch link only opens the window', () => {
  assert.equal(parseSetupLink('codexbei://configure/codex'), null);
});

test('missing or duplicate credentials cannot silently reuse the previous key', () => {
  for (const value of [
    'codexbei://configure/codex?base_url=https%3A%2F%2Fapi.beiapi.cn',
    `${link()}&api_key=duplicate`,
    `${link()}&file=config.toml`,
    `${link()}&apply=true`,
  ]) assert.throws(() => parseSetupLink(value), /唯一/);
});

test('invalid URLs and protocol routes are rejected without echoing the secret', () => {
  for (const value of [link().replace('/codex?', '/claude?'), `${link()}#${KEY}`, link('http://example.com/v1'), link('https://user:pass@example.com/v1'), link('https://example.com/v1?token=private')]) {
    assert.throws(() => parseSetupLink(value), (error) => !error.message.includes(KEY) && !error.message.includes('private'));
  }
});

test('placeholder, masked and oversized credentials are rejected', () => {
  for (const key of ['sk-your-api-key', 'sk-***masked***', `sk-${'a'.repeat(513)}`]) assert.throws(() => parseSetupLink(link(undefined, key)));
  assert.throws(() => parseSetupLink(`codexbei://configure/codex?${'x'.repeat(8192)}`));
});

test('API normalization keeps an existing v1 prefix and strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://api.beiapi.cn/v1///'), 'https://api.beiapi.cn/v1');
});

test('only the CodexBei protocol is accepted', () => {
  for (const scheme of ['beiapi-setup:', 'unrelated:']) {
    assert.throws(() => parseSetupLink(link().replace('codexbei:', scheme)));
  }
});

test('selected model is required and only the known preset can be passed', () => {
  const valid = new URL(link());
  valid.searchParams.set('model', 'gpt-5.6-terra');
  assert.equal(parseSetupLink(valid.href).model, 'gpt-5.6-terra');
  for (const field of ['model', 'preset']) {
    const missing = new URL(valid); missing.searchParams.delete(field);
    assert.throws(() => parseSetupLink(missing.href));
    const duplicated = new URL(valid); duplicated.searchParams.append(field, 'duplicate');
    assert.throws(() => parseSetupLink(duplicated.href));
  }
  valid.searchParams.set('preset', 'arbitrary');
  assert.throws(() => parseSetupLink(valid.href));
  valid.searchParams.set('preset', 'codexbei-v1');
  valid.searchParams.set('model', 'bad\nmodel');
  assert.throws(() => parseSetupLink(valid.href));
});


test('HTTP gateways are rejected including local loopback addresses', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'example.com', 'localhost.example.com', '192.168.1.2']) {
    assert.throws(() => parseSetupLink(link(`http://${host}:3000/v1`)));
  }
});
