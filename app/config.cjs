'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadConfig(env = process.env) {
  const profile = env.USERPROFILE || os.homedir();
  const local = env.LOCALAPPDATA || path.join(profile, 'AppData', 'Local');
  const dataDirectory = path.resolve(env.CODEX_TOKEN_STRIP_DATA_DIR || path.join(local, 'CodexTokenStrip'));
  const file = path.join(dataDirectory, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read Codex Token Strip settings.json: ' + error.message); }
  const port = Number(env.CODEX_TOKEN_STRIP_PORT || (settings.Port ?? 23957));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535');
  const codexHome = path.resolve(settings.CodexHome || env.CODEX_HOME || path.join(profile, '.codex'));
  const logRoot = path.resolve(settings.LogRoot || path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0',
    'LocalCache', 'Local', 'Codex', 'Logs'));
  return { dataDirectory, port, codexHome, logRoot };
}
module.exports = { loadConfig };
