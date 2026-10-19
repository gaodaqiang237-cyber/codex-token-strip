'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { loadConfig } = require('../app/config.cjs');
const { createServer } = require('../app/server.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-strip-public-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('portable configuration uses the Windows profile rather than a Git Bash HOME', t => {
  const root = fixture(t);
  const config = loadConfig({ USERPROFILE: root, LOCALAPPDATA: path.join(root, 'local') });
  assert.equal(config.codexHome, path.join(root, '.codex'));
  assert.equal(config.dataDirectory, path.join(root, 'local', 'CodexTokenStrip'));
  assert.equal(config.port, 23957);
});
test('settings accept Unicode paths and a BOM written by the native strip', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'settings.json'), '\ufeff' + JSON.stringify({ Port: 24957, CodexHome: root, LogRoot: path.join(root, 'logs') }));
  const config = loadConfig({ CODEX_TOKEN_STRIP_DATA_DIR: root });
  assert.equal(config.port, 24957); assert.equal(config.codexHome, root);
  assert.equal(config.logRoot, path.join(root, 'logs'));
});
test('invalid ports fail instead of opening an unintended listener', t => {
  const root = fixture(t);
  for (const port of ['abc', '0', '65536', '-1', '1.5'])
    assert.throws(() => loadConfig({ CODEX_TOKEN_STRIP_DATA_DIR: root, CODEX_TOKEN_STRIP_PORT: port }), /Port/);
});

function get(port, route, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: route, method, headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject); request.end();
  });
}
test('loopback service rejects foreign hosts/origins, mutations and filesystem routes', async t => {
  const root = fixture(t);
  const server = createServer({ codexHome: root, logRoot: path.join(root, 'logs') }, { worker: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = server.address().port;
    assert.equal(server.address().address, '127.0.0.1');
    const health = await get(port, '/health');
    assert.equal(JSON.parse(health.body).app, 'codex-token-strip');
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.headers['access-control-allow-origin'], undefined);
    assert.equal((await get(port, '/metrics?pid=1', { Host: 'example.com' })).status, 403);
    assert.equal((await get(port, '/metrics?pid=1', { Origin: 'https://example.com' })).status, 403);
    assert.equal((await get(port, '/metrics', {}, 'POST')).status, 403);
    assert.equal((await get(port, '/auth.json')).status, 404);
    assert.equal((await get(port, '/../../settings.json')).status, 404);
    const missing = JSON.parse((await get(port, '/metrics?pid=not-a-pid')).body);
    assert.equal(missing.available, false); assert.equal(missing.binding.status, 'invalid-process');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('service reads synthetic route and usage records end to end', async t => {
  const root = fixture(t), home = path.join(root, 'home'), logs = path.join(root, 'logs');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true }); fs.mkdirSync(logs);
  const id = '00000000-0000-4000-8000-000000000010';
  const stamp = '2026-10-19T00:00:00.000Z';
  fs.writeFileSync(path.join(logs, 'codex-desktop-test-1234-t0-test.log'),
    `${stamp} info [electron-message-handler] IAB_LIFECYCLE received browser sidebar owner sync originWebContentsId=1 ownerRoutePath=/local/${id} windowId=1\n`);
  fs.writeFileSync(path.join(home, 'sessions', `rollout-test-${id}.jsonl`), JSON.stringify({
    timestamp: stamp, type: 'token_usage_record', payload: { response_id: 'synthetic', model: 'gpt-6.1-sol', service_tier: 'default',
      usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 }, thread_token_usage: { input_tokens: 100, output_tokens: 20 } }
  }) + '\n');
  const server = createServer({ codexHome: home, logRoot: logs });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const port = server.address().port;
    let result;
    for (let i = 0; i < 50; i++) {
      result = JSON.parse((await get(port, '/metrics?pid=1234')).body);
      if (result.total.available) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(result.binding.threadId, id); assert.equal(result.tokens, 120);
    assert.equal(result.cacheHit.percent, 80); assert.ok(Math.abs(result.cost.usd - .000248) < 1e-12);
    assert.equal(result.total.available, true); assert.equal(result.total.requests, 1);
    assert.equal(result.total.scope, 'all-local-recorded-sessions-and-archives');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
