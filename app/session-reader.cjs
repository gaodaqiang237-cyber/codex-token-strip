'use strict';
const { LogTail } = require('./metrics.cjs');
const { listLogs } = require('./total-cost.cjs');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
class SessionReader {
  constructor(roots) { this.roots = roots; this.readers = new Map(); this.index = new Map(); this.scanAt = 0; }
  readBinding(binding) {
    if (binding.status !== 'local-chat') return { available: false,
      error: binding.status === 'cloud-chat' ? 'cloud-usage-unavailable' : binding.status };
    return this.read(binding.threadId);
  }
  read(id) {
    if (!UUID.test(id || '')) return { available: false, error: 'invalid-thread' };
    if (Date.now() - this.scanAt > 3000) {
      this.scanAt = Date.now(); this.index.clear();
      for (const entry of listLogs(this.roots)) {
        const previous = this.index.get(entry.id);
        if (!previous || entry.size > previous.size || entry.size === previous.size && entry.mtime > previous.mtime) this.index.set(entry.id, entry);
      }
    }
    const entry = this.index.get(id);
    if (!entry) return { available: false, error: 'log-unavailable' };
    let reader = this.readers.get(id);
    if (!reader || reader.file !== entry.file) reader = new LogTail(entry.file);
    this.readers.delete(id); this.readers.set(id, reader);
    while (this.readers.size > 4) this.readers.delete(this.readers.keys().next().value);
    return reader.read();
  }
}
module.exports = { SessionReader };
