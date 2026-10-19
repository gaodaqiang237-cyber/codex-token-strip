'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Worker } = require('node:worker_threads');
const { loadConfig } = require('./config.cjs');
const { NavigationTracker } = require('./navigation.cjs');
const { SessionReader } = require('./session-reader.cjs');

function createServer(config, options = {}) {
  const reader = new SessionReader([path.join(config.codexHome, 'sessions'), path.join(config.codexHome, 'archived_sessions')]);
  const navigation = new NavigationTracker(config.logRoot);
  let total = { available: false, error: 'calculating', usd: null };
  let worker, retry, idle;
  let closing = false, lastVisit = Date.now();
  function startWorker() {
    if (closing) return;
    const active = new Worker(path.join(__dirname, 'total-worker.cjs'), { workerData: { home: config.codexHome } });
    worker = active;
    active.on('message', value => { if (worker === active) total = value; });
    active.on('error', () => { if (worker === active) total = { available: false, error: 'total-unavailable', usd: null }; });
    active.on('exit', () => {
      if (worker !== active || closing) return;
      worker = null;
      retry = setTimeout(startWorker, 5000); retry.unref();
    });
  }
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== origin.slice(7) || req.method !== 'GET' ||
        req.headers.origin && req.headers.origin !== origin) {
      res.writeHead(403); res.end(); return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, origin); } catch { res.writeHead(400); res.end(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ app: 'codex-token-strip', version: 1, pid: process.pid }));
    } else if (url.pathname === '/metrics') {
      lastVisit = Date.now();
      const binding = navigation.read(Number(url.searchParams.get('pid')));
      res.end(JSON.stringify({ ...reader.readBinding(binding), binding, total }));
    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: 'not-found' }));
    }
  });
  const close = server.close.bind(server);
  server.close = function (callback) {
    closing = true; clearTimeout(retry); clearInterval(idle);
    if (worker) { const active = worker; worker = null; active.terminate(); }
    return close(callback);
  };
  server.once('listening', () => {
    if (options.worker !== false) startWorker();
    idle = setInterval(() => { if (Date.now() - lastVisit > 15 * 60 * 1000) server.close(); }, 60000);
    idle.unref();
  });
  return server;
}

if (require.main === module) {
  try {
    const config = loadConfig();
    fs.mkdirSync(config.dataDirectory, { recursive: true });
    const server = createServer(config);
    server.once('error', error => {
      console.error(error.code === 'EADDRINUSE' ? 'Local port is already in use. Check settings.json Port.' : error.message);
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () => {
      fs.writeFileSync(path.join(config.dataDirectory, 'backend.json'), JSON.stringify({
        pid: process.pid, url: `http://127.0.0.1:${config.port}/`, startedAt: new Date().toISOString()
      }));
      console.log('Codex Token Strip backend ready on 127.0.0.1:' + config.port);
    });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { createServer };
