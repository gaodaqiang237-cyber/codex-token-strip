'use strict';
const path = require('node:path');
const os = require('node:os');
const { parentPort, workerData } = require('node:worker_threads');
const { TotalCost } = require('./total-cost.cjs');
const home = workerData?.home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const ledger = new TotalCost([path.join(home, 'sessions'), path.join(home, 'archived_sessions')]);
function update() {
  try { parentPort.postMessage(ledger.update()); }
  catch { parentPort.postMessage({ available: false, error: 'total-unavailable' }); }
}
update();
setInterval(update, 2000);
