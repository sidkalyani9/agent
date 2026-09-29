import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pythonCommand, backendEnv } from '../../scripts/backend.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export async function startTestApp() {
  const child = spawn(pythonCommand(), ['backend/tests/browser_server.py'], { cwd: root, env: backendEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  const exited = once(child, 'exit');
  const metadata = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Test API did not start.')); }, 20000);
    child.stdout.on('data', bytes => {
      buffer += String(bytes);
      const line = buffer.split('\n').find(line => line.startsWith('PANTRY_TEST_APP '));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(16))); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Test API exited (${code}).`)); });
    child.stderr.on('data', bytes => { if (process.env.PANTRY_TEST_DEBUG) process.stderr.write(bytes); });
  });
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(metadata.base + '/api/health').then(r => r.ok).catch(() => false)) return { ...metadata, close };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Test API health check failed.');
  } catch (error) { await close(); throw error; }
}
