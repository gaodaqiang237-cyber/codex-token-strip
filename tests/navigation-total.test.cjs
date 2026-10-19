'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { NavigationTail, NavigationTracker, parseNavigation } = require('../app/navigation.cjs');
const { TotalCost } = require('../app/total-cost.cjs');
const { SessionReader } = require('../app/session-reader.cjs');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const stamp = '2026-10-19T20:00:00.000Z';
function nav(route, window = 1, origin = 1) {
  return `${stamp} info [electron-message-handler] IAB_LIFECYCLE received browser sidebar owner sync browserTabId=null conversationId=client-new-thread:wrong originWebContentsId=${origin} ownerRoutePath=${route} windowId=${window}\n`;
}
function fixture(run) {
  const base = path.resolve(__dirname, 'auto-token-fixtures');
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, 'case-'));
  try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
function usage(response, model = 'gpt-6.1-sol', input = 100, output = 20) {
  return { timestamp: stamp, type: 'token_usage_record', payload: {
    response_id: response, model, service_tier: 'default',
    usage: { input_tokens: input, output_tokens: output, cached_input_tokens: 80 },
    thread_token_usage: { input_tokens: input, output_tokens: output },
  } };
}
function writeLog(directory, id, records) {
  const file = path.join(directory, `rollout-2026-10-19T00-00-00-${id}.jsonl`);
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n'); return file;
}

test('active conversation comes from owner route, never draft id or background task activity', () => {
  assert.equal(parseNavigation(nav(`/local/${A}`)).threadId, A);
  assert.equal(parseNavigation(`${stamp} info Reasoning summary ${nav(`/local/${B}`)}`), null);
  assert.equal(parseNavigation('not a real event ' + nav(`/local/${B}`)), null);
});
test('chat changes, home and unsupported cloud routes immediately replace prior binding', () => fixture(directory => {
  const file = path.join(directory, 'navigation.log'); fs.writeFileSync(file, nav(`/local/${A}`));
  const tail = new NavigationTail(file); assert.equal(tail.read().threadId, A);
  fs.appendFileSync(file, `${stamp} info [electron-message-handler] Background task threadId=${A}\n` + nav(`/local/${B}`));
  assert.equal(tail.read().threadId, B);
  fs.appendFileSync(file, nav('/')); assert.equal(tail.read().status, 'no-chat');
  fs.appendFileSync(file, nav(`/c/${A}`)); assert.equal(tail.read().status, 'cloud-chat');
  assert.equal(tail.read().threadId, A);
}));
test('auxiliary and ambiguous windows cannot silently pick the wrong current chat', () => fixture(directory => {
  const file = path.join(directory, 'navigation.log');
  fs.writeFileSync(file, nav(`/local/${A}`) + nav(`/local/${B}`, 2, 7) +
    `${stamp} info [electron-message-handler] IAB_LIFECYCLE ignored browser sidebar owner sync from auxiliary window originWebContentsId=7 windowId=2\n`);
  assert.equal(new NavigationTail(file).read().threadId, A);
  fs.writeFileSync(file, nav(`/local/${A}`) + nav(`/local/${B}`, 2, 8));
  assert.equal(new NavigationTail(file).read().status, 'ambiguous-window');
}));
test('partial navigation records and truncation do not leave stale bindings', () => fixture(directory => {
  const file = path.join(directory, 'navigation.log'); const line = nav(`/local/${A}`);
  fs.writeFileSync(file, line.slice(0, 50)); const tail = new NavigationTail(file);
  assert.equal(tail.read().threadId, null);
  fs.appendFileSync(file, line.slice(50)); assert.equal(tail.read().threadId, A);
  fs.writeFileSync(file, nav('/')); assert.equal(tail.read().threadId, null);
}));
test('navigation tracking is pinned to the foreground Codex process and follows log rotation', () => fixture(directory => {
  fs.writeFileSync(path.join(directory, 'codex-desktop-test-42-t0-i1-000000-0.log'), nav(`/local/${A}`));
  fs.writeFileSync(path.join(directory, 'codex-desktop-other-142-t0-i1-000000-0.log'), nav(`/local/${B}`));
  const tracker = new NavigationTracker(directory); assert.equal(tracker.read(42).threadId, A);
  assert.equal(tracker.read(-1).status, 'invalid-process');
  fs.appendFileSync(path.join(directory, 'codex-desktop-test-42-t0-i1-000000-0.log'), nav(`/local/${B}`));
  assert.equal(tracker.read(42).threadId, B);
  fs.writeFileSync(path.join(directory, 'codex-desktop-test-42-t0-i1-000001-1.log'), nav(`/local/${A}`).replace(stamp, '2026-10-19T20:00:01.000Z'));
  tracker.scanAt = 0; assert.equal(tracker.read(42).threadId, A);
}));
test('all-session total deduplicates copied requests across forks and archives', () => fixture(directory => {
  const sessions = path.join(directory, 'sessions'), archives = path.join(directory, 'archives');
  fs.mkdirSync(sessions); fs.mkdirSync(archives);
  writeLog(sessions, A, [usage('shared')]); writeLog(archives, B, [usage('shared')]);
  const total = new TotalCost([sessions, archives]).update();
  assert.equal(total.sessions, 2); assert.equal(total.requests, 1); assert.equal(total.complete, true);
  assert.ok(Math.abs(total.usd - .000248) < 1e-12);
}));
test('total updates incrementally and rebuilds after a session file is removed', () => fixture(directory => {
  const file = writeLog(directory, A, [usage('first')]); const ledger = new TotalCost([directory]);
  const first = ledger.update().usd;
  const second = usage('second'); second.payload.thread_token_usage = { input_tokens: 200, output_tokens: 40 };
  fs.appendFileSync(file, JSON.stringify(second) + '\n');
  assert.ok(Math.abs(ledger.update().usd - first * 2) < 1e-12);
  assert.equal(ledger.update().requests, 2);
  fs.unlinkSync(file); assert.equal(ledger.update().usd, 0);
}));
test('unknown prices, legacy usage and unidentified requests are not treated as free', () => fixture(directory => {
  const file = writeLog(directory, A, [usage('known'), usage('unknown', 'unlisted-model')]);
  let summary = new TotalCost([directory]).update(); assert.equal(summary.complete, false); assert.equal(summary.unpricedRequests, 1);
  assert.deepEqual(summary.unpricedModels, ['unlisted-model']);
  fs.writeFileSync(file, JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, output_tokens: 20 } } } }) + '\n');
  summary = new TotalCost([directory]).update(); assert.equal(summary.usd, null); assert.equal(summary.incompleteSessions, 1);
  const missing = usage(null); fs.writeFileSync(file, JSON.stringify(missing) + '\n');
  summary = new TotalCost([directory]).update(); assert.equal(summary.usd, null); assert.equal(summary.complete, false);
}));
test('automatic reader can switch session files without using modification time as identity', () => fixture(directory => {
  writeLog(directory, A, [usage('first', 'gpt-6.1-sol', 100, 20)]);
  writeLog(directory, B, [usage('second', 'gpt-6.1-sol', 200, 40)]);
  const reader = new SessionReader([directory]);
  assert.equal(reader.read(A).tokens, 120); assert.equal(reader.read(B).tokens, 240);
  assert.equal(reader.read(A).tokens, 120); assert.equal(reader.read('../../auth.json').available, false);
  assert.equal(reader.readBinding({ status: 'cloud-chat', threadId: A }).error, 'cloud-usage-unavailable');
  assert.equal(reader.readBinding({ status: 'local-chat', threadId: A }).tokens, 120);
}));

test('cloud and project cloud routes preserve identity without pretending local usage exists', () => {
  for (const route of [`/c/${A}`, `/g/project-slug/c/${A}`]) {
    const binding = parseNavigation(nav(route)); assert.equal(binding.threadId, A); assert.equal(binding.status, 'cloud-chat');
  }
});
test('malformed accounting records and missing stores cannot produce a complete zero total', () => fixture(directory => {
  const file = writeLog(directory, A, []); fs.writeFileSync(file, '{"type":"token_usage_record",INVALID}\n');
  const broken = new TotalCost([directory]).update(); assert.equal(broken.complete, false); assert.equal(broken.usd, null);
  const missing = new TotalCost([path.join(directory, 'missing')]).update(); assert.equal(missing.available, false); assert.equal(missing.complete, false);
}));
