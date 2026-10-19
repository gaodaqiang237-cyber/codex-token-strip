'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CostLedger } = require('./cost.cjs');
const UUID = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;

function listLogs(roots) {
  const files = [];
  files.errors = 0; files.existingRoots = 0;
  function walk(directory, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') files.errors++; return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && UUID.test(entry.name)) {
        try { const stat = fs.statSync(file); files.push({ file, id: UUID.exec(entry.name)[1].toLowerCase(), size: stat.size, mtime: stat.mtimeMs }); } catch { files.errors++; }
      }
    }
  }
  for (const root of roots) {
    try { if (fs.statSync(root).isDirectory()) { files.existingRoots++; walk(root, 0); } }
    catch (error) { if (error.code !== 'ENOENT') files.errors++; }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

class TotalCost {
  constructor(roots) { this.roots = roots; this.reset(); }
  reset() { this.files = new Map(); this.requests = new Map(); this.errors = 0; }
  request(entry) {
    if (!entry.responseId) return;
    const previous = this.requests.get(entry.responseId);
    if (!previous || (!previous.priced && entry.priced && !previous.conflict)) this.requests.set(entry.responseId, entry);
    else if (previous.priced && entry.priced && Math.abs(previous.totalUSD - entry.totalUSD) > 1e-9)
      this.requests.set(entry.responseId, { responseId: entry.responseId, priced: false, conflict: true, tokens: entry.tokens });
  }
  consume(state, record) {
    const payload = record.payload || {};
    if (record.type === 'token_usage_record') {
      const totals = payload.thread_token_usage;
      if (totals) state.reported = Math.max(state.reported, Number(totals.input_tokens || 0) + Number(totals.output_tokens || 0));
    } else if (record.type === 'event_msg' && payload.type === 'token_count') {
      const totals = payload.info?.total_token_usage;
      if (totals) state.reported = Math.max(state.reported, Number(totals.input_tokens || 0) + Number(totals.output_tokens || 0));
    }
    const entry = state.ledger.consume(record);
    if (!entry) return;
    if (entry.tokens != null) state.recordedTokens += entry.tokens;
    if (!entry.responseId) state.unidentified++;
    else this.request(entry);
  }
  update() {
    const listing = listLogs(this.roots);
    const live = new Set(listing.map(x => x.file));
    // A truncate, replacement, removal or rename requires rebuilding cross-file deduplication.
    if ([...this.files].some(([file, state]) => !live.has(file) || listing.some(x => x.file === file &&
      (x.size < state.offset || x.size === state.offset && x.mtime !== state.mtime)))) this.reset();
    this.errors = listing.errors;
    for (const info of listing) {
      let state = this.files.get(info.file);
      if (!state) {
        state = { id: info.id, offset: 0, pending: '', ledger: new CostLedger(), recordedTokens: 0, reported: 0, unidentified: 0, malformed: 0, mtime: info.mtime };
        this.files.set(info.file, state);
      }
      if (info.size === state.offset) continue;
      try {
        const fd = fs.openSync(info.file, 'r');
        try {
          const bytes = Buffer.alloc(65536);
          while (state.offset < info.size) {
            const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, info.size - state.offset), state.offset);
            if (!count) break;
            state.offset += count; state.pending += bytes.toString('utf8', 0, count);
            let end;
            while ((end = state.pending.indexOf('\n')) >= 0) {
              const line = state.pending.slice(0, end); state.pending = state.pending.slice(end + 1);
              // Skip bodies before parsing. Only accounting/settings records are retained.
              if (!/"(?:token_usage_record|turn_context|task_started|thread_settings_applied|token_count)"/.test(line)) continue;
              try { this.consume(state, JSON.parse(line)); } catch { state.malformed++; }
            }
          }
        } finally { fs.closeSync(fd); }
        state.mtime = info.mtime;
      } catch { this.errors++; }
    }
    const entries = [...this.requests.values()];
    const priced = entries.filter(x => x.priced);
    const unknownRequests = entries.length - priced.length;
    const incompleteSessions = [...this.files.values()].filter(x => x.unidentified || x.malformed || x.reported > x.recordedTokens).length;
    const usd = priced.length ? priced.reduce((sum, x) => sum + x.totalUSD, 0) : entries.length || incompleteSessions || this.errors || !listing.existingRoots ? null : 0;
    return { available: listing.existingRoots > 0, usd, complete: listing.existingRoots > 0 && unknownRequests === 0 && incompleteSessions === 0 && this.errors === 0,
      sessions: new Set(listing.map(x => x.id)).size, requests: entries.length, pricedRequests: priced.length,
      unpricedRequests: unknownRequests, incompleteSessions, unreadableFiles: this.errors,
      unpricedModels: [...new Set(entries.filter(x => !x.priced).map(x => x.model || 'unknown'))],
      tokens: entries.reduce((sum, x) => sum + (x.tokens || 0), 0),
      scope: 'all-local-recorded-sessions-and-archives', basis: 'api-equivalent-token-cost',
      updatedAt: new Date().toISOString(), deduplication: 'response-id-across-all-session-files' };
  }
}
module.exports = { TotalCost, listLogs };
