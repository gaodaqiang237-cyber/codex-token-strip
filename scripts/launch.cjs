'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../app/config.cjs');
if (process.platform !== 'win32') throw new Error('The floating strip requires Windows.');
const file = path.resolve(__dirname, '..', 'app', 'overlay', 'TokenStrip.exe');
if (!fs.existsSync(file)) throw new Error('Build the strip first: npm run build');
const stopping = process.argv.includes('--stop');
if (!stopping) {
  const config = loadConfig();
  fs.mkdirSync(config.dataDirectory, { recursive: true });
  const settingsFile = path.join(config.dataDirectory, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  settings.NodePath = process.execPath;
  settings.Port = config.port;
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}
const child = spawn(file, stopping ? ['--stop'] : [], { detached: !stopping, stdio: 'ignore', windowsHide: true });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
if (!stopping) { child.unref(); console.log('Strip started. Open the official Codex window; drag to position, right-click to exit.'); }
else child.once('exit', code => { process.exitCode = code || 0; });
