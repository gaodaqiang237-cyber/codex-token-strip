'use strict';
const prices = require('./pricing.json');

class CostLedger {
  constructor() {
    this.model = null;
    this.tier = null;
    this.pendingSettings = false;
    this.seen = new Set();
    this.byModel = new Map();
    this.pricedTokens = 0;
    this.unpricedRequests = 0;
    this.unpricedModels = new Set();
    this.assumedStandardRequests = 0;
  }

  consume(record) {
    const p = record.payload || {};
    if (record.type === 'event_msg' && p.type === 'task_started') {
      // Some desktop versions persist settings before task_started, others after it.
      if (!this.pendingSettings) {
        this.model = null;
        this.tier = null;
      }
      this.pendingSettings = false;
    }
    if (record.type === 'turn_context') {
      if (p.model) this.model = p.model;
      if (Object.hasOwn(p, 'service_tier')) this.tier = p.service_tier;
    }
    if (record.type === 'event_msg' && p.type === 'thread_settings_applied') {
      const s = p.thread_settings || {};
      if (s.model) this.model = s.model;
      if (Object.hasOwn(s, 'service_tier')) this.tier = s.service_tier;
      this.pendingSettings = true;
    }
    if (record.type !== 'token_usage_record') return;
    this.pendingSettings = false;
    const key = p.response_id || String(record.ordinal ?? `${record.timestamp}:${p.thread_token_usage?.total_tokens}`);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const model = String(p.model || this.model || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    const rate = prices.models[model];
    const rawTier = Object.hasOwn(p, 'service_tier') ? p.service_tier : this.tier;
    const tier = rawTier ?? 'default';
    const multiplier = tier === 'ultrafast' ? rate?.ultrafast : prices.tierMultipliers[tier];
    const u = p.usage || {};
    const input = Number(u.input_tokens);
    const output = Number(u.output_tokens);
    const cached = Number(u.cached_input_tokens ?? 0);
    const write = Number(u.cache_write_input_tokens ?? 0);
    if (!rate || !Number.isFinite(multiplier) || ![input, output, cached, write].every(n => Number.isFinite(n) && n >= 0) || cached + write > input) {
      this.unpricedRequests++;
      this.unpricedModels.add(model || 'unknown');
      return { responseId: p.response_id || null, model, priced: false,
        tokens: Number.isFinite(input) && input >= 0 && Number.isFinite(output) && output >= 0 ? input + output : null };
    }
    if (rawTier == null) this.assumedStandardRequests++;
    const long = input > prices.longContextThreshold;
    const inMultiplier = (long ? prices.longInputMultiplier : 1) * multiplier / 1e6;
    const outMultiplier = (long ? prices.longOutputMultiplier : 1) * multiplier / 1e6;
    // Reasoning is already included in output_tokens; never add it a second time.
    const normalInput = input - cached - write;
    const parts = {
      inputUSD: normalInput * rate.input * inMultiplier,
      cachedInputUSD: cached * rate.cachedInput * inMultiplier,
      cacheWriteUSD: write * rate.cacheWrite * inMultiplier,
      outputUSD: output * rate.output * outMultiplier
    };
    const total = Object.values(parts).reduce((sum, value) => sum + value, 0);
    const row = this.byModel.get(model) || { model, totalUSD: 0, inputUSD: 0, cachedInputUSD: 0, cacheWriteUSD: 0, outputUSD: 0, requests: 0, tokens: 0, tiers: [] };
    row.totalUSD += total;
    for (const [part, value] of Object.entries(parts)) row[part] += value;
    row.requests++;
    row.tokens += input + output;
    if (!row.tiers.includes(tier)) row.tiers.push(tier);
    this.byModel.set(model, row);
    this.pricedTokens += input + output;
    return { responseId: p.response_id || null, model, priced: true, tokens: input + output,
      totalUSD: total, ...parts, assumedStandard: rawTier == null };
  }

  snapshot(totalTokens) {
    const breakdown = [...this.byModel.values()].map(row => ({ ...row, tiers: [...row.tiers] }));
    return {
      usd: breakdown.length ? breakdown.reduce((sum, row) => sum + row.totalUSD, 0) : null,
      complete: breakdown.length > 0 && this.unpricedRequests === 0 && totalTokens === this.pricedTokens,
      pricedTokens: this.pricedTokens,
      unpricedRequests: this.unpricedRequests,
      unpricedModels: [...this.unpricedModels],
      assumedStandardRequests: this.assumedStandardRequests,
      breakdown,
      basis: 'api-equivalent-token-cost',
      checkedOn: prices.checkedOn,
      source: prices.source
    };
  }
}

module.exports = { CostLedger };
