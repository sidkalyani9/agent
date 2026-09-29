import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pythonCommand, backendEnv } from './backend.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'frontend', 'package.json'));
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const children = [
  spawn(pythonCommand(), ['-m', 'pantry', '--reload'], { cwd: root, stdio: 'inherit', env: backendEnv() }),
  spawn(process.execPath, [vite], { cwd: path.join(root, 'frontend'), stdio: 'inherit', env: backendEnv() }),
];
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children) {
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code ?? 1; stop(); } });
}
