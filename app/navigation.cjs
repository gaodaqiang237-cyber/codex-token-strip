'use strict';
const fs = require('node:fs');
const path = require('node:path');
const UUID_SOURCE = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const LOCAL = new RegExp(`^/(?:local|threads)/(${UUID_SOURCE})(?:[/?#].*)?$`, 'i');
const CLOUD = new RegExp(`^/(?:c|g/[^/]+/c)/(${UUID_SOURCE})(?:[/?#].*)?$`, 'i');
const PREFIX = /^\d{4}-\d{2}-\d{2}T\S+ info \[electron-message-handler\] /;
const EVENT = 'IAB_LIFECYCLE received browser sidebar owner sync ';

function parseNavigation(line) {
  line = line.trimEnd();
  const header = PREFIX.exec(line);
  if (!header || !line.slice(header[0].length).startsWith(EVENT)) return null;
  const fields = line.slice(header[0].length + EVENT.length);
  const windowId = /(?:^| )windowId=(\d+)(?: |$)/.exec(fields)?.[1];
  const originId = /(?:^| )originWebContentsId=(\d+)(?: |$)/.exec(fields)?.[1];
  const route = /(?:^| )ownerRoutePath=(\S+)/.exec(fields)?.[1];
  if (!windowId || !originId || !route) return null;
  const localId = LOCAL.exec(route)?.[1]?.toLowerCase();
  const cloudId = CLOUD.exec(route)?.[1]?.toLowerCase();
  const threadId = localId || cloudId || null;
  return { windowId: Number(windowId), originId: Number(originId), threadId,
    status: localId ? 'local-chat' : cloudId ? 'cloud-chat' : route === '/' ? 'no-chat' : 'unsupported-chat',
    observedAt: line.slice(0, 24) };
}

class NavigationTail {
  constructor(file) { this.file = file; this.reset(); }
  reset() { this.offset = 0; this.pending = ''; this.windows = new Map(); this.auxiliary = new Set(); this.primary = new Set(); }
  consume(line) {
    if (!PREFIX.test(line)) return;
    if (line.slice(PREFIX.exec(line)[0].length).startsWith('IAB_LIFECYCLE ignored browser sidebar owner sync from auxiliary window')) {
      const id = /(?:^| )windowId=(\d+)(?: |$)/.exec(line)?.[1];
      if (id) { this.auxiliary.add(Number(id)); this.windows.delete(Number(id)); }
      return;
    }
    if (/\brendererWindowAppearance=primary\b/.test(line)) {
      const id = /\brendererWindowId=(\d+)\b/.exec(line)?.[1];
      if (id) this.primary.add(Number(id));
    }
    const event = parseNavigation(line);
    if (event && !this.auxiliary.has(event.windowId)) this.windows.set(event.windowId, event);
  }
  read() {
    try {
      const stat = fs.statSync(this.file);
      if (stat.size < this.offset) this.reset();
      const fd = fs.openSync(this.file, 'r');
      try {
        const bytes = Buffer.alloc(65536);
        while (this.offset < stat.size) {
          const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, stat.size - this.offset), this.offset);
          if (!count) break;
          this.offset += count; this.pending += bytes.toString('utf8', 0, count);
          let end;
          while ((end = this.pending.indexOf('\n')) >= 0) {
            this.consume(this.pending.slice(0, end)); this.pending = this.pending.slice(end + 1);
          }
          // Navigation records are short; never retain long message/summary bodies.
          if (this.pending.length > 65536) this.pending = this.pending.slice(-4096);
        }
      } finally { fs.closeSync(fd); }
      const candidates = [...this.windows.values()].filter(x => !this.auxiliary.has(x.windowId) &&
        (!this.primary.size || this.primary.has(x.windowId)));
      if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous-window' : 'unknown', threadId: null };
      return { ...candidates[0], source: 'desktop-owner-route-log' };
    } catch { return { status: 'log-unavailable', threadId: null }; }
  }
}

class NavigationTracker {
  constructor(root) { this.root = root; this.cache = new Map(); this.scanAt = 0; this.files = []; }
  scan(now = Date.now()) {
    if (now - this.scanAt < 2000) return;
    this.scanAt = now;
    const files = [];
    function walk(directory, depth) {
      if (depth > 4) return;
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (/-\d+-t0-.*\.log$/.test(entry.name)) {
          try { files.push({ file, name: entry.name, mtime: fs.statSync(file).mtimeMs }); } catch {}
        }
      }
    }
    walk(this.root, 0); this.files = files;
  }
  read(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'invalid-process', threadId: null };
    this.scan();
    const match = new RegExp(`-${pid}-t0-`);
    const files = this.files.filter(x => match.test(x.name)).sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    if (!files.length) return { status: 'log-unavailable', threadId: null };
    // Combine rotations from this same process, retaining the latest route per window.
    const windows = new Map(), auxiliary = new Set(), primary = new Set();
    for (const info of files) {
      if (!this.cache.has(info.file)) this.cache.set(info.file, new NavigationTail(info.file));
      const tail = this.cache.get(info.file); tail.read();
      for (const id of tail.auxiliary) auxiliary.add(id);
      for (const id of tail.primary) primary.add(id);
      for (const [id, event] of tail.windows) {
        if (!windows.has(id) || windows.get(id).observedAt <= event.observedAt) windows.set(id, event);
      }
    }
    const candidates = [...windows.values()].filter(x => !auxiliary.has(x.windowId) && (!primary.size || primary.has(x.windowId)));
    if (candidates.length !== 1) return { status: candidates.length ? 'ambiguous-window' : 'unknown', threadId: null };
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return { ...candidates[0], pid, source: 'desktop-owner-route-log' };
  }
}
module.exports = { NavigationTail, NavigationTracker, parseNavigation };
