'use strict';
const fs = require('node:fs');
const { CostLedger } = require('./cost.cjs');

class Metrics {
  constructor() {
    this.tokens = null;
    this.input = 0;
    this.output = 0;
    this.cachedInput = 0;
    this.speed = null;
    this.speedAt = null;
    this.updatedAt = null;
    this.boundary = null;
    this.lastResponseId = null;
    this.lastInput = null;
    this.lastCachedInput = null;
    this.cacheAt = null;
    this.contextUsage = { percent: null, usedTokens: null, contextWindow: null, updatedAt: null };
    this.cost = new CostLedger();
  }

  setCache(usage, timestamp) {
    if (!usage) return;
    const input = usage.input_tokens;
    const cached = usage.cached_input_tokens;
    this.lastInput = Number.isFinite(input) && input >= 0 ? input : null;
    this.lastCachedInput = Number.isFinite(cached) && cached >= 0 && cached <= input ? cached : null;
    this.cacheAt = timestamp;
  }

  setContext(info, timestamp) {
    if (!info) return;
    const window = info.model_context_window;
    const usage = info.last_token_usage;
    const total = usage?.total_tokens ?? (usage ? usage.input_tokens + usage.output_tokens : null);
    // Match the installed Codex composer: latest request total / reported window.
    // Cumulative chat tokens are never used as context occupancy.
    if (Number.isFinite(window) && window > 0 && Number.isFinite(total) && total >= 0) {
      const used = Math.min(total, window);
      this.contextUsage = { percent: used / window * 100, usedTokens: used, contextWindow: window, updatedAt: timestamp };
    } else {
      this.contextUsage = { percent: null, usedTokens: null, contextWindow: null, updatedAt: timestamp };
    }
  }

  setTotals(usage, timestamp) {
    if (!usage) return;
    const input = Number(usage.input_tokens);
    const output = Number(usage.output_tokens);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return;
    // Cached input is a subset of input, not a third quantity to add.
    const total = input + output;
    if (this.tokens !== null && total < this.tokens) return;
    this.tokens = total;
    this.input = input;
    this.output = output;
    this.cachedInput = Math.max(0, Number(usage.cached_input_tokens) || 0);
    this.updatedAt = timestamp;
  }

  consume(record) {
    const time = Date.parse(record.timestamp);
    if (!Number.isFinite(time)) return;
    this.cost.consume(record);
    const p = record.payload || {};
    if (record.type === 'event_msg' && p.type === 'task_started') this.boundary = time;
    if (record.type === 'response_item' && (
      p.type === 'custom_tool_call_output' || p.type === 'function_call_output' ||
      (p.type === 'message' && p.role === 'user')
    )) this.boundary = time;

    if (record.type === 'token_usage_record') {
      this.setTotals(p.thread_token_usage, record.timestamp);
      if (p.response_id && p.response_id === this.lastResponseId) return;
      this.setCache(p.usage, record.timestamp);
      const elapsed = this.boundary === null ? 0 : (time - this.boundary) / 1000;
      const output = Number(p.usage?.output_tokens);
      if (elapsed >= 0.25 && Number.isFinite(output) && output >= 0) {
        this.speed = output / elapsed;
        this.speedAt = record.timestamp;
      } else {
        this.speed = null;
        this.speedAt = null;
      }
      this.lastResponseId = p.response_id || null;
      this.boundary = time;
    }
    // A second record for the same request must not double-count its usage.
    if (record.type === 'event_msg' && p.type === 'token_count') {
      this.setTotals(p.info?.total_token_usage, record.timestamp);
      if (p.info?.last_token_usage) this.setCache(p.info.last_token_usage, record.timestamp);
      this.setContext(p.info, record.timestamp);
    }
  }

  snapshot() {
    return {
      tokens: this.tokens, inputTokens: this.input, outputTokens: this.output,
      cachedInputTokens: this.cachedInput, speed: this.speed,
      updatedAt: this.updatedAt, speedAt: this.speedAt,
      speedKind: 'estimated-request-average',
      cacheHit: {
        percent: this.lastInput > 0 && this.lastCachedInput !== null ? this.lastCachedInput / this.lastInput * 100 : null,
        inputTokens: this.lastInput, cachedInputTokens: this.lastCachedInput, updatedAt: this.cacheAt,
        cumulativePercent: this.input > 0 ? this.cachedInput / this.input * 100 : null,
      },
      context: { ...this.contextUsage },
      cost: this.cost.snapshot(this.tokens)
    };
  }
}

class LogTail {
  constructor(file) {
    this.file = file;
    this.reset();
  }
  reset() {
    this.offset = 0;
    this.pending = '';
    this.metrics = new Metrics();
  }
  read() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size < this.offset) this.reset();
      if (stat.size > this.offset) {
        const fd = fs.openSync(this.file, 'r');
        try {
          const chunk = Buffer.alloc(65536);
          while (this.offset < stat.size) {
            const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - this.offset), this.offset);
            if (!count) break;
            this.offset += count;
            // Metric records contain ASCII keys/numbers. Other log content is discarded.
            this.pending += chunk.toString('utf8', 0, count);
            let end;
            while ((end = this.pending.indexOf('\n')) >= 0) {
              const line = this.pending.slice(0, end);
              this.pending = this.pending.slice(end + 1);
              try { this.metrics.consume(JSON.parse(line)); } catch { /* Ignore non-record lines. */ }
            }
          }
        } finally { fs.closeSync(fd); }
      }
      return { available: true, ...this.metrics.snapshot() };
    } catch {
      return { available: false, error: 'log-unavailable', ...this.metrics.snapshot() };
    }
  }
}

module.exports = { Metrics, LogTail };
