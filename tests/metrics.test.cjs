'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Metrics, LogTail } = require('../app/metrics.cjs');
const record = (seconds, type, payload) => ({ timestamp: new Date(seconds * 1000).toISOString(), type, payload });
const usage = (input, output, cached = 0) => ({ input_tokens: input, output_tokens: output, cached_input_tokens: cached });
const { CostLedger } = require('../app/cost.cjs');
const setPriceModel = (ledger, model, tier = 'default') => ledger.consume(record(0, 'event_msg', { type: 'thread_settings_applied', thread_settings: { model, service_tier: tier } }));
const bill = (id, tokens, extra = {}) => record(10, 'token_usage_record', { response_id: id, usage: tokens, ...extra });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('model changes preserve per-request prices and separate cached input from normal input', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'gpt-6.1-sol');
  ledger.consume(bill('a', usage(1000, 100, 900)));
  setPriceModel(ledger, 'gpt-6-astra');
  ledger.consume(bill('b', usage(1000, 100, 900)));
  const result = ledger.snapshot(2200);
  close(result.usd, .00819);
  close(result.breakdown[0].inputUSD, .0002);
  close(result.breakdown[0].cachedInputUSD, .00009);
  close(result.breakdown[0].outputUSD, .001);
  assert.equal(result.complete, true);
  assert.equal(result.breakdown.length, 2);
});

test('long-context and Fast multipliers apply per request, not to the entire chat', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'gpt-6.1-sol', 'fast');
  ledger.consume(record(1, 'turn_context', { model: 'gpt-6.1-sol' }));
  ledger.consume(bill('long', usage(300000, 1000, 200000)));
  close(ledger.snapshot(301000).usd, .91);
  assert.equal(ledger.snapshot(301000).assumedStandardRequests, 0);
});

test('cache writes and reasoning tokens are not billed twice', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'gpt-6.1-sol');
  ledger.consume(bill('writes', { ...usage(1000, 10, 400), cache_write_input_tokens: 100, reasoning_output_tokens: 5 }));
  close(ledger.snapshot(1010).usd, .00139);
});

test('replayed usage records cannot duplicate dollar totals', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'gpt-6.1-sol');
  const first = bill('first', usage(1000, 100, 900));
  ledger.consume(first);
  ledger.consume(bill('second', usage(1000, 100, 900)));
  ledger.consume(first);
  close(ledger.snapshot(2200).usd, .00258);
  assert.equal(ledger.snapshot(2200).complete, true);
});

test('unknown models remain unpriced instead of inheriting another models price', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'new-unpriced-model');
  ledger.consume(bill('unknown', usage(1000, 100)));
  const result = ledger.snapshot(1100);
  assert.equal(result.usd, null);
  assert.equal(result.complete, false);
  assert.equal(result.unpricedRequests, 1);
});

test('unrecorded tiers are disclosed and a new turn does not inherit Fast', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'gpt-6.1-sol', 'fast');
  ledger.consume(bill('previous-turn', usage(1000, 100, 900)));
  ledger.consume(record(1, 'event_msg', { type: 'task_started' }));
  ledger.consume(record(2, 'turn_context', { model: 'gpt-6.1-sol' }));
  ledger.consume(bill('new-turn', usage(1000, 100, 900)));
  close(ledger.snapshot(2200).usd, .00387);
  assert.equal(ledger.snapshot(1100).assumedStandardRequests, 1);
});

test('settings persisted before task_started retain their model and Fast tier', () => {
  const ledger = new CostLedger();
  setPriceModel(ledger, 'gpt-6.1-sol', 'fast');
  ledger.consume(record(1, 'event_msg', { type: 'task_started' }));
  ledger.consume(record(2, 'turn_context', { model: 'gpt-6.1-sol' }));
  ledger.consume(bill('fresh-settings', usage(1000, 100, 900)));
  const result = ledger.snapshot(1100);
  close(result.usd, .00258);
  assert.equal(result.assumedStandardRequests, 0);
});

test('cached input is counted once, and the token_count echo does not duplicate totals', () => {
  const m = new Metrics();
  m.consume(record(0, 'event_msg', { type: 'task_started' }));
  m.consume(record(10, 'token_usage_record', { response_id: 'r1', usage: usage(1000, 100, 900), thread_token_usage: usage(1000, 100, 900) }));
  m.consume(record(11, 'event_msg', { type: 'token_count', info: { total_token_usage: usage(1000, 100, 900) } }));
  assert.equal(m.snapshot().tokens, 1100);
  assert.equal(m.snapshot().speed, 10);
});

test('the next response starts after the tool result, excluding time spent running the tool', () => {
  const m = new Metrics();
  m.consume(record(0, 'event_msg', { type: 'task_started' }));
  m.consume(record(10, 'token_usage_record', { response_id: 'r1', usage: usage(1000, 100), thread_token_usage: usage(1000, 100) }));
  m.consume(record(70, 'response_item', { type: 'custom_tool_call_output' }));
  m.consume(record(80, 'token_usage_record', { response_id: 'r2', usage: usage(1200, 200), thread_token_usage: usage(2200, 300) }));
  assert.equal(m.snapshot().speed, 20);
  assert.equal(m.snapshot().tokens, 2500);
});

test('a new turn resets the timing anchor and duplicate response records preserve speed', () => {
  const m = new Metrics();
  m.consume(record(1, 'event_msg', { type: 'task_started' }));
  m.consume(record(11, 'token_usage_record', { response_id: 'r1', usage: usage(10, 100), thread_token_usage: usage(10, 100) }));
  m.consume(record(1000, 'event_msg', { type: 'task_started' }));
  const next = record(1002, 'token_usage_record', { response_id: 'r2', usage: usage(100, 40), thread_token_usage: usage(110, 140) });
  m.consume(next); m.consume(next);
  assert.equal(m.snapshot().speed, 20);
});

test('older log formats do not fabricate a generation speed', () => {
  const m = new Metrics();
  m.consume(record(20, 'event_msg', { type: 'token_count', info: { total_token_usage: usage(100, 20, 80) } }));
  assert.equal(m.snapshot().tokens, 120);
  assert.equal(m.snapshot().speed, null);
});

test('cache hit rate uses latest cached input divided by latest input, excluding output', () => {
  const m = new Metrics();
  m.consume(record(1, 'token_usage_record', { response_id: 'c1', usage: usage(1000, 500, 900), thread_token_usage: usage(1000, 500, 900) }));
  m.consume(record(2, 'token_usage_record', { response_id: 'c2', usage: usage(100, 500, 20), thread_token_usage: usage(1100, 1000, 920) }));
  assert.equal(m.snapshot().cacheHit.percent, 20);
  close(m.snapshot().cacheHit.cumulativePercent, 920 / 1100 * 100);
  m.consume(record(3, 'token_usage_record', { response_id: 'c3', usage: { input_tokens: 100, output_tokens: 20 } }));
  assert.equal(m.snapshot().cacheHit.percent, null);
});

test('context occupancy uses the reported current window and latest request, not cumulative tokens', () => {
  const m = new Metrics();
  m.consume(record(1, 'event_msg', { type: 'token_count', info: {
    total_token_usage: usage(10000000, 100000),
    last_token_usage: { ...usage(90000, 10000, 45000), total_tokens: 100000 },
    model_context_window: 400000,
  } }));
  assert.equal(m.snapshot().context.percent, 25);
  assert.equal(m.snapshot().context.usedTokens, 100000);
  assert.equal(m.snapshot().cacheHit.percent, 50);
  m.consume(record(2, 'event_msg', { type: 'token_count', info: {
    total_token_usage: usage(10100000, 110000),
    last_token_usage: usage(20000, 1000), model_context_window: 400000,
  } }));
  assert.equal(m.snapshot().context.percent, 5.25);
  m.consume(record(3, 'event_msg', { type: 'token_count', info: {
    total_token_usage: usage(10200000, 120000), last_token_usage: usage(20000, 1000),
  } }));
  assert.equal(m.snapshot().context.percent, null);
});

test('tailing handles partial records, no-change polls, and log truncation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-meter-test-'));
  const file = path.join(directory, 'fixture.jsonl');
  try {
    const first = JSON.stringify(record(1, 'event_msg', { type: 'token_count', info: { total_token_usage: usage(10, 2) } }));
    fs.writeFileSync(file, first.slice(0, 40));
    const tail = new LogTail(file);
    assert.equal(tail.read().tokens, null);
    fs.appendFileSync(file, first.slice(40) + '\n');
    assert.equal(tail.read().tokens, 12);
    assert.equal(tail.read().tokens, 12);
    fs.writeFileSync(file, '\n');
    assert.equal(tail.read().tokens, null);
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
