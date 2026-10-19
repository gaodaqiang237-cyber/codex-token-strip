'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32') throw new Error('The native strip must be built on Windows. Core tests also run on Linux.');
const root = path.resolve(__dirname, '..');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(compiler)) throw new Error('.NET Framework 4.x C# compiler not found: ' + compiler);
const result = spawnSync(compiler, ['-nologo', '-target:winexe', '-platform:x64', '-optimize+', '-utf8output',
  '-r:System.Windows.Forms.dll', '-r:System.Drawing.dll', '-r:System.Web.Extensions.dll',
  '-out:TokenStrip.exe', 'TokenStrip.cs'], { cwd: path.join(root, 'app', 'overlay'), stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status) process.exit(result.status);
console.log('Built app/overlay/TokenStrip.exe');
