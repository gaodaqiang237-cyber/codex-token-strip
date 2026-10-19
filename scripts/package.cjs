'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const name = `codex-token-strip-${version}-windows-x64`;
// Explicit allowlist: runtime state and local Codex logs can never enter a release.
const files = ['LICENSE', 'README.md', 'README.en.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'docs/preview.png', 'settings.example.json',
  'scripts/launch.cjs', 'app/config.cjs', 'app/server.cjs', 'app/cost.cjs', 'app/metrics.cjs',
  'app/navigation.cjs', 'app/session-reader.cjs', 'app/total-cost.cjs', 'app/total-worker.cjs',
  'app/pricing.json', 'app/overlay/TokenStrip.exe'];
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
const output = [], entries = [];
let offset = 0;
for (const file of files) {
  const data = fs.readFileSync(path.join(root, file));
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const filename = Buffer.from(name + '/' + file);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  output.push(local, filename, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(offset, 42); entries.push(central, filename);
  offset += local.length + filename.length + compressed.length;
}
const directory = Buffer.concat(entries), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...output, directory, end]);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', name + '.zip'), zip);
fs.writeFileSync(path.join(root, 'dist', 'SHA256SUMS.txt'), crypto.createHash('sha256').update(zip).digest('hex') + '  ' + name + '.zip\n');
console.log(`Packaged ${files.length} files; ${zip.length} bytes: dist/${name}.zip`);
